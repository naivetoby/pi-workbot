// @env node
import { describe, expect, it } from 'bun:test'
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { preparePi } from '../scripts/prepare-pi.ts'
import { initialize } from '../src/runtime/init.ts'
import { run } from '../src/runtime/process.ts'
import { fixture } from './helpers.ts'

describe('Pi 资源准备', () => {
  it('安装包并复制到运行目录后可离线发现，准备阶段只解析资源', async () => {
    const config = await fixture()
    config.configSource = join(config.piDir, '../preset')
    const packageDir = join(config.piDir, '../package')
    const archive = join(config.piDir, '../fixture.tgz')
    await Bun.write(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'local-pi-fixture',
        version: '1.0.0',
        type: 'module',
        pi: { extensions: ['index.js'] },
      }),
    )
    await Bun.write(join(packageDir, 'index.js'), 'throw new Error("资源准备不应执行插件代码")\n')
    await run(['tar', '-czf', archive, '-C', packageDir, '.'])
    const source = `npm:local-pi-fixture@file:${archive}`
    await Bun.write(
      join(config.configSource, 'settings.json'),
      JSON.stringify({
        npmCommand: ['bun'],
        packages: [source],
      }),
    )
    process.env.PI_OFFLINE = '1'
    await preparePi(config.configSource, true)
    const lock = Bun.file(join(config.configSource, 'npm/bun.lock'))
    const before = await lock.text()
    await rm(join(config.configSource, 'npm/node_modules'), { recursive: true, force: true })
    await preparePi(config.configSource)
    expect(await lock.text()).toBe(before)
    expect(process.env.PI_OFFLINE).toBe('1')
    await initialize(config)
    const settingsManager = SettingsManager.create(config.workspace, config.piDir, {
      projectTrusted: false,
    })
    const packages = new DefaultPackageManager({
      cwd: config.workspace,
      agentDir: config.piDir,
      settingsManager,
    })
    const paths = await packages.resolve()
    expect(paths.extensions.some((item) => item.path.includes('local-pi-fixture'))).toBe(true)
    const installed = packages.getInstalledPath(source, 'user')!
    expect(installed.startsWith(config.piDir)).toBe(true)
    expect((await Bun.file(join(installed, 'package.json')).json()).version).toBe('1.0.0')
  }, 15_000)

  it('普通构建缺少锁文件时失败，不隐式生成依赖基线', async () => {
    const config = await fixture()
    await Bun.write(
      join(config.configSource, 'settings.json'),
      JSON.stringify({
        npmCommand: ['bun'],
        packages: ['npm:local-pi-fixture@1.0.0'],
      }),
    )
    await expect(preparePi(config.configSource)).rejects.toThrow('缺少插件锁文件')
    expect(await Bun.file(join(config.configSource, 'npm/package.json')).exists()).toBe(false)
  })

  it('settings 与安装清单不一致时要求显式更新，不覆盖原文件', async () => {
    const config = await fixture()
    await Bun.write(
      join(config.configSource, 'settings.json'),
      JSON.stringify({
        npmCommand: ['bun'],
        packages: ['npm:local-pi-fixture@1.0.0'],
      }),
    )
    const manifest = join(config.configSource, 'npm/package.json')
    await Bun.write(manifest, '{"dependencies":{}}')
    await Bun.write(join(config.configSource, 'npm/bun.lock'), '{}')
    await expect(preparePi(config.configSource)).rejects.toThrow('不一致')
    expect(await Bun.file(manifest).text()).toBe('{"dependencies":{}}')
  })

  it('设置 JSON 无效时报告错误并保留原文件', async () => {
    const config = await fixture()
    config.configSource = join(config.piDir, '../invalid')
    await Bun.write(join(config.configSource, 'settings.json'), '{broken')
    await expect(preparePi(config.configSource)).rejects.toThrow('Pi 配置读取失败')
    expect(await Bun.file(join(config.configSource, 'settings.json')).text()).toBe('{broken')
  })
})
