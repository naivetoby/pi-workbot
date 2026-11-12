// @env node
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT, WEB_COMMIT } from '../src/runtime/paths.ts'
import { run } from '../src/runtime/process.ts'
import { fixture, testEnvironment } from './helpers.ts'

interface FixtureOptions {
  failBuild?: boolean
  failTest?: boolean
  archiveState?: 'corrupt' | 'missing'
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await Bun.file(path).bytes())
    .digest('hex')
}

async function webFixture(options: FixtureOptions) {
  const config = await fixture()
  const root = join(config.piDir, '../web-build')
  const source = join(root, '.cache/pi-web')
  for (const dir of ['scripts', 'src/runtime']) await mkdir(join(root, dir), { recursive: true })
  for (const file of [
    'scripts/prepare-web.ts',
    'src/runtime/paths.ts',
    'src/runtime/process.ts',
    'src/runtime/types.ts',
  ])
    await cp(join(ROOT, file), join(root, file))

  // 最小 Next fixture：真实执行冻结安装，但不连接外网或编译上游应用。
  const version = '0.0.0-workbot-fixture'
  const pkg = join(root, 'package')
  await Bun.write(join(pkg, 'package.json'), JSON.stringify({ name: 'next', version }))
  await Bun.write(
    join(pkg, 'dist/bin/next'),
    options.failBuild
      ? 'process.exit(7)'
      : `await Bun.write('.next/BUILD_ID', JSON.stringify({ args: process.argv.slice(2), offline: process.env.PI_OFFLINE, telemetry: process.env.NEXT_TELEMETRY_DISABLED }))`,
  )
  const archive = join(root, 'next.tgz')
  await run(['tar', '-czf', archive, '-C', root, 'package'])
  const integrity = `sha512-${createHash('sha512')
    .update(await Bun.file(archive).bytes())
    .digest('base64')}`
  const lock = JSON.stringify({
    lockfileVersion: 2,
    configVersion: 0,
    workspaces: { '': { name: 'web-fixture', dependencies: { next: version } } },
    packages: { next: [`next@${version}`, '', {}, integrity] },
  })
  await Bun.write(join(root, 'web/bun.lock'), lock)
  await Bun.write(join(root, 'web/fonts/font.woff2'), 'fixture')
  const upstream = join(root, 'upstream', `pi-web-${WEB_COMMIT}`)
  await Bun.write(
    join(upstream, 'package.json'),
    JSON.stringify({ name: 'web-fixture', dependencies: { next: version } }),
  )
  await Bun.write(
    join(upstream, 'components/WorkbotTerminalAccess.test.mjs'),
    `import test from 'node:test'; import assert from 'node:assert/strict';\ntest('补丁行为 fixture', () => assert.ok(${!options.failTest}));\n`,
  )
  await Bun.write(
    join(upstream, 'lib/workbot-origin.test.mjs'),
    "import test from 'node:test'; test('来源识别 fixture', () => {});\n",
  )
  await Bun.write(
    join(upstream, 'lib/workbot-terminal-touch.test.mjs'),
    "import test from 'node:test'; test('触摸滚动 fixture', () => {});\n",
  )
  // 若没有显式加载根配置，安装将连接这个不可用的地址并失败。
  await Bun.write(join(upstream, 'bunfig.toml'), '[install]\nregistry = "http://127.0.0.1:1"\n')
  await Bun.write(join(upstream, 'fixture.txt'), 'before\n')
  await Bun.write(
    join(root, 'web/pi-web-bun.patch'),
    `diff --git a/fixture.txt b/fixture.txt
--- a/fixture.txt
+++ b/fixture.txt
@@ -1 +1 @@
-before
+after
`,
  )
  const sourceArchive = join(root, 'web', `pi-web-${WEB_COMMIT}.tar.gz`)
  await run(['tar', '-czf', sourceArchive, '-C', join(root, 'upstream'), `pi-web-${WEB_COMMIT}`])
  await Bun.write(
    `${sourceArchive}.sha256`,
    `${await sha256(sourceArchive)}  pi-web-${WEB_COMMIT}.tar.gz\n`,
  )
  if (options.archiveState) {
    // 校验失败不应清空已有源码，也不应尝试安装依赖或访问网络。
    await Bun.write(join(source, 'preserved'), 'keep')
    if (options.archiveState === 'corrupt') await Bun.write(sourceArchive, 'corrupted')
    else await rm(sourceArchive)
  }
  await Bun.write(
    join(root, 'deny-fetch.ts'),
    'globalThis.fetch = () => { throw new Error("源码准备不应访问网络") }\n',
  )
  return { root, source, archive, sourceArchive }
}

async function buildFixture(options: FixtureOptions = {}) {
  const { root, source, archive, sourceArchive } = await webFixture(options)
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      return path.endsWith('.tgz')
        ? new Response(Bun.file(archive))
        : new Response('Unexpected registry request', { status: 500 })
    },
  })
  try {
    await Bun.write(join(root, 'bunfig.toml'), `[install]\nregistry = "${server.url}"\n`)
    const execute = async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          '--preload',
          join(root, 'deny-fetch.ts'),
          join(root, 'scripts/prepare-web.ts'),
          '--build',
        ],
        {
          cwd: root,
          env: testEnvironment({ BUN_INSTALL_CACHE_DIR: join(root, 'bun-cache') }),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, code }
    }
    const result = await execute()
    const repeated = result.code === 0 ? await execute() : undefined
    return { source, sourceArchive, requests, ...result, repeated }
  } finally {
    server.stop(true)
  }
}

