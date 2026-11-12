// @env node
import { describe, expect, it } from 'bun:test'
import { join, resolve } from 'node:path'
import { startWeb, stopWeb, webPid } from '../src/chat/web.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { fixture, waitFor } from './helpers.ts'

describe('Web 进程入口', () => {
  it('启动时共用 Pi 配置，重复启动复用进程，停止后可重新开启', async () => {
    const config = await fixture()
    const source = resolve(config.piDir, '../web-source')
    const ready = join(source, 'ready')
    await Bun.write(join(source, '.next/BUILD_ID'), 'fixture')
    await Bun.write(
      join(source, 'node_modules/next/dist/bin/next'),
      Bun.file(join(ROOT, 'test/fixtures/web-server.ts')),
    )
    process.env.WORKBOT_WEB_DIR = source
    process.env.WORKBOT_TEST_READY = ready
    try {
      await startWeb(config)
      const pid = await webPid(config)
      expect(pid).toBeNumber()
      await waitFor('Web fixture 写出启动环境', () => Bun.file(ready).exists(), {
        diagnostics: () => Bun.file(resolve(config.piDir, '../web.log')).text(),
      })
      expect(await Bun.file(ready).json()).toEqual({
        piDir: config.piDir,
        defaultCwd: config.workspace,
        channelsDisabled: '1',
        bun: true,
        node: true,
      })
      await startWeb(config)
      expect(await webPid(config)).toBe(pid)
      await stopWeb(config)
      expect(await webPid(config)).toBeUndefined()
      const pidFile = resolve(config.piDir, '../web.pid')
      expect(await Bun.file(pidFile).exists()).toBe(false)
      await stopWeb(config)
      await Bun.write(pidFile, String(pid))
      expect(await webPid(config)).toBeUndefined()
      await startWeb(config)
      expect(await webPid(config)).toBeNumber()
      expect(await webPid(config)).not.toBe(pid)
    } finally {
      await stopWeb(config)
    }
  })

  it('未构建时给出明确提示', async () => {
    const config = await fixture()
    process.env.WORKBOT_WEB_DIR = resolve(config.piDir, '../not-built')
    await expect(startWeb(config)).rejects.toThrow('bun run build:web')
  })

  it('code 角色不运行 Web', async () => {
    const config = await fixture('code')
    await expect(startWeb(config)).rejects.toThrow('只在 chat')
  })
})
