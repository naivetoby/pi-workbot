// @env node
import piChannels, { loadChannelConfig } from '@amaster.ai/pi-channels'
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withShutdown } from '../runtime/process.ts'
import { startWeb, stopWeb } from './web.ts'
import type { Runtime } from '../runtime/types.ts'

export interface ChannelStatus {
  ok: boolean
  bridgeActive: boolean
  items: { name: string; type: string; direction?: string }[]
}

export function channelsReady(names: string[], status: ChannelStatus): boolean {
  return (
    status.ok &&
    status.bridgeActive &&
    names.length > 0 &&
    names.every((name) =>
      status.items.some(
        (item) =>
          item.name === name && item.type === 'adapter' && item.direction === 'bidirectional',
      ),
    )
  )
}

export async function chat(config: Runtime): Promise<void> {
  const healthy = join(config.piDir, '../healthy')
  await rm(healthy, { force: true })
  const cwd = config.workspace
  const settings = await Bun.file(join(config.piDir, 'settings.json')).json()
  for (const name of Object.keys(settings['pi-channels']?.adapters ?? {})) {
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name))
      throw new Error(`无效的 IM adapter 名称：${name}`)
  }
  for (const [channel, id, secret] of [
    ['飞书', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
    ['企业微信', 'WECOM_BOT_ID', 'WECOM_BOT_SECRET'],
  ] as const) {
    const hasId = Boolean(process.env[id]?.trim())
    const hasSecret = Boolean(process.env[secret]?.trim())
    if (hasId !== hasSecret)
      console.warn(`${channel}凭证不完整：需同时配置 ${id} 和 ${secret}，本次不启动该渠道。`)
  }
  // 与插件共用有效配置，健康检查只等待实际启用的渠道。
  const names = Object.keys(loadChannelConfig(cwd).adapters ?? {})
  const events = createEventBus()
  const settingsManager = SettingsManager.create(cwd, config.piDir)
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: config.piDir,
    settingsManager,
    eventBus: events,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // 无有效渠道时不加载插件，也不建立平台连接。
    extensionFactories: names.length ? [piChannels] : [],
  })
  await loader.reload()
  const { session } = await createAgentSession({
    cwd,
    agentDir: config.piDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: 'all',
  })
  let extensionFailed = false
  try {
    await withShutdown(async (signal) => {
      await session.bindExtensions({
        mode: 'print',
        onError: (error) => {
          extensionFailed = true
          console.error(error)
        },
      })
      if (!signal.aborted && process.env.WORKBOT_WEB_AUTOSTART === '1')
        console.log(await startWeb(config))
      const probe = async (): Promise<void> => {
        // 无 IM 时只检查宿主初始化；Web 仍可按需开启，不纳入渠道健康检查。
        let ready = !extensionFailed && names.length === 0
        if (names.length)
          events.emit('channel:status', {
            callback: (status: ChannelStatus) => {
              ready = !extensionFailed && channelsReady(names, status)
            },
          })
        if (ready) await Bun.write(healthy, new Date().toISOString())
        else await rm(healthy, { force: true })
      }
      await probe()
      const heartbeat = setInterval(() => void probe().catch(console.error), 10_000)
      try {
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          )
      } finally {
        clearInterval(heartbeat)
      }
    })
  } finally {
    await rm(healthy, { force: true })
    await stopWeb(config)
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    session.dispose()
    events.clear()
  }
}
