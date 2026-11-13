// @env node
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { stopWeb, webPid } from '../src/chat/web.ts'
import { ROOT } from '../src/runtime/paths.ts'
import type { Environment } from '../src/runtime/types.ts'
import { fixture, testEnvironment, waitFor } from './helpers.ts'

async function startHost(
  options: {
    autostart?: string
    built?: boolean
    im?: 'empty' | 'omitted' | 'supported'
    credentials?: Environment
    channelError?: boolean
  } = {},
) {
  const config = await fixture()
  const root = join(config.piDir, '..')
  const source = join(root, 'web-source')
  const ready = join(root, 'web-ready')
  const shutdown = join(root, 'session-shutdown')
  const healthy = join(root, 'healthy')
  const extensions = join(root, 'host-extensions')
  await Bun.write(
    join(config.piDir, 'settings.json'),
    JSON.stringify(
      options.im === 'omitted'
        ? {}
        : {
            'pi-channels': {
              adapters:
                options.im === 'empty'
                  ? {}
                  : options.im === 'supported'
                    ? { feishu: { type: 'feishu' }, wecom: { type: 'wecom' } }
                    : { fixture: { type: 'fixture' } },
            },
          },
    ),
  )
  if (options.built !== false) await Bun.write(join(source, '.next/BUILD_ID'), 'fixture')
  await Bun.write(
    join(source, 'node_modules/next/dist/bin/next'),
    Bun.file(join(ROOT, 'test/fixtures/web-server.ts')),
  )
  const driver = join(ROOT, 'test/fixtures/chat-host.ts')
  const stderrPath = join(root, 'host.stderr')
  const child = Bun.spawn([process.execPath, driver, JSON.stringify(config), shutdown], {
    cwd: root,
    env: testEnvironment({
      PI_CODING_AGENT_DIR: config.piDir,
      WORKBOT_WEB_DIR: source,
      WORKBOT_WEB_AUTOSTART: options.autostart,
      WORKBOT_TEST_READY: ready,
      WORKBOT_TEST_CHANNEL_ERROR: options.channelError ? '1' : undefined,
      // 不完整的残留凭证不能自动开启渠道。
      FEISHU_APP_ID: options.im !== 'supported' && options.im ? 'unused-fixture' : undefined,
      WECOM_BOT_SECRET: options.im !== 'supported' && options.im ? 'unused-fixture' : undefined,
      ...options.credentials,
    }),
    stdout: 'ignore',
    stderr: Bun.file(stderrPath),
  })
  const diagnostics = async () =>
    `host exit=${child.exitCode}\n${await Bun.file(stderrPath).text()}`
  const cleanup = async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
    await stopWeb(config)
  }
  return { config, child, ready, healthy, extensions, shutdown, stderrPath, diagnostics, cleanup }
}

