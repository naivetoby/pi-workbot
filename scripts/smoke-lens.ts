// @env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PI_CLI, ROOT } from '../src/runtime/paths.ts'
import { run, withShutdown } from '../src/runtime/process.ts'
import type { Command, Environment, Role } from '../src/runtime/types.ts'

export async function smokeLens(
  role: Role,
  command: Command = run,
  signal?: AbortSignal,
): Promise<void> {
  for (const flag of ['PI_LENS_DISABLE_LSP_INSTALL', 'PI_LENS_DISABLE_TOOL_INSTALL']) {
    assert.equal(
      process.env[flag],
      role === 'code' ? '1' : undefined,
      `${role} 安装策略不符：${flag}`,
    )
  }
  const root = await mkdtemp(join(tmpdir(), `workbot-lens-${role}-`))
  const controller = new AbortController()
  let stage = 'Pi/lens 诊断（300 秒）'
  const timeout = (): void => controller.abort(new Error(`${role} ${stage}超时`))
  let timer = setTimeout(timeout, 300_000)
  try {
    const home = join(root, 'home')
    const cwd = join(root, 'workspace')
    const projects = join(root, 'projects.json')
    await mkdir(home)
    await mkdir(cwd)
    await Bun.write(projects, '[]\n')
    // 白名单隔离凭证与个人配置；在子进程启动前设置 HOME，避免 homedir 缓存。
    const env: Environment = {
      PATH: process.env.PATH,
      JAVA_HOME: process.env.JAVA_HOME,
      SDKMAN_DIR: process.env.SDKMAN_DIR,
      HOME: home,
      TMPDIR: root,
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
      OPENAI_RELAY_BASE_URL: 'https://relay.example.invalid/v1',
      PI_CODING_AGENT_DIR: join(root, 'pi'),
      PI_LENS_HOME: join(root, 'lens'),
      // chat 仅在验收子进程中禁装；不得写回角色配置或镜像 ENV。
      PI_LENS_DISABLE_LSP_INSTALL: '1',
      PI_LENS_DISABLE_TOOL_INSTALL: '1',
      PI_CHANNELS_DISABLE_SESSION_AUTOSTART: '1',
      WORKBOT_ROLE: role,
      WORKBOT_WORKSPACE: cwd,
      WORKBOT_PROJECTS_FILE: projects,
    }
    const options = {
      cwd,
      env,
      inherit: true,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    }
    await command([process.execPath, join(ROOT, 'test/fixtures/lens-session.ts'), role], options)
    clearTimeout(timer)
    stage = 'Pi --print 退出（60 秒）'
    timer = setTimeout(timeout, 60_000)
    // CLI 的占位 Key 需要显式模型；沿用角色配置，不请求模型或传入真实凭证。
    const settings: unknown = await Bun.file(join(ROOT, 'configs', role, 'settings.json')).json()
    assert(
      settings &&
        typeof settings === 'object' &&
        'defaultProvider' in settings &&
        typeof settings.defaultProvider === 'string' &&
        settings.defaultProvider.trim() &&
        'defaultModel' in settings &&
        typeof settings.defaultModel === 'string' &&
        settings.defaultModel.trim(),
      `${role} 缺少验收所需的默认 provider/model`,
    )
    await command(
      [
        process.execPath,
        PI_CLI,
        '--print',
        '--no-session',
        '--model',
        `${settings.defaultProvider}/${settings.defaultModel}`,
        '--api-key',
        'image-smoke-placeholder',
        '/lens-tools',
      ],
      options,
    )
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const role = process.argv[2]
  assert(
    role === 'chat' || role === 'code',
    '用法：bun scripts/smoke-lens.ts <chat|code>（Linux 角色镜像内）',
  )
  await withShutdown((signal) => smokeLens(role, run, signal))
  console.log(`PASS ${role}: Pi/lens diagnostics, shutdown and --print exit`)
}
