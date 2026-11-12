// @env node
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ROOT } from '../src/runtime/paths.ts'
import { run } from '../src/runtime/process.ts'

export async function preparePi(source: string, updateLock = false): Promise<void> {
  const agentDir = resolve(source)
  const settingsManager = SettingsManager.create(agentDir, agentDir, { projectTrusted: false })
  const errors = settingsManager.drainErrors()
  if (errors.length)
    throw new Error(`Pi 配置读取失败：${errors.map((error) => error.error.message).join('; ')}`)
  const dependencies: Record<string, string> = {}
  for (const entry of settingsManager.getPackages()) {
    const spec = typeof entry === 'string' ? entry : entry.source
    if (!spec.startsWith('npm:')) continue
    const match = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(spec)
    if (!match) throw new Error(`请为镜像插件指定版本：${spec}`)
    dependencies[match[1]!] = match[2]!
  }
  const npmDir = join(agentDir, 'npm')
  const manifest = Bun.file(join(npmDir, 'package.json'))
  const lock = Bun.file(join(npmDir, 'bun.lock'))
  if (updateLock) {
    await Bun.write(
      manifest,
      JSON.stringify({ name: 'pi-extensions', private: true, dependencies }, null, 2) + '\n',
    )
  } else if (Object.keys(dependencies).length || (await manifest.exists())) {
    if (!(await manifest.exists()) || !(await lock.exists()))
      throw new Error(
        '缺少插件锁文件，请运行 prepare:pi <角色目录> --update-lock 并提交 npm/package.json、npm/bun.lock',
      )
    if (!isDeepStrictEqual((await manifest.json()).dependencies, dependencies))
      throw new Error(
        'settings.packages 与 npm/package.json 不一致，请运行 prepare:pi <角色目录> --update-lock',
      )
  }
  if (await manifest.exists()) {
    // 保留 Pi 的 npm 布局和 peer 策略；普通构建不重新解析传递依赖、不执行安装脚本。
    await run(
      [
        process.execPath,
        'install',
        `--config=${join(ROOT, 'bunfig.toml')}`,
        '--ignore-scripts',
        '--omit=peer',
        ...(updateLock ? [] : ['--frozen-lockfile']),
      ],
      { cwd: npmDir, inherit: true },
    )
  }
  const offline = process.env.PI_OFFLINE
  try {
    // 只解析原生资源，不执行扩展工厂；缺失来源直接失败，禁止隐式联网补装。
    // Pi 离线模式会静默跳过缺包，因此使用显式 onMissing=error。
    process.env.PI_OFFLINE = '0'
    const packages = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager })
    await packages.resolve(async () => 'error')
  } finally {
    if (offline === undefined) delete process.env.PI_OFFLINE
    else process.env.PI_OFFLINE = offline
  }
  console.log(`Pi 资源已准备：${agentDir}${updateLock ? '（已更新锁文件，请检查并提交）' : ''}`)
}

if (import.meta.main) {
  const [source, option] = process.argv.slice(2)
  if (!source || (option !== undefined && option !== '--update-lock'))
    throw new Error('用法：bun scripts/prepare-pi.ts <原生 Pi 配置目录> [--update-lock]')
  await preparePi(source, option === '--update-lock')
}
