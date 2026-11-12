// @env node
import { describe, expect, it } from 'bun:test'
import { testEnvironment, waitFor } from './helpers.ts'

describe('测试基础设施', () => {
  it('等待超时包含场景名和最后状态', async () => {
    await expect(
      waitFor('飞书回复', () => false, {
        timeout: 0,
        diagnostics: () => 'replies=0; child exit=1',
      }),
    ).rejects.toThrow('等待超时：飞书回复\nreplies=0; child exit=1')
  })

  it('条件已满足时不读取失败诊断', async () => {
    await waitFor('已经就绪', () => true, {
      diagnostics: () => {
        throw new Error('不应调用')
      },
    })
  })

  it('子进程只继承明确允许的基础环境及用例覆盖值', () => {
    process.env.GITLAB_TOKEN = 'fixture-secret'
    process.env.WECOM_BOT_URL = 'https://webhook.fixture'
    const env = testEnvironment({ WORKBOT_ROLE: 'chat' })
    expect(env.GITLAB_TOKEN).toBeUndefined()
    expect(env.WECOM_BOT_URL).toBeUndefined()
    expect(env.WORKBOT_ROLE).toBe('chat')
    expect(env.PI_OFFLINE).toBe('1')
  })
})