describe('Web 构建准备', () => {
  it('仓库源码包校验通过且可应用真实补丁', async () => {
    const archive = join(ROOT, 'web', `pi-web-${WEB_COMMIT}.tar.gz`)
    const expected = (await Bun.file(`${archive}.sha256`).text()).trim().split(/\s+/)[0]
    expect(await sha256(archive)).toBe(expected)
    const config = await fixture()
    const root = join(config.piDir, '../archive-check')
    const source = join(root, '.cache/pi-web')
    await mkdir(source, { recursive: true })
    await run(['tar', '-xzf', archive, '--strip-components=1', '-C', source])
    const patch = join(ROOT, 'web/pi-web-bun.patch')
    await run(['git', 'apply', '--directory=.cache/pi-web', '--check', patch], { cwd: root })
    await run(['git', 'apply', '--directory=.cache/pi-web', patch], { cwd: root })
    expect((await Bun.file(join(source, 'package.json')).json()).version).toBe('0.15.0')
    const webDependencies = (await Bun.file(join(source, 'package.json')).json()).dependencies
    const rootManifest = await Bun.file(join(ROOT, 'package.json')).json()
    for (const [name, version] of Object.entries(webDependencies)) {
      if (name.startsWith('@earendil-works/pi-'))
        expect(version, `${name} 必须与主项目一致`).toBe(rootManifest.overrides[name])
    }
    expect(webDependencies['@earendil-works/pi-coding-agent']).toBe(
      rootManifest.dependencies['@earendil-works/pi-coding-agent'],
    )
    expect(await Bun.file(join(source, 'app/layout.tsx')).text()).toContain('next/font/local')
    expect(await Bun.file(join(source, 'components/AppShell.tsx')).text()).toContain(
      '<WorkbotTerminalAccess key={sessionKey} session={selectedSession}',
    )
    expect(await Bun.file(join(source, 'components/WorkbotTerminalAccess.tsx')).text()).toContain(
      '仅供查看，请回到${channel}回复。',
    )
    expect(await Bun.file(join(source, 'components/WorkbotTerminalAccess.test.mjs')).exists()).toBe(
      true,
    )
    // 两个终端入口都必须挂载及清理兼容层，不能只让独立 helper 的测试通过。
    for (const component of ['TerminalPanel', 'WorkbotTui']) {
      const text = await Bun.file(join(source, `components/${component}.tsx`)).text()
      expect(text, component).toMatch(/from ['"]@\/lib\/workbot-terminal-input['"]/)
      expect(text, component).toContain('const detachInput = attachTerminalInput(terminal)')
      expect(text, component).toMatch(/detachInput\(\)[\s\S]*?terminal\.dispose\(\)/)
    }
  }, 15_000)

  it('无需下载源码即可解压、应用补丁，并使用根镜像配置安装编译', async () => {
    const result = await buildFixture()
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('校验本地源码包 SHA-256完成 (')
    expect(result.stdout).toContain('解压本地源码完成 (')
    expect(result.requests).toContain('/next/-/next-0.0.0-workbot-fixture.tgz')
    expect(result.stdout).toContain('安装 Web 依赖（使用项目 bunfig.toml 镜像配置）完成 (')
    expect(result.stdout).toContain('Next.js 生产编译完成 (')
    expect(await Bun.file(join(result.source, '.next/BUILD_ID')).json()).toEqual({
      args: ['build', '--webpack'],
      offline: '1',
      telemetry: '1',
    })
    expect(await Bun.file(join(result.source, 'app/fonts/font.woff2')).text()).toBe('fixture')
    expect(await Bun.file(join(result.source, 'fixture.txt')).text()).toBe('after\n')
    expect(await Bun.file(result.sourceArchive).exists()).toBe(true)
    expect(result.repeated?.code, result.repeated?.stderr).toBe(0)
    expect(result.repeated?.stdout).not.toContain('解压本地源码')
  }, 15_000)

  for (const archiveState of ['corrupt', 'missing'] as const) {
    it(`源码包 ${archiveState} 时明确报错并保留现有源码`, async () => {
      const result = await buildFixture({ archiveState })
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(
        archiveState === 'corrupt' ? 'SHA-256 校验失败' : '缺少本地 pi-web 源码包',
      )
      expect(result.requests).toHaveLength(0)
      expect(result.stdout).not.toContain('安装 Web 依赖')
      expect(await Bun.file(join(result.source, 'preserved')).text()).toBe('keep')
    }, 15_000)
  }

  it('补丁测试失败时阻止生产编译，而不只是检查测试文件存在', async () => {
    const result = await buildFixture({ failTest: true })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Workbot Web 补丁测试失败')
    expect(result.stdout).not.toContain('Next.js 生产编译')
    expect(await Bun.file(join(result.source, '.next/BUILD_ID')).exists()).toBe(false)
  }, 15_000)

  it('编译失败时报告失败阶段，不打印成功提示', async () => {
    const result = await buildFixture({ failBuild: true })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Next.js 生产编译失败 (')
    expect(result.stdout).not.toContain('已准备，Bun 补丁已应用')
  }, 15_000)
})
