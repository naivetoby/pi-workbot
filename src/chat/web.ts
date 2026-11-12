// @env node
import { spawn } from 'node:child_process'
import { mkdir, open, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ROOT, WEB_DIR } from '../runtime/paths.ts'
import type { Runtime } from '../runtime/types.ts'

function pidFile(config: Runtime): string {
  return resolve(config.piDir, '../web.pid')
}

export async function webPid(config: Runtime): Promise<number | undefined> {
  const file = Bun.file(pidFile(config))
  if (!(await file.exists())) return undefined
  const pid = Number(await file.text())
  if (!Number.isInteger(pid) || pid < 1) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}

export async function startWeb(config: Runtime): Promise<string> {
  if (config.role !== 'chat') throw new Error('Web 只在 chat 中运行')
  const existing = await webPid(config)
  if (existing) return `Web 已运行，PID ${existing}`
  const cwd = resolve(process.env.WORKBOT_WEB_DIR || WEB_DIR)
  if (!(await Bun.file(join(cwd, '.next/BUILD_ID')).exists()))
    throw new Error('尚未构建 pi-web，请先执行 bun run build:web')
  const tui = process.env.WORKBOT_TUI_ENABLED === '1'
  if (tui && !process.env.PI_WEB_PASSWORD?.trim())
    throw new Error('开启 TUI 必须设置 PI_WEB_PASSWORD')
  if (tui) {
    for (const binary of ['ttyd', 'tmux', 'caddy'])
      if (!Bun.which(binary)) throw new Error(`缺少 ${binary}，请安装独立终端依赖`)
    if (!(await Bun.file(join(ROOT, '.cache/ttyd/index.html')).exists()))
      throw new Error('请先执行 bun run prepare:tui')
  }
  const state = resolve(config.piDir, '..')
  await mkdir(state, { recursive: true })
  const logPath = join(state, 'web.log')
  const log = await open(logPath, 'a')
  try {
    const child = spawn(
      process.execPath,
      tui
        ? [join(ROOT, 'src/chat/web-server.ts')]
        : [
            join(cwd, 'node_modules/next/dist/bin/next'),
            'start',
            '-H',
            process.env.PI_WEB_HOSTNAME || '127.0.0.1',
            '-p',
            process.env.PORT || '30141',
          ],
      {
        cwd,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: config.piDir,
          PI_WEB_DEFAULT_CWD: config.workspace,
          PI_CHANNELS_DISABLE_SESSION_AUTOSTART: '1',
          WORKBOT_TMUX_SOCKET: join(state, 'tui.sock'),
          WORKBOT_TMUX_CONFIG: join(ROOT, 'configs/tmux.conf'),
          WORKBOT_TUI_LAUNCHER: join(ROOT, 'src/chat/tui-launch.ts'),
        },
      },
    )
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    await Bun.write(pidFile(config), String(child.pid))
    child.unref()
    return `Web 进程已启动，PID ${child.pid}；日志 ${logPath}`
  } finally {
    await log.close()
  }
}

export async function stopWeb(config: Runtime): Promise<string> {
  const pid = await webPid(config)
  if (pid) {
    try {
      process.kill(-pid, 'SIGTERM')
      const deadline = Date.now() + 5_000
      while ((await webPid(config)) && Date.now() < deadline) await Bun.sleep(100)
      if (await webPid(config)) process.kill(-pid, 'SIGKILL')
    } catch {
      // 进程可能已在状态查询后退出。
    }
  }
  await rm(pidFile(config), { force: true })
  return 'Web 已停止'
}
