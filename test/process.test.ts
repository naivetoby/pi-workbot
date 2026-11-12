// @env node
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { ROOT } from '../src/runtime/paths.ts'
import { run, withShutdown } from '../src/runtime/process.ts'
import { fixture, testEnvironment, waitFor } from './helpers.ts'

describe('进程执行', () => {
  it.each(['direct', 'script'])(
    '%s 入口使用 Bun，但子进程可独立选择 Node 或 Bun',
    async (entry) => {
      const config = await fixture()
      const cwd = config.workspace
      await Bun.write(join(cwd, 'bunfig.toml'), Bun.file(join(ROOT, 'bunfig.toml')))
      await Bun.write(
        join(cwd, 'runtime-probe.ts'),
        Bun.file(join(ROOT, 'test/fixtures/runtime-probe.ts')),
      )
      await Bun.write(
        join(cwd, 'package.json'),
        JSON.stringify({ scripts: { probe: 'bun runtime-probe.ts' } }),
      )
      const args = entry === 'direct' ? ['runtime-probe.ts'] : ['run', 'probe']
      const output = await run([process.execPath, ...args], { cwd, env: testEnvironment() })
      expect(JSON.parse(output)).toEqual({ bun: true, node: true, childBun: true })
    },
  )

  it('通过 stdin 传入完整 UTF-8 正文', async () => {
    const input = '测试正文\n' + '内容'.repeat(50_000)
    expect(
      await run([process.execPath, '-e', 'process.stdout.write(await Bun.stdin.text())'], {
        input,
      }),
    ).toBe(input)
  })

  it('非零退出包含退出码和命令输出', async () => {
    await expect(
      run([process.execPath, '-e', 'console.log("检查失败"); process.exit(7)']),
    ).rejects.toThrow(/退出码 7\n检查失败/)
  })

  it('启动失败向调用方报错', async () => {
    await expect(run(['/workbot-fixture/nonexistent-command'])).rejects.toThrow()
  })

  it('取消正在运行的进程', async () => {
    const config = await fixture()
    const ready = join(config.workspace, 'ready')
    const controller = new AbortController()
    const pending = run(
      [
        process.execPath,
        '-e',
        `await Bun.write(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`,
      ],
      {
        signal: controller.signal,
      },
    )
    const result = pending.catch((error: unknown) => error)
    try {
      await waitFor('待取消进程写出 ready 文件', () => Bun.file(ready).exists())
    } finally {
      controller.abort()
      await result
    }
    expect(await result).toMatchObject({ message: '进程已取消' })
  })

  it('已取消的任务不启动命令', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      run(['/workbot-fixture/nonexistent-command'], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.each([
    { name: '成功', fail: false },
    { name: '失败', fail: true },
  ])('$name 后移除退出信号监听器', async ({ fail }) => {
    const before = ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal))
    const action = withShutdown(async (signal) => {
      expect(signal.aborted).toBe(false)
      if (fail) throw new Error('执行失败')
      return '完成'
    })
    if (fail) await expect(action).rejects.toThrow('执行失败')
    else expect(await action).toBe('完成')
    expect(['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal))).toEqual(before)
  })
})
