// @env node
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent'
import { runtime } from '../../src/runtime/config.ts'
import { initialize } from '../../src/runtime/init.ts'
import { prepareLanguageFixtures, verifyLanguageServers } from './lens-language-checks.ts'

async function verify(): Promise<void> {
  assert.equal(process.platform, 'linux', '完整 LSP 验收必须在 Linux 角色镜像内执行')
  assert.notEqual(process.getuid!(), 0, '必须使用运行时非 root 用户')
  const role = process.argv[2]
  assert(role === 'chat' || role === 'code')
  const config = runtime(role)
  await initialize(config)
  const cwd = config.workspace
  prepareLanguageFixtures(cwd)
  const settingsManager = SettingsManager.create(cwd, config.piDir)
  const loader = new DefaultResourceLoader({ cwd, agentDir: config.piDir, settingsManager })
  let session: AgentSession | undefined
  const errors: string[] = []
  try {
    await loader.reload()
    assert.deepEqual(loader.getExtensions().errors, [], '角色扩展必须真实加载')
    ;({ session } = await createAgentSession({
      cwd,
      agentDir: config.piDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    }))
    await session.bindExtensions({
      onError: (error) => errors.push(`${error.extensionPath}: ${error.error}`),
    })
    const runner = session.extensionRunner
    assert(runner)
    let report = ''
    runner.setUIContext(
      {
        ...runner.getUIContext(),
        notify: (text) => {
          report += text + '\n'
        },
      },
      'rpc',
    )
    assert(runner.getCommand('lens-tools'), '缺少 /lens-tools，不能回退为模型请求')
    await session.prompt('/lens-tools')
    console.log(report)
    for (const name of [
      'TypeScript',
      'Prettier',
      'Ruff',
      'ast-grep CLI',
      'HTMLHint',
      'markdownlint-cli2',
      'Stylelint',
      'Oxlint',
      'oxfmt',
      'ShellCheck',
      'shfmt',
      'TypeScript Language Server',
      'Pyright',
      'YAML Language Server',
      'VSCode JSON Language Server',
      'VSCode HTML Language Server',
      'VSCode CSS Language Server',
    ]) {
      assert(
        report.includes(`✓ ${name}\n`) || report.includes(`✓ ${name} (`),
        `lens 未识别 ${name}`,
      )
    }
    await verifyLanguageServers(runner, cwd)
    assert(
      !existsSync(join(process.env.PI_LENS_HOME!, 'tools/node_modules')),
      '不得依赖 lens 在线补装 npm 工具',
    )
  } finally {
    // 不用 process.exit(0) 掩盖残留句柄；清理和自然退出必须在宽限期内完成。
    setTimeout(() => {
      console.error('FAIL Pi/lens: session shutdown 或进程自然退出超过 15 秒')
      process.exit(1)
    }, 15_000).unref()
    try {
      // SDK dispose 不负责发出宿主的退出事件，显式覆盖扩展清理流程。
      await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' })
    } finally {
      session?.dispose()
    }
  }
  assert.deepEqual(errors, [], '扩展生命周期不能静默失败')
}

// 扩展可能安装全局异常处理器，验收失败仍须返回非零状态。
await verify().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
