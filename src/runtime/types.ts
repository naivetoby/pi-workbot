// @env node
export type Role = 'chat' | 'code'
export type Environment = Record<string, string | undefined>

export interface Runtime {
  role: Role
  piDir: string
  workspace: string
  configSource: string
  sharedSource: string
  projectsFile: string
}

export interface RunOptions {
  cwd?: string
  env?: Environment
  input?: string
  signal?: AbortSignal
  inherit?: boolean
}

export type Command = (args: string[], options?: RunOptions) => Promise<string>
