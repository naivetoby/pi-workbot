// @env node
import { afterEach, beforeEach, mock } from 'bun:test'
import { cleanFixtures } from './helpers.ts'

const original = { ...process.env }

// 测试会修改进程环境和 mock；保持串行执行，不使用 test.concurrent。
// 业务配置由用例显式提供，不继承开发者的令牌、渠道或 CI 环境。
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (
      /^(WORKBOT_|PI_|GITLAB_|GLAB_|CI_|FEISHU_|WECOM_|DEEPSEEK_|TOBY_|OPENAI_|ANTHROPIC_)/.test(
        key,
      )
    )
      delete process.env[key]
  }
})

// preload 中注册的钩子应用于所有测试文件。
afterEach(async () => {
  mock.restore()
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await cleanFixtures()
})
