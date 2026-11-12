// @env node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Environment, Role, Runtime } from '../src/runtime/types.ts'

const directories: string[] = []
export async function cleanFixtures(): Promise<void> {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

export function testEnvironment(overrides: Environment = {}): Environment {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...overrides,
  }
}

export async function waitFor(
  description: string,
  check: () => boolean | Promise<boolean>,
  options: { timeout?: number; diagnostics?: () => string | Promise<string> } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeout ?? 3_000)
  while (!(await check())) {
    if (Date.now() >= deadline) {
      const details = await options.diagnostics?.()
      throw new Error(`等待超时：${description}${details ? `\n${details}` : ''}`)
    }
    await Bun.sleep(20)
  }
}

export async function fixture(role: Role = 'chat'): Promise<Runtime> {
  const dir = await mkdtemp(join(tmpdir(), 'workbot-'))
  directories.push(dir)
  const configSource = join(dir, 'preset')
  const sharedSource = join(dir, 'shared')
  await mkdir(sharedSource)
  process.env.HOME = join(dir, 'home')
  process.env.PI_OFFLINE = '1'
  process.env.PI_TELEMETRY = '0'
  const projectsFile = join(dir, 'projects.json')
  await Bun.write(projectsFile, '[]')
  await Bun.write(
    join(configSource, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'fixture',
      defaultModel: 'fixture',
      defaultThinkingLevel: 'high',
      npmCommand: ['bun'],
      ...(role === 'chat'
        ? { 'pi-channels': { adapters: {}, bridge: { enabled: true, persistSessions: false } } }
        : {}),
    }),
  )
  await Bun.write(join(configSource, 'AGENTS.md'), `# Workbot ${role} 工作约定\n仅本机测试。\n`)
  return {
    role,
    piDir: join(dir, 'pi'),
    workspace: join(dir, 'workspace'),
    configSource,
    sharedSource,
    projectsFile,
  }
}