describe('chat Web 自动启动', () => {
  for (const value of [undefined, '0', '1']) {
    it(`WORKBOT_WEB_AUTOSTART=${value ?? '未设置'}，退出时清理 Web 和会话`, async () => {
      const host = await startHost({ autostart: value })
      try {
        await waitFor('chat host 健康标记', () => Bun.file(host.healthy).exists(), {
          timeout: 5_000,
          diagnostics: host.diagnostics,
        })
        expect(await Bun.file(host.extensions).text()).toBe('1')
        if (value === '1') {
          await waitFor('Web 子进程就绪', () => Bun.file(host.ready).exists(), {
            diagnostics: host.diagnostics,
          })
          expect(await webPid(host.config)).toBeNumber()
        } else {
          expect(await webPid(host.config)).toBeUndefined()
          expect(await Bun.file(host.ready).exists()).toBe(false)
        }
        host.child.kill('SIGTERM')
        expect(await host.child.exited).toBe(0)
        expect(await webPid(host.config)).toBeUndefined()
        expect(await Bun.file(host.healthy).exists()).toBe(false)
        expect(await Bun.file(host.shutdown).text()).toBe('done')
      } finally {
        await host.cleanup()
      }
    }, 15_000)
  }

  for (const im of ['empty', 'omitted'] as const) {
    for (const autostart of [undefined, '1']) {
      it(`IM 配置 ${im}、Web 自动启动 ${autostart ?? '关闭'} 时可健康启动和退出`, async () => {
        const host = await startHost({ im, autostart })
        try {
          await waitFor('无 IM 宿主健康标记', () => Bun.file(host.healthy).exists(), {
            timeout: 5_000,
            diagnostics: host.diagnostics,
          })
          expect(host.child.exitCode).toBeNull()
          expect(await Bun.file(host.extensions).text()).toBe('0')
          if (autostart === '1') {
            await waitFor('仅 Web 子进程就绪', () => Bun.file(host.ready).exists(), {
              diagnostics: host.diagnostics,
            })
            expect(await webPid(host.config)).toBeNumber()
          } else {
            expect(await webPid(host.config)).toBeUndefined()
          }

          host.child.kill('SIGTERM')
          expect(await host.child.exited).toBe(0)
          expect(await Bun.file(host.healthy).exists()).toBe(false)
          expect(await webPid(host.config)).toBeUndefined()
          expect(await Bun.file(host.shutdown).text()).toBe('done')
        } finally {
          await host.cleanup()
        }
      }, 15_000)
    }
  }

  it.each([
    { label: '凭证均未设置', credentials: {}, names: [], warning: false },
    {
      label: '飞书凭证完整',
      credentials: { FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: 'fixture-secret' },
      names: ['feishu'],
      warning: false,
    },
    {
      label: '飞书不完整不影响企微',
      credentials: {
        FEISHU_APP_SECRET: 'fixture-private-secret',
        WECOM_BOT_ID: 'fixture-bot',
        WECOM_BOT_SECRET: 'fixture-wecom-secret',
      },
      names: ['wecom'],
      warning: true,
    },
  ])(
    '$label - 只等待有效渠道，不因跳过渠道阻塞健康检查',
    async ({ credentials, names, warning }) => {
      const host = await startHost({ im: 'supported', credentials })
      try {
        await waitFor('凭证筛选后的宿主健康标记', () => Bun.file(host.healthy).exists(), {
          timeout: 5_000,
          diagnostics: host.diagnostics,
        })
        expect(await Bun.file(join(host.config.piDir, '../host-channel-names')).json()).toEqual(
          names,
        )
        expect(await Bun.file(host.extensions).text()).toBe(names.length ? '1' : '0')
        const stderr = await Bun.file(host.stderrPath).text()
        expect(stderr.includes('凭证不完整')).toBe(warning)
        expect(stderr).not.toContain('fixture-private')
        expect(stderr).not.toContain('fixture-wecom-secret')
        host.child.kill('SIGTERM')
        expect(await host.child.exited).toBe(0)
      } finally {
        await host.cleanup()
      }
    },
  )

  it('凭证完整的渠道初始化失败时不产生健康标记', async () => {
    const host = await startHost({
      autostart: '1',
      im: 'supported',
      credentials: { FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: 'fixture-secret' },
      channelError: true,
    })
    try {
      await waitFor('渠道失败后 Web 子进程就绪', () => Bun.file(host.ready).exists(), {
        diagnostics: host.diagnostics,
      })
      expect(host.child.exitCode).toBeNull()
      expect(await Bun.file(host.healthy).exists()).toBe(false)
      expect(await Bun.file(host.stderrPath).text()).toContain('fixture channel failed')
      host.child.kill('SIGTERM')
      expect(await host.child.exited).toBe(0)
      expect(await Bun.file(host.healthy).exists()).toBe(false)
    } finally {
      await host.cleanup()
    }
  }, 15_000)

  it.each(['configured', 'empty'] as const)(
    'IM 配置 %s、显式开启但缺少 Web 构建时报告错误并清理会话',
    async (im) => {
      const host = await startHost({
        autostart: '1',
        built: false,
        im: im === 'configured' ? undefined : im,
      })
      try {
        expect(await host.child.exited).toBe(1)
        expect(await Bun.file(host.stderrPath).text()).toContain('bun run build:web')
        expect(await webPid(host.config)).toBeUndefined()
        expect(await Bun.file(host.healthy).exists()).toBe(false)
        expect(await Bun.file(host.shutdown).text()).toBe('done')
      } finally {
        await host.cleanup()
      }
    },
    15_000,
  )

  it('Compose 显式透传开关，不强制默认开启', async () => {
    const compose = Bun.YAML.parse(await Bun.file(join(ROOT, 'compose.yml')).text()) as {
      services: { chat: { environment: string[] } }
    }
    expect(compose.services.chat.environment).toContain('WORKBOT_WEB_AUTOSTART')
    expect(compose.services.chat.environment).not.toContain('WORKBOT_WEB_AUTOSTART=1')
  })
})
