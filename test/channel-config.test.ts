// @env node
import { describe, expect, it } from 'bun:test'
import { loadChannelConfig } from '@amaster.ai/pi-channels'
import { join } from 'node:path'
import { initialize } from '../src/runtime/init.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { fixture } from './helpers.ts'

async function channelFixture() {
  const config = await fixture()
  const settings = await Bun.file(join(ROOT, 'configs/chat/settings.json')).json()
  settings['pi-channels'].adapters.feishu.allowedSenderIds = ['ou-fixture']
  await Bun.write(join(config.configSource, 'settings.json'), JSON.stringify(settings))
  await initialize(config)
  return config
}

describe('渠道环境凭证', () => {
  it('仅筛选有效配置，凭证变化后仍保留磁盘模板、白名单、模型和插件', async () => {
    const config = await channelFixture()
    const path = join(config.piDir, 'settings.json')
    const before = await Bun.file(path).text()

    expect(loadChannelConfig(config.workspace).adapters).toEqual({})

    process.env.FEISHU_APP_ID = 'fixture-app'
    process.env.FEISHU_APP_SECRET = 'fixture-secret'
    const active = loadChannelConfig(config.workspace)
    expect(Object.keys(active.adapters ?? {})).toEqual(['feishu'])
    expect(active.adapters?.feishu).toMatchObject({
      appId: 'fixture-app',
      appSecret: 'fixture-secret',
      eventMode: 'websocket',
      respondToMentionsOnly: true,
      allowedSenderIds: ['ou-fixture'],
    })
    expect(active.bridge?.enabled).toBe(true)

    delete process.env.FEISHU_APP_SECRET
    expect(loadChannelConfig(config.workspace).adapters).toEqual({})
    expect(await Bun.file(path).text()).toBe(before)
    expect(await Bun.file(path).text()).not.toContain('fixture-secret')
  })

  it('完整凭证可补充空 adapter 配置，不要求手动启用渠道', async () => {
    const config = await fixture()
    await initialize(config)
    process.env.WECOM_BOT_ID = 'fixture-bot'
    process.env.WECOM_BOT_SECRET = 'fixture-secret'

    const active = loadChannelConfig(config.workspace)

    expect(active.adapters).toEqual({
      wecom: { type: 'wecom', botId: 'fixture-bot', secret: 'fixture-secret' },
    })
    expect(active.bridge?.enabled).toBe(true)
  })

  it.each([undefined, '', ' \t '])('飞书密钥为 %j 时跳过渠道并保留磁盘配置', async (secret) => {
    const config = await channelFixture()
    const path = join(config.piDir, 'settings.json')
    const before = await Bun.file(path).text()
    process.env.FEISHU_APP_ID = 'fixture-app'
    if (secret !== undefined) process.env.FEISHU_APP_SECRET = secret

    const active = loadChannelConfig(config.workspace)

    expect(active.adapters).toEqual({})
    expect(await Bun.file(path).text()).toBe(before)
  })

  it('自定义名称的飞书和企微配置同样需要完整凭证，不影响其他类型渠道', async () => {
    const config = await fixture()
    const settings = {
      'pi-channels': {
        adapters: {
          personal: { type: 'feishu', appId: 'literal-id', appSecret: 'literal-secret' },
          office: { type: 'wecom', botId: 'literal-id', secret: 'literal-secret' },
          hook: { type: 'webhook' },
        },
      },
    }
    await Bun.write(join(config.configSource, 'settings.json'), JSON.stringify(settings))
    await initialize(config)
    process.env.FEISHU_APP_ID = 'fixture-id'

    const active = loadChannelConfig(config.workspace)

    expect(active.adapters).toEqual({ hook: { type: 'webhook' } })
  })
})
