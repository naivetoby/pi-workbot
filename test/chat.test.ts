// @env node
import { describe, expect, it } from 'bun:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { bridgeInput, MESSAGE_PREFIX } from '../src/chat/bridge.ts'
import { channelsReady, chat } from '../src/chat/host.ts'
import { initialize } from '../src/runtime/init.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { fixture } from './helpers.ts'

describe('IM 入口', () => {
  it('正文独立传入，保留会话和附件参数，使用 Pi 文件中的模型与扩展配置', () => {
    const value = bridgeInput([
      '-p',
      '--offline',
      '--no-extensions',
      '--provider',
      'bridge-provider',
      '--model',
      'bridge-model',
      '--session',
      '/tmp/chat.jsonl',
      '@image.png',
      MESSAGE_PREFIX + '@不是本地文件\n包含换行的正文',
    ])
    expect(value).toEqual({
      prompt: '@不是本地文件\n包含换行的正文',
      args: ['-p', '--offline', '--session', '/tmp/chat.jsonl', '@image.png'],
    })
    expect(() => bridgeInput(['-p'])).toThrow('消息正文')
  })

  it('全部启用渠道双向就绪才健康', () => {
    const status = {
      ok: true,
      bridgeActive: true,
      items: [
        { name: 'feishu', type: 'adapter', direction: 'bidirectional' },
        { name: 'wecom', type: 'adapter', direction: 'bidirectional' },
      ],
    }
    expect(channelsReady(['feishu', 'wecom'], status)).toBe(true)
    expect(channelsReady([], status)).toBe(false)
    expect(channelsReady(['missing'], status)).toBe(false)
    expect(channelsReady(['feishu'], { ...status, ok: false })).toBe(false)
    expect(channelsReady(['feishu'], { ...status, bridgeActive: false })).toBe(false)
    expect(
      channelsReady(['feishu'], {
        ...status,
        items: [{ name: 'feishu', type: 'adapter', direction: 'inbound' }],
      }),
    ).toBe(false)
  })

  it.each([
    {},
    { 'pi-channels': {} },
    { 'pi-channels': { adapters: {} } },
    { 'pi-channels': { adapters: { feishu: { type: 'feishu' }, wecom: { type: 'wecom' } } } },
  ])('初始化工作区不创建 IM 会话入口：%j', async (settings) => {
    const config = await fixture()
    await Bun.write(join(config.configSource, 'settings.json'), JSON.stringify(settings))

    await initialize(config)

    expect((await stat(config.workspace)).isDirectory()).toBe(true)
    expect(await stat(join(config.workspace, '.pi')).catch(() => undefined)).toBeUndefined()
    expect(await stat(join(config.piDir, 'sessions/im')).catch(() => undefined)).toBeUndefined()
  })

  it('只挂载会话命名卷，不持久化工作区或整个 Pi 配置目录', async () => {
    const compose = Bun.YAML.parse(await Bun.file(join(ROOT, 'compose.yml')).text()) as {
      services: { chat: { volumes: string[] } }
      volumes: Record<string, unknown>
    }
    expect(compose.services.chat.volumes).toEqual(['chat-sessions:/runtime/pi/sessions'])
    expect(compose.volumes).toHaveProperty('chat-sessions')
  })

  it('只保留 sessions 目录重建运行环境后，Web 和 IM 会话可恢复，工作文件和在线设置不保留', async () => {
    const config = await fixture()
    const sourceSettings = join(config.configSource, 'settings.json')
    const settings = await Bun.file(sourceSettings).json()
    settings['pi-channels'].adapters = { feishu: { type: 'feishu' } }
    await Bun.write(sourceSettings, JSON.stringify(settings))
    await initialize(config)
    const cwd = config.workspace
    const webFile = join(config.piDir, 'sessions/--workspace--/web-history.jsonl')
    const imFile = join(config.piDir, 'sessions/im/im-history.jsonl')
    const timestamp = new Date().toISOString()
    for (const [file, sessionCwd, id] of [
      [webFile, config.workspace, 'web-history'],
      [imFile, cwd, 'im-history'],
    ] as const) {
      const entries = [
        { type: 'session', version: 3, id, timestamp, cwd: sessionCwd },
        {
          type: 'thinking_level_change',
          id: 'thinking',
          parentId: null,
          timestamp,
          thinkingLevel: 'high',
        },
        {
          type: 'message',
          id: 'message',
          parentId: 'thinking',
          timestamp,
          message: { role: 'user', content: '需要保留的会话', timestamp: Date.now() },
        },
      ]
      await Bun.write(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    }
    const before = await Promise.all([webFile, imFile].map((file) => Bun.file(file).text()))
    const workFile = join(config.workspace, 'repos/group/project/uncommitted.txt')
    await Bun.write(workFile, '临时工作文件')
    await Bun.write(
      join(config.piDir, 'settings.json'),
      JSON.stringify({ defaultModel: 'online-model' }),
    )
    // 模拟替换容器：只有命名卷中的 sessions 目录进入新环境。
    const saved = join(config.piDir, '../saved-sessions')
    await rename(join(config.piDir, 'sessions'), saved)
    await rm(config.piDir, { recursive: true })
    await rm(config.workspace, { recursive: true })
    await mkdir(config.piDir)
    await rename(saved, join(config.piDir, 'sessions'))
    await initialize(config)
    expect(await stat(join(cwd, '.pi')).catch(() => undefined)).toBeUndefined()
    expect(await Bun.file(workFile).exists()).toBe(false)
    expect((await Bun.file(join(config.piDir, 'settings.json')).json()).defaultModel).toBe(
      'fixture',
    )
    for (const [index, file] of [webFile, imFile].entries()) {
      expect(await Bun.file(file).text()).toBe(before[index])
      const context = SessionManager.open(file).buildSessionContext()
      expect(context.thinkingLevel).toBe('high')
      expect(context.messages).toMatchObject([{ role: 'user', content: '需要保留的会话' }])
    }
  })

  it.each(['../escape', '/absolute', '.', '..', 'nested/name', 'nested\\name'])(
    '启动渠道宿主时拒绝不安全的 adapter 名称 %s',
    async (name) => {
      const config = await fixture()
      await Bun.write(
        join(config.piDir, 'settings.json'),
        JSON.stringify({ 'pi-channels': { adapters: { [name]: { type: 'feishu' } } } }),
      )
      await expect(chat(config)).rejects.toThrow('无效的 IM adapter 名称')
    },
  )
})
