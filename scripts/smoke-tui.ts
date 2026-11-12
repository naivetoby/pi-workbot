// @env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { startWeb, stopWeb } from '../src/chat/web.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { run } from '../src/runtime/process.ts'
import type { Runtime } from '../src/runtime/types.ts'

for (const binary of ['ttyd', 'tmux', 'caddy']) assert(Bun.which(binary), `缺少 ${binary}`)
// A short path also fits macOS's Unix-domain socket limit.
const root = await mkdtemp('/tmp/workbot-tui-')
const config: Runtime = {
  role: 'chat',
  piDir: join(root, 'pi'),
  workspace: join(root, 'workspace'),
  configSource: join(root, 'preset'),
  sharedSource: join(root, 'shared'),
  projectsFile: join(root, 'projects.json'),
}
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = probe.port!
probe.stop(true)
process.env = {
  PATH: process.env.PATH,
  WORKBOT_CHROME_BIN: process.env.WORKBOT_CHROME_BIN,
  HOME: root,
  TMPDIR: root,
  PI_OFFLINE: '1',
  PI_TELEMETRY: '0',
  PI_CHANNELS_DISABLE_SESSION_AUTOSTART: '1',
  PI_WEB_SKIP_VERSION_CHECK: '1',
  NEXT_TELEMETRY_DISABLED: '1',
  PI_WEB_PASSWORD: 'terminal-smoke-only',
  WORKBOT_TUI_ENABLED: '1',
  WORKBOT_TEST_REPORT: join(root, 'probe.json'),
  WORKBOT_TEST_VALUE: 'initial-environment',
  WORKBOT_TEST_REMOVED: 'old-value',
  PORT: String(port),
}
const base = `http://127.0.0.1:${port}`
const socket = join(root, 'tui.sock')
// SAFETY: this script runs only in Bun, whose native WebSocket supports headers/protocols;
// lib.dom's constructor declaration omits that overload.
const BunWebSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket
}
const connections: WebSocket[] = []
let recent = ''
async function waitFor(label: string, check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(
    `${label} 超时\n最近输出：${recent.slice(-3000)}\n${await Bun.file(join(root, 'web.log'))
      .text()
      .catch(() => '')}`,
  )
}

