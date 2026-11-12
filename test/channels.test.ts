// @env node
import { describe, expect, it } from 'bun:test'
import piChannels from '@amaster.ai/pi-channels'
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BRIDGE_BIN, ROOT } from '../src/runtime/paths.ts'
import { initialize } from '../src/runtime/init.ts'
import { fixture, waitFor } from './helpers.ts'

// 只替换模型与平台网络；资源发现、队列、会话、子进程和命令均走真实 bridge。
async function createBridgeFixture() {
  const config = await fixture()
  await initialize(config)
  const requests: string[] = []
  const replies: { adapter: string; text: string }[] = []
  const receivers = new Map<string, (message: unknown) => void>()
  const events = createEventBus()
  const release = Promise.withResolvers<void>()
  let holding = false
  let session: AgentSession | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const raw = await request.text()
      requests.push(raw)
      const body = JSON.parse(raw)
      if (JSON.stringify(body.messages.at(-1)).includes('等待取消')) {
        holding = true
        await release.promise
      }
      const chunk = (value: object) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, ...value }] })}\n\n`
      return new Response(
        chunk({ delta: { role: 'assistant', content: '本机模拟回复' }, finish_reason: null }) +
          chunk({ delta: {}, finish_reason: 'stop' }) +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const cleanup = async () => {
    release.resolve()
    try {
      await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    } finally {
      session?.dispose()
      events.clear()
      server.stop(true)
    }
  }
  try {
    await Bun.write(
      join(config.piDir, 'models.json'),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: `${server.url}v1`,
            api: 'openai-completions',
            apiKey: 'local-fixture-only',
            models: [{ id: 'fixture', input: ['text'], contextWindow: 8192, maxTokens: 256 }],
          },
        },
      }),
    )
    await Bun.write(
      join(config.piDir, 'fixture.ts'),
      Bun.file(join(ROOT, 'test/fixtures/local-extension.ts')),
    )
    await Bun.write(
      join(config.piDir, 'skills/local-fixture/SKILL.md'),
      '---\nname: local-fixture\ndescription: local fixture skill description\n---\n仅本机测试。\n',
    )
    await Bun.write(
      join(config.piDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          local_fixture: {
            command: process.execPath,
            args: [join(ROOT, 'test/fixtures/mcp-server.ts')],
            exposure: 'direct',
          },
        },
      }),
    )
    const settingsPath = join(config.piDir, 'settings.json')
    const settings = await Bun.file(settingsPath).json()
    settings.defaultProvider = 'local'
    settings.defaultModel = 'fixture'
    settings.extensions = ['./fixture.ts']
    settings['pi-channels'] = {
      adapters: { feishu: { type: 'feishu' }, wecom: { type: 'wecom' } },
      bridge: {
        enabled: true,
        persistSessions: false,
        commands: true,
        piBin: BRIDGE_BIN,
        env: { PI_CODING_AGENT_DIR: config.piDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
      },
    }
    await Bun.write(settingsPath, JSON.stringify(settings))
    const cwd = config.workspace
    // 平台 adapter 在绑定后用本机传输注册。
    settings['pi-channels'].adapters = {}
    await Bun.write(settingsPath, JSON.stringify(settings))
    await Bun.write(join(cwd, 'AGENTS.md'), 'IM 与 Web 共用的工作目录标记\n')
    process.env.PI_CODING_AGENT_DIR = config.piDir
    delete process.env.PI_CHANNELS_DISABLE_SESSION_AUTOSTART
    const settingsManager = SettingsManager.inMemory({ packages: [] })
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: config.piDir,
      settingsManager,
      eventBus: events,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [piChannels],
    })
    await loader.reload()
    const created = await createAgentSession({
      cwd,
      agentDir: config.piDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: 'all',
    })
    session = created.session
    await session.bindExtensions({ mode: 'print' })
    for (const adapter of ['feishu', 'wecom']) {
      events.emit('channel:register', {
        name: adapter,
        adapter: {
          direction: 'bidirectional',
          async start(receive: (message: unknown) => void) {
            receivers.set(adapter, receive)
          },
          async send(message: { text: string }) {
            replies.push({ adapter, text: message.text })
          },
          async stop() {},
        },
      })
    }
    const send = (adapter: string, text: string, user = 'u1') => {
      const receive = receivers.get(adapter)
      if (!receive) throw new Error(`测试 adapter 未注册：${adapter}`)
      receive({ adapter, sender: `same-group:${user}`, text, metadata: { chatId: 'same-group' } })
    }
    const wait = (description: string, check: () => boolean | Promise<boolean>) =>
      waitFor(description, check, {
        timeout: 15_000,
        diagnostics: () =>
          JSON.stringify({
            replies,
            requestCount: requests.length,
            lastRequest: requests.at(-1)?.slice(-2000),
          }),
      })
    const ask = async (adapter: string, text: string, user?: string) => {
      const count = replies.length
      send(adapter, text, user)
      await wait(`${adapter} 回复「${text}」`, () => replies.length > count)
    }
    return { config, cwd, requests, replies, send, ask, wait, isHolding: () => holding, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

describe('IM bridge 集成', () => {
  it('完整链路加载工具、Skills、MCP 和角色约定，渠道共用 workspace 并记录独立来源', async () => {
    const bridge = await createBridgeFixture()
    try {
      await bridge.ask('feishu', '第一条消息')
      await bridge.ask('wecom', '另一渠道')
      expect(bridge.replies.every((reply) => reply.text === '本机模拟回复')).toBe(true)
      const dir = join(bridge.config.piDir, 'sessions/im')
      const files = await readdir(dir)
      expect(files).toHaveLength(2)
      expect(await lstat(join(bridge.cwd, '.pi')).catch(() => undefined)).toBeUndefined()
      for (const name of ['feishu', 'wecom']) {
        const file = files.find((file) => file.startsWith(`${name}-`))!
        const [header, origin] = (await Bun.file(join(dir, file)).text())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(header.cwd).toBe(bridge.config.workspace)
        expect(origin).toMatchObject({
          type: 'custom',
          customType: 'workbot.origin',
          parentId: null,
          data: { kind: 'im', adapter: name, sessionId: header.id },
        })
        const entries = SessionManager.open(join(dir, file)).getEntries()
        expect(
          entries.filter(
            (entry) => entry.type === 'custom' && entry.customType === 'workbot.origin',
          ),
        ).toHaveLength(1)
      }
      const payload = bridge.requests.find((request) => request.includes('第一条消息'))!
      for (const name of [
        'read',
        'bash',
        'edit',
        'write',
        'dispatch_code',
        'local_fixture_tool',
        'mcp__local_fixture__echo_fixture',
      ])
        expect(payload).toContain(`"name":"${name}"`)
      expect(payload).toContain('local fixture skill description')
      expect(payload).toContain('Workbot chat 工作约定')
      expect(payload).toContain('IM 与 Web 共用的工作目录标记')
      expect(bridge.requests.at(-1)).toContain('IM 与 Web 共用的工作目录标记')
      expect(payload).not.toContain('workbot.origin')
    } finally {
      await bridge.cleanup()
    }
  }, 30_000)

  it('会话初始化写盘失败时回复错误，修复目录后仍可处理各渠道消息', async () => {
    const bridge = await createBridgeFixture()
    try {
      const dir = join(bridge.config.piDir, 'sessions/im')
      await mkdir(join(bridge.config.piDir, 'sessions'), { recursive: true })
      await Bun.write(dir, '占用会话目录')

      await bridge.ask('feishu', '写盘失败的消息')

      expect(bridge.replies.at(-1)?.text).toStartWith('Error:')
      expect(bridge.requests).toHaveLength(0)
      expect(await Bun.file(dir).text()).toBe('占用会话目录')

      await rm(dir)
      await bridge.ask('feishu', '修复后继续')
      await bridge.ask('wecom', '另一渠道继续')
      expect(bridge.replies.slice(1).map((reply) => reply.text)).toEqual([
        '本机模拟回复',
        '本机模拟回复',
      ])
      expect(bridge.requests).toHaveLength(2)
      expect(bridge.requests[0]).toContain('修复后继续')
      expect(bridge.requests[0]).not.toContain('写盘失败的消息')
      expect(bridge.requests[1]).toContain('另一渠道继续')
      expect(bridge.requests[1]).not.toContain('写盘失败的消息')
    } finally {
      await bridge.cleanup()
    }
  }, 30_000)

  it('同群不同成员接续上下文，不混入另一渠道的消息', async () => {
    const bridge = await createBridgeFixture()
    try {
      await bridge.ask('feishu', '第一条消息')
      await bridge.ask('wecom', '另一渠道')
      await bridge.ask('feishu', '同群接续', 'u2')
      expect(bridge.requests.at(-1)).toContain('第一条消息')
      expect(bridge.requests.at(-1)).not.toContain('另一渠道')
    } finally {
      await bridge.cleanup()
    }
  }, 30_000)

  it.each(['/new', '/clear'])(
    '%s 只重置当前渠道会话，不调用模型，其他渠道仍能接续',
    async (command) => {
      const bridge = await createBridgeFixture()
      try {
        await bridge.ask('feishu', '旧会话消息')
        await bridge.ask('wecom', '另一渠道')
        const requestCount = bridge.requests.length
        await bridge.ask('feishu', command)
        expect(bridge.replies.at(-1)?.text).toBe('Session reset.')
        expect(bridge.requests).toHaveLength(requestCount)
        const dir = join(bridge.config.piDir, 'sessions/im')
        const remaining = await readdir(dir)
        expect(remaining).toHaveLength(1)
        expect(remaining[0]).toStartWith('wecom-')
        await bridge.ask('feishu', '新会话消息')
        const files = await readdir(dir)
        const file = files.find((file) => file.startsWith('feishu-'))!
        const manager = SessionManager.open(join(dir, file))
        expect(manager.getEntries()[0]).toMatchObject({
          type: 'custom',
          customType: 'workbot.origin',
          data: { kind: 'im', adapter: 'feishu', sessionId: manager.getSessionId() },
        })
        expect(bridge.requests.at(-1)).not.toContain('旧会话消息')
        await bridge.ask('wecom', '渠道接续')
        expect(bridge.requests.at(-1)).toContain('另一渠道')
        expect(bridge.requests.at(-1)).not.toContain('新会话消息')
      } finally {
        await bridge.cleanup()
      }
    },
    30_000,
  )

  it('/clear 取消当前任务并丢弃排队消息，连续清空后仍可开启新会话', async () => {
    const bridge = await createBridgeFixture()
    try {
      bridge.send('feishu', '等待取消')
      await bridge.wait('模型请求进入挂起状态', bridge.isHolding)
      bridge.send('feishu', '应被清空的排队消息')
      await bridge.wait('消息进入等待队列', async () => {
        await bridge.ask('feishu', '/status')
        return bridge.replies.at(-1)?.text.includes('Queued: 1') === true
      })

      bridge.send('feishu', '/clear')
      await bridge.wait('取消任务并清空队列', () =>
        bridge.replies.some(
          (reply) => reply.text === 'Session reset. Dropped 1 queued message(s).',
        ),
      )
      const dir = join(bridge.config.piDir, 'sessions/im')
      expect(await readdir(dir)).toHaveLength(0)
      expect(bridge.requests).toHaveLength(1)

      await bridge.ask('feishu', '/clear')
      expect(bridge.replies.at(-1)?.text).toBe('Session reset.')
      expect(await readdir(dir)).toHaveLength(0)
      expect(bridge.requests).toHaveLength(1)

      await bridge.ask('feishu', '清空后继续')
      expect(bridge.replies.at(-1)?.text).toBe('本机模拟回复')
      expect(bridge.requests).toHaveLength(2)
      expect(bridge.requests.at(-1)).toContain('清空后继续')
      expect(bridge.requests.at(-1)).not.toContain('等待取消')
      expect(bridge.requests.at(-1)).not.toContain('应被清空的排队消息')
    } finally {
      await bridge.cleanup()
    }
  }, 30_000)

  it('/abort 后无需等待被挂起的模型请求，即可继续处理新消息', async () => {
    const bridge = await createBridgeFixture()
    try {
      bridge.send('feishu', '等待取消')
      await bridge.wait('模型请求进入挂起状态', bridge.isHolding)
      const dir = join(bridge.config.piDir, 'sessions/im')
      const files = await readdir(dir)
      expect(files).toHaveLength(1)
      const manager = SessionManager.open(join(dir, files[0]!))
      expect(manager.getEntries()[0]).toMatchObject({
        type: 'custom',
        customType: 'workbot.origin',
        data: { kind: 'im', adapter: 'feishu', sessionId: manager.getSessionId() },
      })
      await bridge.ask('feishu', '/abort')
      bridge.send('feishu', '取消后继续')
      await bridge.wait(
        '模型收到取消后的新消息',
        () => bridge.requests.at(-1)?.includes('取消后继续') === true,
      )
      await bridge.wait('取消后的正常回复', () => bridge.replies.at(-1)?.text === '本机模拟回复')
    } finally {
      await bridge.cleanup()
    }
  }, 30_000)
})
