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

  it('异步检查不返回时仍按时失败，并发出取消信号', async () => {
    let cancelled = false
    let calls = 0
    await expect(
      waitFor(
        '挂起的请求',
        (signal) => {
          calls++
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true
            },
            { once: true },
          )
          return new Promise<boolean>(() => {})
        },
        { timeout: 5, diagnostics: () => 'request pending' },
      ),
    ).rejects.toThrow('等待超时：挂起的请求\nrequest pending')
    expect(cancelled).toBe(true)
    expect(calls).toBe(1)
  })

  it('检查自身失败时保留原始错误，不改写为等待超时', async () => {
    const error = new Error('子进程已退出')
    await expect(
      waitFor('就绪检查', async () => {
        throw error
      }),
    ).rejects.toBe(error)
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