try {
  await mkdir(config.workspace, { recursive: true })
  await Bun.write(
    join(config.piDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      packages: [],
      extensions: [join(ROOT, 'test/fixtures/tui-session-probe.ts')],
    }),
  )
  const sessions: SessionManager[] = []
  for (let i = 0; i < 2; i++) {
    const session = SessionManager.create(config.workspace, join(config.piDir, 'sessions/web'))
    session.appendMessage({ role: 'user', content: `terminal-smoke-${i}`, timestamp: Date.now() })
    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '离线终端 fixture' }],
      api: 'anthropic-messages',
      provider: 'fixture',
      model: 'fixture',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    })
    sessions.push(session)
  }
  process.env.WORKBOT_TEST_OTHER_SESSION = sessions[1]!.getSessionFile()
  await startWeb(config)
  await waitFor('代理及 Next 就绪', async () => {
    try {
      return (await fetch(`${base}/api/web-auth`)).ok
    } catch {
      return false
    }
  })
  for (const path of [
    '/tui/',
    '/tui/token',
    '/tui/ws',
    '/api/workbot-terminal/theme',
    `/api/sessions/${sessions[0]!.getSessionId()}/terminal`,
  ]) {
    assert.equal((await fetch(base + path)).status, 401, `${path} 不得匿名访问`)
  }
  const login = await fetch(`${base}/api/web-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ password: process.env.PI_WEB_PASSWORD }),
  })
  assert.equal(login.status, 200)
  const secureLogin = await fetch(`${base}/api/web-auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: base.replace('http:', 'https:'),
      'X-Forwarded-Proto': 'https',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ password: process.env.PI_WEB_PASSWORD }),
  })
  assert.equal(secureLogin.status, 200)
  assert.match(
    secureLogin.headers.get('set-cookie')!,
    /; Secure(?:;|$)/i,
    '外层 HTTPS 反代必须保留 Secure Cookie',
  )
  const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!
  const headers = { Cookie: cookie, Origin: base }
  await waitFor(
    'ttyd 页面就绪',
    async () => (await fetch(`${base}/tui/`, { headers })).status === 200,
  )
  assert.equal(
    (await fetch(`${base}/tui/`, { headers: { ...headers, Origin: 'https://attacker.invalid' } }))
      .status,
    403,
  )
  assert.equal(
    (
      await fetch(`${base}/api/workbot-terminal/theme`, {
        method: 'POST',
        headers: {
          ...headers,
          Origin: 'https://attacker.invalid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key: 'a'.repeat(32), theme: 'dark' }),
      })
    ).status,
    403,
    '主题同步接口不能绕过同源检查',
  )
  const rejectedHeaders: Record<string, string>[] = [
    {},
    { Cookie: 'pi_web_session=forged' },
    { ...headers, Origin: 'https://attacker.invalid' },
  ]
  for (const requestHeaders of rejectedHeaders) {
    const response = await fetch(`${base}/tui/ws`, {
      headers: {
        ...requestHeaders,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    assert([401, 403].includes(response.status), `未授权 WebSocket：${response.status}`)
  }
  console.log('PASS: TUI 页面、资源和 WebSocket 继承 pi-web 登录，拒绝匿名、伪造凭证及跨站连接')

  const agentUrl = `${base}/api/agent/${sessions[0]!.getSessionId()}`
  const command = (type: string, extra: Record<string, string> = {}) =>
    fetch(agentUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...extra }),
    })
  const bashRequest = command('bash', { command: 'sleep 30' })
  try {
    await waitFor(
      'GUI bash 开始运行',
      async () =>
        (await fetch(agentUrl, { headers }).then((response) => response.json())).running === true,
    )
    const rejected = await fetch(`${base}/api/sessions/${sessions[0]!.getSessionId()}/terminal`, {
      method: 'POST',
      headers,
    })
    assert.equal(rejected.status, 409, 'GUI 工作未结束时不能交接到 TUI')
  } finally {
    await command('abort_bash')
    await bashRequest
  }
  console.log('PASS: GUI 正在执行命令时拒绝 TUI 交接')

  const urls: string[] = []
  for (const session of sessions) {
    const response = await fetch(`${base}/api/sessions/${session.getSessionId()}/terminal`, {
      method: 'POST',
      headers,
    })
    assert.equal(response.status, 200, await response.clone().text())
    const result = await response.json()
    assert.equal(result.active, true)
    urls.push(result.url)
  }
  const list = () =>
    run(['tmux', '-S', socket, 'list-sessions', '-F', '#{session_name} #{pane_pid}'])
  let initial = await list()
  assert.equal(initial.trim().split('\n').length, 2)
  const tmuxOptions = await run(['tmux', '-S', socket, 'show-options', '-s'])
  assert.match(tmuxOptions, /^extended-keys on$/m, 'Pi 必须启用扩展键')
  // tmux < 3.5 has no format option; keep verifying its supported configuration.
  const supportsKeyFormat = /^extended-keys-format /m.test(tmuxOptions)
  if (supportsKeyFormat)
    assert.match(tmuxOptions, /^extended-keys-format csi-u$/m, 'Pi 扩展键必须使用 CSI-u')
  await fetch(`${base}/api/sessions/${sessions[0]!.getSessionId()}/terminal`, {
    method: 'POST',
    headers,
  })
  assert.equal(await list(), initial, '同一会话重复打开必须复用 Pi 进程')
  if (process.argv.includes('--browser')) {
    console.log(
      await run(
        [
          process.execPath,
          join(ROOT, 'test/fixtures/tui-browser.mjs'),
          base,
          sessions[0]!.getSessionId(),
        ],
        {
          env: { ...process.env, WORKBOT_TEST_COOKIE: cookie },
        },
      ),
    )
    const restarted = await list()
    assert.notEqual(restarted, initial, '浏览器验收会退出并重新创建第一个 Pi')
    assert.equal(restarted.trim().split('\n').length, 2)
    initial = restarted
  }

  function connect(url: string) {
    const ws = new BunWebSocket(
      `${base.replace('http:', 'ws:')}${url.replace('/tui/', '/tui/ws')}`,
      { protocols: ['tty'], headers },
    )
    connections.push(ws)
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('open', () =>
      ws.send(new TextEncoder().encode(JSON.stringify({ AuthToken: '', columns: 100, rows: 30 }))),
    )
    ws.addEventListener('message', (event) => {
      const output =
        typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
      recent += output
      if (output.includes('\x1b[6n')) ws.send(new TextEncoder().encode('0\x1b[1;1R'))
    })
    return ws
  }
  async function probeSession(ws: WebSocket, operation: string) {
    const path = process.env.WORKBOT_TEST_REPORT!
    const report = Bun.file(path)
    await rm(path, { force: true })
    ws.send(new TextEncoder().encode(`0/tui-test ${operation}\r`))
    await waitFor(`Pi ${operation} 探针`, async () => {
      try {
        return (await report.json()).operation === operation
      } catch {
        return false
      }
    })
    return report.json()
  }
  const first = connect(urls[0]!)
  await waitFor('Pi 首次渲染', () => recent.includes('terminal-smoke-0'))
  if (supportsKeyFormat)
    assert.doesNotMatch(recent, /Warning: tmux extended-keys-format/, '不应出现按键格式警告')
  for (const operation of ['new', 'resume', 'fork']) {
    const result = await probeSession(first, operation)
    assert.equal(result.cancelled, true, `${operation} 不得改变受管终端的会话`)
    assert.equal(result.sessionId, sessions[0]!.getSessionId())
  }
  recent = ''
  first.send(new TextEncoder().encode('0/reload\r'))
  await waitFor('Pi 扩展重载完成', () => recent.includes('Reloaded keybindings'))
  recent = ''
  first.send(new TextEncoder().encode('0/clone\r'))
  await waitFor('原生 /clone 被阻止', () => recent.includes('此终端固定当前会话'))
  assert.equal((await probeSession(first, 'state')).sessionId, sessions[0]!.getSessionId())
  assert.equal(
    (await readdir(join(config.piDir, 'sessions/web'))).length,
    2,
    '不能创建隐形分叉会话',
  )
  assert.equal(await list(), initial)
  const tree = await probeSession(first, 'tree')
  assert.equal(tree.cancelled, false, '同一文件内的树导航仍使用 Pi 原生行为')
  assert.equal(tree.sessionId, sessions[0]!.getSessionId())
  console.log('PASS: 固定会话，拒绝 new/resume/fork/clone，保留文件内树导航')
  first.close()
  await waitFor('浏览器关闭后断开连接', () => first.readyState === WebSocket.CLOSED)
  assert.equal(await list(), initial, '关闭标签页不能结束 Pi')
  recent = ''
  const second = connect(urls[0]!)
  await waitFor('tmux 重连完整重绘', () => recent.includes('terminal-smoke-0'))
  assert.equal(await list(), initial)
  second.send(new TextEncoder().encode('1' + JSON.stringify({ columns: 70, rows: 24 })))
  second.send(new TextEncoder().encode('0\x04'))
  await waitFor(
    'Ctrl+D 结束 Pi 及 tmux 会话',
    async () => (await list()).trim().split('\n').length === 1,
  )
  const status = await fetch(`${base}/api/sessions/${sessions[0]!.getSessionId()}/terminal`, {
    headers,
  }).then((response) => response.json())
  assert.equal(status.active, false)
  console.log('PASS: 两个独立 Pi、同会话复用、断线保活、重连重绘、缩放和 Ctrl+D 退出')

  const missing = Bun.spawn([join(ROOT, 'bin/workbot-tui-attach'), 'f'.repeat(32)], {
    env: { PATH: process.env.PATH, WORKBOT_TMUX_SOCKET: socket },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  assert.notEqual(await missing.exited, 0)
  assert.equal((await list()).trim().split('\n').length, 1, '失效链接不得创建 shell 或会话')
  const remaining = await list()
  await stopWeb(config)
  assert.equal(await list(), remaining, '停止 Web 只能断开传输，不能终止 Pi')
  process.env.WORKBOT_TEST_VALUE = 'updated-environment $() ; "quote"\nsecond line'
  delete process.env.WORKBOT_TEST_REMOVED
  await startWeb(config)
  await waitFor('Web 重启后仍识别原 tmux 会话', async () => {
    try {
      const response = await fetch(`${base}/api/sessions/${sessions[1]!.getSessionId()}/terminal`, {
        headers,
      })
      return response.ok && (await response.json()).active === true
    } catch {
      return false
    }
  })
  assert.equal(await list(), remaining)
  console.log('PASS: 停止并重启 Web 后保留 Pi 进程，状态仍以 tmux 为准')

  recent = ''
  const retained = connect(urls[1]!)
  await waitFor('原 Pi 重连', () => recent.includes('terminal-smoke-1'))
  const oldEnvironment = await probeSession(retained, 'state')
  assert.equal(oldEnvironment.value, 'initial-environment', '保活进程不受新环境影响')
  assert.equal(oldEnvironment.removed, 'old-value')
  assert.equal(oldEnvironment.passwordPresent, false)
  retained.close()

  const reopened = await fetch(`${base}/api/sessions/${sessions[0]!.getSessionId()}/terminal`, {
    method: 'POST',
    headers,
  })
  assert.equal(reopened.status, 200, await reopened.clone().text())
  recent = ''
  const fresh = connect(urls[0]!)
  await waitFor('新 Pi 就绪', () => recent.includes('terminal-smoke-0'))
  const freshEnvironment = await probeSession(fresh, 'state')
  assert.equal(freshEnvironment.value, process.env.WORKBOT_TEST_VALUE)
  assert.equal(freshEnvironment.removed, undefined, '删除的环境变量不能从 tmux 恢复')
  assert.equal(freshEnvironment.passwordPresent, false, 'Pi 不得获得 Web 密码')
  assert((await list()).includes(String(freshEnvironment.pid)), 'Pi 替换启动器成为 pane 主进程')
  const commands = await run([
    'tmux',
    '-S',
    socket,
    'list-panes',
    '-a',
    '-F',
    '#{pane_start_command}',
  ])
  for (const secret of [process.env.PI_WEB_PASSWORD!, process.env.WORKBOT_TEST_VALUE])
    assert(!commands.includes(secret), 'pane 启动参数不得包含凭证')
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith('tui-launch-')),
    [],
  )
  console.log('PASS: 重启 Web 后新 Pi 使用完整新环境，凭证不进入 argv，启动快照已清理')
} catch (error) {
  console.error(
    await Bun.file(join(root, 'web.log'))
      .text()
      .catch(() => 'Web 日志尚未创建'),
  )
  throw error
} finally {
  for (const ws of connections) ws.close()
  await stopWeb(config)
  const stop = Bun.spawn(['tmux', '-S', socket, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await stop.exited
  await rm(root, { recursive: true, force: true })
}
