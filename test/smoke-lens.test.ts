// @env node
import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { smokeLens } from '../scripts/smoke-lens.ts'
import { PI_CLI, ROOT } from '../src/runtime/paths.ts'
import type { Command, RunOptions } from '../src/runtime/types.ts'
import { diagnosticsDetails, prepareLanguageFixtures } from './fixtures/lens-language-checks.ts'
import { fixture, waitFor } from './helpers.ts'

describe('角色 lens 镜像验收入口', () => {
  it.each(['chat', 'code'] as const)(
    '%s 在隔离子进程使用角色资源，随后验证 --print 退出并清理目录',
    async (role) => {
      process.env.OPENAI_RELAY_BASE_URL = 'https://not-for-smoke.invalid/v1'
      process.env.OPENAI_RELAY_API_KEY = 'not-for-smoke'
      process.env.DEEPSEEK_API_KEY = 'not-for-smoke'
      process.env.GITLAB_TOKEN = 'not-for-smoke'
      process.env.PI_LENS_HOME = '/not-for-smoke'
      if (role === 'code') {
        process.env.PI_LENS_DISABLE_LSP_INSTALL = '1'
        process.env.PI_LENS_DISABLE_TOOL_INSTALL = '1'
      }
      const calls: { args: string[]; options: RunOptions }[] = []
      const command: Command = async (args, options = {}) => {
        calls.push({ args, options })
        return ''
      }

      await smokeLens(role, command)

      const settings = await Bun.file(join(ROOT, 'configs', role, 'settings.json')).json()
      expect(calls.map((call) => call.args)).toEqual([
        [process.execPath, join(ROOT, 'test/fixtures/lens-session.ts'), role],
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
      ])
      const options = calls[0]!.options
      expect(options.env).toMatchObject({
        WORKBOT_ROLE: role,
        OPENAI_RELAY_BASE_URL: 'https://relay.example.invalid/v1',
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
        PI_LENS_DISABLE_LSP_INSTALL: '1',
        PI_LENS_DISABLE_TOOL_INSTALL: '1',
        PI_CHANNELS_DISABLE_SESSION_AUTOSTART: '1',
      })
      expect(options.env?.OPENAI_RELAY_API_KEY).toBeUndefined()
      expect(options.env?.DEEPSEEK_API_KEY).toBeUndefined()
      expect(options.env?.GITLAB_TOKEN).toBeUndefined()
      expect(options.env?.PI_LENS_HOME).not.toBe('/not-for-smoke')
      expect(options.env?.HOME).not.toBe(process.env.HOME)
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(options.signal?.aborted).toBe(false)
      expect(calls[1]?.options).toBe(options)
      expect(existsSync(dirname(options.env!.HOME!))).toBe(false)
      expect(process.env.PI_LENS_HOME).toBe('/not-for-smoke')
      expect(process.env.PI_LENS_DISABLE_LSP_INSTALL).toBe(role === 'code' ? '1' : undefined)
    },
  )

  it('诊断子进程失败时不继续运行 CLI，失败向上传递且清理临时目录', async () => {
    const calls: RunOptions[] = []
    const command: Command = async (_args, options = {}) => {
      calls.push(options)
      throw new Error('diagnostic failed')
    }

    await expect(smokeLens('chat', command)).rejects.toThrow('diagnostic failed')

    expect(calls).toHaveLength(1)
    expect(existsSync(dirname(calls[0]!.env!.HOME!))).toBe(false)
  })

  it('取消信号交给命令边界，中止后不继续 CLI 并清理目录', async () => {
    const controller = new AbortController()
    let options: RunOptions | undefined
    let calls = 0
    const command: Command = async (_args, received) => {
      calls++
      options = received
      received!.signal!.throwIfAborted()
      return new Promise((_resolve, reject) => {
        received!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        })
      })
    }
    const outcome = smokeLens('chat', command, controller.signal).catch((error: unknown) => error)
    try {
      await waitFor('诊断子进程启动', () => Boolean(options), {
        diagnostics: () => `calls=${calls}`,
      })
    } finally {
      controller.abort()
      await outcome
    }

    expect(await outcome).toMatchObject({ message: 'cancelled' })
    expect(calls).toBe(1)
    expect(options!.signal!.aborted).toBe(true)
    expect(existsSync(dirname(options!.env!.HOME!))).toBe(false)
  })

  it('拒绝缺少禁装策略的 code 和继承了禁装策略的 chat', async () => {
    let called = false
    const command: Command = async () => {
      called = true
      return ''
    }
    await expect(smokeLens('code', command)).rejects.toThrow('code 安装策略不符')
    process.env.PI_LENS_DISABLE_LSP_INSTALL = '1'
    await expect(smokeLens('chat', command)).rejects.toThrow('chat 安装策略不符')
    expect(called).toBe(false)
  })
})

describe('LSP 验收样例与结果校验', () => {
  it('准备自包含的错误项目，不依赖业务 Maven/npm 包或真实 GitLab', async () => {
    const config = await fixture()
    const cwd = dirname(config.projectsFile)

    prepareLanguageFixtures(cwd)

    expect(await Bun.file(join(cwd, 'typed.ts')).text()).toContain('number = "bad"')
    expect(await Bun.file(join(cwd, 'java/src/Main.java')).text()).toContain('int value = "bad"')
    expect(await Bun.file(join(cwd, 'java/.project')).text()).toContain(
      'org.eclipse.jdt.core.javanature',
    )
    expect(await Bun.file(join(cwd, 'package.json')).json()).toEqual({
      private: true,
      type: 'module',
    })
  })

  it('不把空结果、缓存文本、缺少统计或错误形状当作有效诊断', () => {
    const clean = {
      diagnostics: [],
      primaryDiagnosticsCount: 0,
      cleanFiles: 1,
      totalDiagnostics: 0,
      outcomeCounts: { clean: 1 },
    }
    expect(diagnosticsDetails(clean)).toEqual(clean)
    for (const invalid of [
      null,
      'No diagnostics',
      {},
      { diagnostics: [] },
      { ...clean, diagnostics: [null] },
      { ...clean, diagnostics: ['error'] },
      { ...clean, totalDiagnostics: '0' },
      { ...clean, outcomeCounts: { clean: '1' } },
    ])
      expect(diagnosticsDetails(invalid)).toBeUndefined()
  })
})
