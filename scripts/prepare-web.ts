// @env node
import { createHash } from 'node:crypto'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { ROOT, WEB_COMMIT, WEB_DIR } from '../src/runtime/paths.ts'
import { run } from '../src/runtime/process.ts'

async function step<T>(label: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now()
  console.log(`[pi-web] ${label}…`)
  try {
    const result = await action()
    console.log(`[pi-web] ${label}完成 (${((performance.now() - started) / 1000).toFixed(1)}s)`)
    return result
  } catch (error) {
    console.error(`[pi-web] ${label}失败 (${((performance.now() - started) / 1000).toFixed(1)}s)`)
    throw error
  }
}

export async function prepareWeb(build = false, test = build): Promise<void> {
  const patch = join(ROOT, 'web/pi-web-bun.patch')
  const lock = join(ROOT, 'web/bun.lock')
  const archive = join(ROOT, 'web', `pi-web-${WEB_COMMIT}.tar.gz`)
  const archiveHash = await step('校验本地源码包 SHA-256', async () => {
    if (!(await Bun.file(archive).exists())) throw new Error(`缺少本地 pi-web 源码包：${archive}`)
    const expected = (await Bun.file(`${archive}.sha256`).text()).trim().split(/\s+/)[0]
    const actual = createHash('sha256')
      .update(await Bun.file(archive).bytes())
      .digest('hex')
    if (actual !== expected) throw new Error(`pi-web 源码包 SHA-256 校验失败：${archive}`)
    return actual
  })
  const revision = `${WEB_COMMIT}:${archiveHash}:${Bun.hash((await Bun.file(patch).text()) + (await Bun.file(lock).text())).toString(16)}`
  const stamp = join(WEB_DIR, '.workbot-source')
  const current = (await Bun.file(stamp).exists()) ? await Bun.file(stamp).text() : ''
  if (current !== revision) {
    await rm(WEB_DIR, { recursive: true, force: true })
    await mkdir(WEB_DIR, { recursive: true })
    await step('解压本地源码', () =>
      run(['tar', '-xzf', archive, '--strip-components=1', '-C', WEB_DIR]),
    )
    // 从项目根目录指定补丁目标，避免 Git 在仓库子目录中跳过所有文件。
    const directory = `--directory=${relative(ROOT, WEB_DIR)}`
    await run(['git', 'apply', directory, '--check', patch], { cwd: ROOT })
    await run(['git', 'apply', directory, patch], { cwd: ROOT })
    await cp(lock, join(WEB_DIR, 'bun.lock'))
    await Bun.write(stamp, revision)
  }
  await cp(join(ROOT, 'web/fonts'), join(WEB_DIR, 'app/fonts'), { recursive: true })
  await step('安装 Web 依赖（使用项目 bunfig.toml 镜像配置）', () =>
    run(
      [
        process.execPath,
        'install',
        `--config=${join(ROOT, 'bunfig.toml')}`,
        '--frozen-lockfile',
        '--ignore-scripts',
      ],
      { cwd: WEB_DIR, inherit: true },
    ),
  )
  if (test) {
    await step('Workbot Web 补丁测试', () =>
      run(
        [
          process.execPath,
          'test',
          '--config=/dev/null',
          './components/WorkbotTerminalAccess.test.mjs',
          './lib/workbot-origin.test.mjs',
          './lib/workbot-terminal-touch.test.mjs',
          './lib/workbot-terminal-input.test.mjs',
          './lib/workbot-terminal-theme.test.mjs',
        ],
        {
          cwd: WEB_DIR,
          inherit: true,
          // 不继承主项目 bunfig 的 test.root/preload，也不提供业务凭证。
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            PI_OFFLINE: '1',
            PI_TELEMETRY: '0',
          },
        },
      ),
    )
  }
  if (build) {
    await step('Next.js 生产编译', () =>
      run(
        [process.execPath, join(WEB_DIR, 'node_modules/next/dist/bin/next'), 'build', '--webpack'],
        {
          cwd: WEB_DIR,
          inherit: true,
          env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', PI_OFFLINE: '1' },
        },
      ),
    )
  }
  console.log(`pi-web ${WEB_COMMIT} 已准备，Bun 补丁已应用`)
}

if (import.meta.main) {
  const build = process.argv.includes('--build')
  // 显式 --test 始终执行测试；--skip-tests 只关闭构建隐含的补丁验收。
  const test = process.argv.includes('--test') || (build && !process.argv.includes('--skip-tests'))
  await prepareWeb(build, test)
}
