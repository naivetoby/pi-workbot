// @env node
import { resolve } from 'node:path'
import { ROOT } from './paths.ts'
import type { Environment, Role, Runtime } from './types.ts'

export function runtime(role: Role, env: Environment = process.env): Runtime {
  return {
    role,
    piDir: resolve(env.PI_CODING_AGENT_DIR || `${ROOT}/.runtime/${role}/pi`),
    workspace: resolve(env.WORKBOT_WORKSPACE || `${ROOT}/.runtime/${role}/workspace`),
    configSource: resolve(ROOT, 'configs', role),
    sharedSource: resolve(ROOT, 'configs/shared'),
    projectsFile: resolve(env.WORKBOT_PROJECTS_FILE || `${ROOT}/configs/projects.json`),
  }
}

export function required(name: string, env: Environment = process.env): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`请配置 ${name}`)
  return value
}

export function applyRuntime(config: Runtime): void {
  process.env.PI_CODING_AGENT_DIR = config.piDir
  process.env.WORKBOT_ROLE = config.role
  process.env.WORKBOT_WORKSPACE = config.workspace
  process.env.GIT_ASKPASS = resolve(ROOT, 'bin/git-askpass')
  process.env.GIT_TERMINAL_PROMPT = '0'
  process.env.GLAB_ENABLE_CI_AUTOLOGIN = 'false'
}
