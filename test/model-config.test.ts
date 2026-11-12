// @env node
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { initialize } from '../src/runtime/init.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { fixture } from './helpers.ts'

async function relayFixture() {
  const config = await fixture()
  const source = await Bun.file(join(ROOT, 'configs/shared/models.json')).json()
  await Bun.write(join(config.sharedSource, 'models.json'), JSON.stringify(source))
  return { config, source }
}

describe('中转地址初始化', () => {
  it('只注入地址，保留模型定义和密钥引用，重复初始化保留在线配置', async () => {
    const { config, source } = await relayFixture()
    process.env.OPENAI_RELAY_BASE_URL = 'https://relay.fixture/v1'
    process.env.OPENAI_RELAY_API_KEY = 'fixture-secret-not-for-file'

    await initialize(config)

    const file = Bun.file(join(config.piDir, 'models.json'))
    const text = await file.text()
    const models = JSON.parse(text)
    expect(models.providers['openai-relay']).toEqual({
      ...source.providers['openai-relay'],
      baseUrl: 'https://relay.fixture/v1',
    })
    expect(text).not.toContain('fixture-secret-not-for-file')
    expect(await Bun.file(join(config.sharedSource, 'models.json')).json()).toEqual(source)

    models.providers['openai-relay'].baseUrl = 'https://online.fixture/v1'
    await Bun.write(file, JSON.stringify(models))
    process.env.OPENAI_RELAY_BASE_URL = 'https://changed.fixture/v1'
    await initialize(config)
    expect(await file.json()).toEqual(models)
  })

  it('未配置地址时不启用中转，其他 provider 保持不变', async () => {
    const { config, source } = await relayFixture()
    delete process.env.OPENAI_RELAY_BASE_URL
    source.providers.other = { baseUrl: 'https://other.fixture/v1' }
    await Bun.write(join(config.sharedSource, 'models.json'), JSON.stringify(source))

    await initialize(config)

    expect((await Bun.file(join(config.piDir, 'models.json')).json()).providers).toEqual({
      other: source.providers.other,
    })
  })

  it('角色文件里的字面地址不被环境变量覆盖', async () => {
    const { config, source } = await relayFixture()
    source.providers['openai-relay'].baseUrl = 'https://role.fixture/v1'
    await Bun.write(join(config.configSource, 'models.json'), JSON.stringify(source))
    process.env.OPENAI_RELAY_BASE_URL = 'https://ignored.fixture/v1'

    await initialize(config)

    expect(await Bun.file(join(config.piDir, 'models.json')).json()).toEqual(source)
  })

  it.each(['not-a-url', 'file:///tmp/relay', 'https://user:secret@relay.fixture/v1'])(
    '拒绝非法或含凭证的地址，错误不回显输入：%s',
    async (value) => {
      const { config } = await relayFixture()
      process.env.OPENAI_RELAY_BASE_URL = value

      await expect(initialize(config)).rejects.toThrow(
        /^OPENAI_RELAY_BASE_URL 必须为不含凭证的 HTTP\(S\) 地址$/,
      )

      expect(await Bun.file(join(config.piDir, '.workbot-initialized')).exists()).toBe(false)
    },
  )
})
