// @env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { startWeb, stopWeb } from '../src/chat/web.ts'
import { initialize } from '../src/runtime/init.ts'
import { PI_CLI } from '../src/runtime/paths.ts'
import { run } from '../src/runtime/process.ts'
import type { Runtime } from '../src/runtime/types.ts'

const root = await mkdtemp(join(tmpdir(), 'workbot-smoke-'))
// smoke 只用临时文件和本机接口，不读取维护者的 Pi 配置或业务凭证。
process.env = {
  PATH: process.env.PATH,
  HOME: root,
  // 与运行镜像一致，不回退到不支持宽字符行编辑的 /bin/sh。
  SHELL: '/bin/bash',
  TMPDIR: process.env.TMPDIR,
  PI_OFFLINE: '1',
  PI_TELEMETRY: '0',
  PI_CHANNELS_DISABLE_SESSION_AUTOSTART: '1',
  PI_WEB_SKIP_VERSION_CHECK: '1',
  NEXT_TELEMETRY_DISABLED: '1',
}
const config: Runtime = {
  role: 'chat',
  piDir: join(root, 'pi'),
  workspace: join(root, 'workspace'),
  configSource: join(root, 'preset'),
  sharedSource: join(root, 'shared'),
  projectsFile: join(root, 'projects.json'),
}
// 不读取仓库中可由维护者修改的插件或项目清单。
await mkdir(config.sharedSource)
await Bun.write(join(config.configSource, 'AGENTS.md'), '# 本机 smoke fixture\n')
await Bun.write(config.projectsFile, '[]')
await Bun.write(
  join(config.configSource, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    npmCommand: ['bun'],
    'pi-channels': { adapters: {}, bridge: { enabled: true, persistSessions: false } },
  }),
)
try {
  await initialize(config)
  const rpc = await run([process.execPath, PI_CLI, '--mode', 'rpc', '--no-session'], {
    cwd: config.workspace,
    input: '{"id":"state","type":"get_state"}\n{"id":"commands","type":"get_commands"}\n',
  })
  const events = rpc
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        throw new Error(`非 JSON RPC 输出：${line}`)
      }
    })
  assert.equal(events.filter((event) => event.type === 'response' && event.success).length, 2)
  const commands = events.find((event) => event.command === 'get_commands')?.data.commands ?? []
  assert(commands.some((command: { name: string }) => command.name === 'workbot'))
  console.log('PASS: Pi 原生配置、完整入口和 Workbot 扩展离线加载')

  if (process.argv.includes('--web')) {
    const settingsPath = join(config.piDir, 'settings.json')
    const settings = await Bun.file(settingsPath).json()
    settings['pi-channels'].adapters = { feishu: { type: 'feishu', appId: 'smoke' } }
    await Bun.write(settingsPath, JSON.stringify(settings))
    const cwd = config.workspace
    const session = SessionManager.create(cwd, join(config.piDir, 'sessions/im'))
    session.appendCustomEntry('workbot.origin', {
      kind: 'im',
      adapter: 'feishu',
      sessionId: session.getSessionId(),
    })
    session.appendMessage({ role: 'user', content: 'IM smoke 原始记录', timestamp: Date.now() })
    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '本地 fixture，无模型调用' }],
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
    const webSession = SessionManager.create(cwd)
    webSession.appendMessage({ role: 'user', content: 'Web smoke 原始记录', timestamp: Date.now() })
    const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = portProbe.port
    portProbe.stop(true)
    process.env.PORT = String(port)
    process.env.PI_WEB_HOSTNAME = '127.0.0.1'
    const url = `http://127.0.0.1:${port}`
    await startWeb(config)
    const request = async (path: string, method = 'GET', body?: unknown): Promise<Response> => {
      const options: RequestInit = {
        method,
        headers: { 'content-type': 'application/json', origin: url },
        signal: AbortSignal.timeout(15_000),
      }
      if (body !== undefined) options.body = JSON.stringify(body)
      const response = await fetch(url + path, options)
      assert(response.ok, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`)
      return response
    }
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(url + '/api/web-auth', { signal: AbortSignal.timeout(1_000) })
        if (response.ok) {
          ready = true
          break
        }
      } catch {
        /* 等待 Next.js 启动 */
      }
      await Bun.sleep(200)
    }
    assert(ready, `Web 未就绪，日志：${await Bun.file(join(root, 'web.log')).text()}`)
    const defaultCwd = await (await request('/api/default-cwd', 'POST')).json()
    assert.equal(defaultCwd.cwd, config.workspace, 'Web 默认目录应为 Workbot 工作区')
    const list = await (await request('/api/sessions?force=1')).json()
    const im = list.sessions.find((item: { id: string }) => item.id === session.getSessionId())
    assert(im, 'Web 应发现 IM 会话')
    assert.equal(im.cwd, cwd)
    assert.deepEqual(im.origin, { kind: 'im', adapter: 'feishu' })
    const web = list.sessions.find((item: { id: string }) => item.id === webSession.getSessionId())
    assert(web, 'Web 应发现普通会话')
    assert.equal(web.origin, undefined)
    assert.equal(web.cwd, im.cwd)
    assert(im.projectKey, '会话列表应提供工作区分组标识')
    assert.equal(web.projectKey, im.projectKey, 'IM 和 Web 会话应属于同一个侧栏分组')
    const transcript = await (await request(`/api/sessions/${session.getSessionId()}`)).text()
    assert(transcript.includes('IM smoke 原始记录'))
    assert.deepEqual(JSON.parse(transcript).info.origin, im.origin)
    const exportResponse = await request(`/api/sessions/${session.getSessionId()}/export`)
    assert.equal(exportResponse.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(exportResponse.headers.get('content-security-policy'), "frame-ancestors 'none'")
    assert.equal(exportResponse.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(exportResponse.headers.get('x-frame-options'), 'DENY')
    assert.match(exportResponse.headers.get('content-disposition') ?? '', /^attachment;/)
    const exported = await exportResponse.text()
    const data = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(
      exported,
    )?.[1]
    assert(data, '导出页面应包含原生 session-data')
    assert(Buffer.from(data, 'base64').toString('utf8').includes('IM smoke 原始记录'))
    await request('/api/cache-miss-notices', 'PUT', { enabled: true })
    assert.equal((await Bun.file(settingsPath).json()).showCacheMissNotices, true)
    await request('/api/mcp')
    const terminal = await (await request('/api/terminal', 'POST', { cwd })).json()
    const stream = await request(`/api/terminal/${terminal.id}/events`)
    const reader = stream.body!.getReader()
    try {
      await request(`/api/terminal/${terminal.id}`, 'POST', {
        type: 'input',
        data:
          [
            'printf \'workbot-%s-%s\\n\' "${BASH_VERSION:+bash}" "$((20+22))"',
            `node -e 'console.log("workbot-node-"+Boolean(process.versions.node && !process.versions.bun))'`,
            `bun -e 'console.log("workbot-bun-"+Boolean(process.versions.bun))'`,
          ].join('; ') + '\r',
      })
      let output = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        output += new TextDecoder().decode(value)
        if (
          ['workbot-bash-42', 'workbot-node-true', 'workbot-bun-true'].every((text) =>
            output.includes(text),
          )
        )
          break
      }
      assert(output.includes('workbot-bash-42'), 'Bun PTY 应使用 Bash 并返回实际命令输出')
      assert(output.includes('workbot-node-true'), 'Web 终端的 node 必须是真实 Node.js')
      assert(output.includes('workbot-bun-true'), 'Web 终端仍可显式选择 Bun')
    } finally {
      await reader.cancel()
      await request(`/api/terminal/${terminal.id}`, 'DELETE')
    }
    console.log(
      'PASS: Bun 生产 Web、默认工作区、IM 原始会话读取/导出、原生设置写入、MCP 页面与交互 PTY（Node/Bun 独立选择）',
    )
  }
} finally {
  await stopWeb(config)
  await rm(root, { recursive: true, force: true })
}
