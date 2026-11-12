// @env node
import { mock } from 'bun:test'
import { loadChannelConfig } from '@amaster.ai/pi-channels'
import { join } from 'node:path'
import type { ChannelStatus } from '../../src/chat/host.ts'
import type { Runtime } from '../../src/runtime/types.ts'

// 模块替身只存在于独立子进程，不污染测试运行器的 SDK 模块缓存。
const config = JSON.parse(process.argv[2]!) as Runtime
const shutdown = process.argv[3]!
const names = Object.keys(loadChannelConfig(config.workspace).adapters ?? {})
await Bun.write(join(config.piDir, '../host-channel-names'), JSON.stringify(names))
mock.module(import.meta.resolve('@amaster.ai/pi-channels'), () => ({
  loadChannelConfig,
  default() {},
}))
mock.module(import.meta.resolve('@earendil-works/pi-coding-agent'), () => ({
  createEventBus: () => ({
    emit(_name: string, payload: { callback: (status: ChannelStatus) => void }) {
      if (!names.length) return
      payload.callback({
        ok: true,
        bridgeActive: true,
        items: names.map((name) => ({ name, type: 'adapter', direction: 'bidirectional' })),
      })
    },
    clear() {},
  }),
  SettingsManager: { create: () => ({}) },
  DefaultResourceLoader: class {
    constructor(private options: { extensionFactories: unknown[] }) {}
    async reload() {
      await Bun.write(
        join(config.piDir, '../host-extensions'),
        String(this.options.extensionFactories.length),
      )
    }
  },
  SessionManager: { inMemory: () => ({}) },
  createAgentSession: async () => ({
    session: {
      async bindExtensions(options: { onError: (error: Error) => void }) {
        if (process.env.WORKBOT_TEST_CHANNEL_ERROR === '1')
          options.onError(new Error('fixture channel failed'))
      },
      extensionRunner: {
        async emit() {
          await Bun.write(shutdown, 'done')
        },
      },
      dispose() {},
    },
  }),
}))
const { chat } = await import('../../src/chat/host.ts')
try {
  await chat(config)
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
