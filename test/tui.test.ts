// @env node
import { describe, expect, it } from 'bun:test'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { serveWeb, terminalProxyConfig } from '../src/chat/web-server.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { fixture, testEnvironment, waitFor } from './helpers.ts'

describe('独立终端边界', () => {
  it('只公开代理端口，页面和 WebSocket 都先经过 pi-web 的认证路由', () => {
    const config = terminalProxyConfig('127.0.0.1', 30141, 30142, 30143)
    expect(config).toContain('http://:30141')
    expect(config).toContain('bind 127.0.0.1')
    expect(config).toContain('handle /tui/*')
    expect(config).toContain('forward_auth 127.0.0.1:30142')
    expect(config).toContain('uri /api/workbot-terminal/auth')
    expect(config.indexOf('forward_auth')).toBeLessThan(
      config.indexOf('reverse_proxy 127.0.0.1:30143'),
    )
    expect(config).toContain('header_up -Cookie')
    expect(config).toContain('header_up -Authorization')
    expect(config).toContain('admin off')
  })

  it('拒绝将监听配置注入 Caddy 配置', () => {
    expect(() => terminalProxyConfig('localhost\nadmin :2019', 30141, 30142, 30143)).toThrow()
    expect(() => terminalProxyConfig('127.0.0.1', NaN, 30142, 30143)).toThrow()
    expect(() => terminalProxyConfig('127.0.0.1', 30141, 0, 30143)).toThrow()
  })

  it('未设置 pi-web 密码时不启动终端服务', async () => {
    delete process.env.PI_WEB_PASSWORD
    await expect(serveWeb()).rejects.toThrow('必须设置 PI_WEB_PASSWORD')
  })

  it('TUI 模式的 Web 使用 Bun，但不替换 Shell 中的 Node', async () => {
    const config = await fixture()
    const cwd = config.workspace
    const ready = join(cwd, 'ready')
    await Bun.write(
      join(cwd, 'node_modules/next/dist/bin/next'),
      Bun.file(join(ROOT, 'test/fixtures/web-server.ts')),
    )
    // 只替代代理和传输进程；实际执行 Web supervisor 及其 Next 启动链。
    for (const name of ['ttyd', 'caddy']) {
      const binary = join(cwd, 'bin', name)
      await Bun.write(binary, '#!/bin/sh\nexec sleep 30\n')
      await chmod(binary, 0o755)
    }
    const child = Bun.spawn([process.execPath, join(ROOT, 'src/chat/web-server.ts')], {
      cwd,
      env: testEnvironment({
        PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: config.piDir,
        PI_WEB_PASSWORD: 'fixture-only',
        WORKBOT_TEST_READY: ready,
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = new Response(child.stderr).text()
    try {
      await waitFor('TUI 模式 Web 启动', async () => {
        if (child.exitCode !== null) throw new Error(await stderr)
        return Bun.file(ready).exists()
      })
      expect(await Bun.file(ready).json()).toEqual({ piDir: config.piDir, bun: true, node: true })
    } finally {
      child.kill('SIGTERM')
      await child.exited
    }
  })

  it('启动器替换自身，使用新环境、删除旧值且不传递 Web 密码', async () => {
    const config = await fixture()
    const snapshot = join(config.piDir, 'env.json')
    const report = join(config.piDir, 'report.json')
    const value = '新凭证 $() ; "quote"\nsecond line'
    await Bun.write(
      snapshot,
      JSON.stringify({
        WORKBOT_TEST_REPORT: report,
        WORKBOT_TEST_VALUE: value,
        PI_WEB_PASSWORD: 'must-not-reach-pi',
      }),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        join(ROOT, 'src/chat/tui-launch.ts'),
        snapshot,
        join(ROOT, 'test/fixtures/tui-launch-probe.ts'),
        '/session with spaces.jsonl',
      ],
      {
        env: testEnvironment({
          WORKBOT_TEST_VALUE: 'stale',
          WORKBOT_TEST_REMOVED: 'stale',
          PI_WEB_PASSWORD: 'also-excluded',
          TERM: 'tmux-256color',
          TMUX_PANE: '%1',
        }),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    expect(await Bun.file(report).json()).toEqual({
      pid: child.pid,
      args: [
        '--session',
        '/session with spaces.jsonl',
        '--extension',
        join(ROOT, 'src/chat/tui-session.ts'),
      ],
      value,
      passwordPresent: false,
      term: 'tmux-256color',
      pane: '%1',
      clipboard: '1',
    })
    expect(await Bun.file(snapshot).exists()).toBe(false)
  })

  it.each(['null', '[]', '{"TOKEN":123}', '{broken'])(
    '拒绝无效环境快照 %s 并删除文件',
    async (value) => {
      const config = await fixture()
      const snapshot = join(config.piDir, 'env.json')
      await Bun.write(snapshot, value)
      const child = Bun.spawn(
        [process.execPath, join(ROOT, 'src/chat/tui-launch.ts'), snapshot, 'unused', 'unused'],
        {
          env: testEnvironment(),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      expect(await child.exited).not.toBe(0)
      expect(await Bun.file(snapshot).exists()).toBe(false)
    },
  )

  it('attach 只接受固定长度的会话摘要，不能执行 URL 中的路径、选项或命令', async () => {
    const config = await fixture()
    const env = testEnvironment({ WORKBOT_TMUX_SOCKET: join(config.piDir, 'missing.sock') })
    for (const args of [
      [],
      ['-L'],
      ['a'.repeat(31)],
      ['../../file'],
      ['a'.repeat(32), 'sh'],
      ['a'.repeat(32) + ';touch /tmp/not-allowed'],
    ]) {
      const child = Bun.spawn([join(ROOT, 'bin/workbot-tui-attach'), ...args], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await child.exited).toBe(64)
    }
  })
})
