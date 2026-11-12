// @env node
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { projectSpecs } from '../src/gitlab/repository.ts'
import { initialize } from '../src/runtime/init.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { fixture } from './helpers.ts'

interface StandaloneCompose {
  services: {
    chat: {
      image: string
      build: {
        context: string
        dockerfile: string
        target: string
        pull: boolean
        args: { BASE_IMAGE: string }
      }
      pull_policy: string
      environment: string[]
      volumes: string[]
      ports: string[]
    }
  }
}

async function compose(): Promise<StandaloneCompose> {
  return Bun.YAML.parse(
    await Bun.file(join(ROOT, 'deploy/compose.yml')).text(),
  ) as StandaloneCompose
}

describe('服务器独立部署', () => {
  it('Web 密码必填、默认仅监听本机，不挂载 Docker socket 且只持久化会话', async () => {
    const chat = (await compose()).services.chat

    expect(
      chat.environment.some((entry) =>
        /^PI_WEB_PASSWORD=\$\{PI_WEB_PASSWORD:\?[^}]+\}$/.test(entry),
      ),
    ).toBe(true)
    expect(chat.ports).toHaveLength(1)
    expect(chat.ports[0]).toStartWith('${WORKBOT_WEB_BIND:-127.0.0.1}:')
    expect(chat.volumes.join('\n')).not.toContain('docker.sock')
    expect(chat.volumes).toEqual([
      'chat-sessions:/runtime/pi/sessions',
      './projects.json:/opt/workbot/configs/projects.json:ro',
      './chat/AGENTS.md:/opt/workbot/configs/chat/AGENTS.md:ro',
    ])
    const projects: unknown = await Bun.file(join(ROOT, 'deploy/projects.json')).json()
    expect(() => projectSpecs(projects)).not.toThrow()
  })

  it('个人助手约定在初始化时完整覆盖默认角色约定，不与共享约定合并', async () => {
    const config = await fixture()
    const instructions = await Bun.file(join(ROOT, 'deploy/chat/AGENTS.md')).text()
    await Bun.write(join(config.configSource, 'AGENTS.md'), instructions)
    await Bun.write(join(config.sharedSource, 'AGENTS.md'), '# 共享约定\n')

    await initialize(config)

    expect(instructions).toStartWith('# Pi Workbot 个人助手\n')
    expect(await Bun.file(join(config.piDir, 'AGENTS.md')).text()).toBe(instructions)
  })

  it('Compose 直接构建和运行 chat，每次构建拉取底座', async () => {
    const config = await compose()
    const { chat } = config.services

    expect(Object.keys(config.services)).toEqual(['chat'])
    expect(chat.image).toBe('pi-workbot/chat:local')
    expect(chat.pull_policy).toBe('never')
    expect(chat.build).toEqual({
      context: '..',
      dockerfile: 'Dockerfile',
      target: 'chat',
      pull: true,
      args: { BASE_IMAGE: '${WORKBOT_BASE_IMAGE:-naivetoby/pi-workbot-dev:latest}' },
    })
  })

  it('独立部署与 CI 共用 Dockerfile，底座可覆盖且项目清单合法', async () => {
    const source = await Bun.file(join(ROOT, 'Dockerfile')).text()
    expect(source).toContain('ARG BASE_IMAGE=naivetoby/pi-workbot-dev:latest')
    expect(source).toContain('FROM ${BASE_IMAGE} AS base')
    const projects: unknown = await Bun.file(join(ROOT, 'configs/projects.json')).json()
    expect(() => projectSpecs(projects)).not.toThrow()
    const base = source.split(' AS base\n')[1]?.split('\nFROM ')[0]
    expect(base).toMatch(/^ENV .*\bSHELL=\/bin\/bash\b/m)
    expect(base).toContain('USER vscode')
  })

  it('构建上下文排除本机配置和嵌套凭证', async () => {
    for (const path of ['.dockerignore']) {
      const patterns = (await Bun.file(join(ROOT, path)).text())
        .split('\n')
        .map((line) => line.trim())

      for (const pattern of ['deploy', '.env', '.env.*', '**/.env', '**/.env.*'])
        expect(patterns).toContain(pattern)
    }
  })

  it('环境模板凭证留空、可配置项均有透传，默认开启 Web 和 TUI', async () => {
    const lines = (await Bun.file(join(ROOT, 'deploy/.env.example')).text()).split('\n')
    const values: Record<string, string> = {}
    for (const line of lines) {
      const match = /^(\w+)=(.*)$/.exec(line)
      if (match) values[match[1]!] = match[2]!
    }
    const source = await Bun.file(join(ROOT, 'deploy/compose.yml')).text()
    const references = new Set(
      (await compose()).services.chat.environment.filter((entry) => !entry.includes('=')),
    )
    for (const match of source.matchAll(/\$\{(\w+)/g)) references.add(match[1]!)

    for (const name of references) expect(values).toHaveProperty(name)
    for (const [name, value] of Object.entries(values)) {
      expect(references.has(name)).toBe(true)
      if (/(PASSWORD|KEY|TOKEN|SECRET|BOT_URL)$/.test(name)) expect(value).toBe('')
    }
    expect(values.WORKBOT_WEB_BIND).toBe('127.0.0.1')
    expect(values.WORKBOT_WEB_AUTOSTART).toBe('1')
    expect(values.WORKBOT_TUI_ENABLED).toBe('1')
  })
})
