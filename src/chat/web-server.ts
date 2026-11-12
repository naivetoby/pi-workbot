// @env node
import { isIP } from 'node:net'
import { join } from 'node:path'
import { withShutdown } from '../runtime/process.ts'
import { ROOT } from '../runtime/paths.ts'

/** Caddy owns the public port; neither Next nor ttyd is exposed directly.
 * Preserve the outer HTTPS proxy's scheme, as direct pi-web does, so login
 * cookies retain Secure rather than reflecting this internal HTTP hop.
 */
export function terminalProxyConfig(
  host: string,
  port: number,
  webPort: number,
  ttyPort: number,
): string {
  if (host !== 'localhost' && !isIP(host)) throw new Error('Web 监听地址必须是 IP 或 localhost')
  if (
    [port, webPort, ttyPort].some((value) => !Number.isInteger(value) || value < 1 || value > 65535)
  )
    throw new Error('无效的 Web 端口')
  return `{
  admin off
  auto_https off
}
http://:${port} {
  bind ${host}
  handle /tui/* {
    forward_auth 127.0.0.1:${webPort} {
      uri /api/workbot-terminal/auth
      header_up X-Forwarded-Proto {http.request.header.X-Forwarded-Proto}
      header_up -Upgrade
      header_up -Connection
    }
    header Cache-Control "no-store"
    reverse_proxy 127.0.0.1:${ttyPort} {
      header_up -Cookie
      header_up -Authorization
    }
  }
  handle {
    reverse_proxy 127.0.0.1:${webPort} {
      header_up X-Forwarded-Proto {http.request.header.X-Forwarded-Proto}
    }
  }
}
`
}

function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port!
  probe.stop(true)
  return port
}

export async function serveWeb(): Promise<void> {
  if (!process.env.PI_WEB_PASSWORD?.trim()) throw new Error('开启 TUI 必须设置 PI_WEB_PASSWORD')
  const webPort = freePort()
  let ttyPort = freePort()
  while (ttyPort === webPort) ttyPort = freePort()
  const configPath = join(process.env.PI_CODING_AGENT_DIR!, '../web.Caddyfile')
  await Bun.write(
    configPath,
    terminalProxyConfig(
      process.env.PI_WEB_HOSTNAME || '127.0.0.1',
      Number(process.env.PORT || 30141),
      webPort,
      ttyPort,
    ),
  )
  const children: ReturnType<typeof Bun.spawn>[] = []
  try {
    await withShutdown(async (signal) => {
      children.push(
        Bun.spawn(
          [
            process.execPath,
            join(process.cwd(), 'node_modules/next/dist/bin/next'),
            'start',
            '-H',
            '127.0.0.1',
            '-p',
            String(webPort),
          ],
          { stdout: 'inherit', stderr: 'inherit' },
        ),
      )
      // Browser credentials never reach the terminal or its attach command.
      const { PI_WEB_PASSWORD: _password, ...terminalEnv } = process.env
      children.push(
        Bun.spawn(
          [
            'ttyd',
            '-i',
            '127.0.0.1',
            '-p',
            String(ttyPort),
            '-b',
            '/tui',
            '-W',
            '-a',
            '-I',
            join(ROOT, '.cache/ttyd/index.html'),
            join(ROOT, 'bin/workbot-tui-attach'),
          ],
          { env: terminalEnv, stdout: 'inherit', stderr: 'inherit' },
        ),
      )
      children.push(
        Bun.spawn(['caddy', 'run', '--config', configPath, '--adapter', 'caddyfile'], {
          stdout: 'inherit',
          stderr: 'inherit',
        }),
      )
      await Promise.race([
        ...children.map(async (child) =>
          Promise.reject(new Error(`Web 子服务退出：${await child.exited}`)),
        ),
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
    })
  } finally {
    for (const child of children) child.kill('SIGTERM')
    await Promise.all(children.map((child) => child.exited))
    // tmux is intentionally not killed: stopping the web transport is a detach.
  }
}

if (import.meta.main) await serveWeb()
