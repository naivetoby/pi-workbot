// @env node
import { cp, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { projectSpecs, repository } from '../gitlab/repository.ts'
import { applyRuntime } from './config.ts'
import { BRIDGE_BIN, ROOT } from './paths.ts'
import { run } from './process.ts'
import type { Command, Runtime } from './types.ts'

export async function initialize(config: Runtime, command: Command = run): Promise<void> {
  applyRuntime(config)
  await mkdir(config.piDir, { recursive: true })
  await mkdir(config.workspace, { recursive: true })
  const marker = join(config.piDir, '.workbot-initialized')
  if (!(await Bun.file(marker).exists())) {
    await cp(config.configSource, config.piDir, { recursive: true, force: false })
    // 共用静态资源只补缺；角色配置和已有在线文件优先，不做 settings 继承或合并。
    await cp(config.sharedSource, config.piDir, { recursive: true, force: false })
    await configureRelay(join(config.piDir, 'models.json'))
    if (config.role === 'chat') {
      const extensions = join(config.piDir, 'extensions')
      await mkdir(extensions, { recursive: true })
      const extension = join(extensions, 'workbot.ts')
      if (!(await Bun.file(extension).exists())) {
        await Bun.write(
          extension,
          `export { default } from ${JSON.stringify(join(ROOT, 'src/chat/extension.ts'))}\n`,
        )
      }
      const path = join(config.piDir, 'settings.json')
      const settings = await Bun.file(path).json()
      const channels = settings['pi-channels']
      if (channels) {
        channels.bridge = { ...channels.bridge, piBin: BRIDGE_BIN }
        await Bun.write(path, JSON.stringify(settings, null, 2) + '\n')
      }
    }
    await Bun.write(marker, `${config.configSource}\n`)
  }
  const entries = projectSpecs(await Bun.file(config.projectsFile).json())
  const paths: string[] = []
  for (const entry of entries) paths.push(await repository(entry, config.workspace, command))
  const instructions = join(config.workspace, 'AGENTS.md')
  if (!(await Bun.file(instructions).exists())) {
    await Bun.write(
      instructions,
      [
        '# Pi 研发工作区',
        '',
        '各仓库使用自己的 AGENTS.md、工具链和检查约定，工作前先阅读。',
        ...entries.map((entry, index) => `- ${entry.project}：${paths[index]}`),
        '',
      ].join('\n'),
    )
  }
}

async function configureRelay(path: string): Promise<void> {
  const file = Bun.file(path)
  if (!(await file.exists())) return
  const models: unknown = await file.json()
  if (!models || typeof models !== 'object' || !('providers' in models)) return
  const providers = models.providers
  if (!providers || typeof providers !== 'object' || !('openai-relay' in providers)) return
  const relay = providers['openai-relay']
  if (!relay || typeof relay !== 'object' || !('baseUrl' in relay)) return
  if (relay.baseUrl !== '${OPENAI_RELAY_BASE_URL}') return

  // Pi 1.5.2 不展开 baseUrl；只处理此模板，未配置时不启用中转，不影响其他模型。
  const baseUrl = process.env.OPENAI_RELAY_BASE_URL?.trim()
  if (!baseUrl) {
    Reflect.deleteProperty(providers, 'openai-relay')
  } else {
    const url = URL.parse(baseUrl)
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('OPENAI_RELAY_BASE_URL 必须为不含凭证的 HTTP(S) 地址')
    relay.baseUrl = baseUrl
  }
  await Bun.write(path, JSON.stringify(models, null, 2) + '\n')
}

export function configLabel(config: Runtime): string {
  return `${config.role}: ${basename(config.configSource)} → ${config.piDir}`
}
