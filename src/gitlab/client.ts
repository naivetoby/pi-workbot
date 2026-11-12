// @env node
import { required } from '../runtime/config.ts'
import { run } from '../runtime/process.ts'
import type { Command } from '../runtime/types.ts'

export async function api<T>(path: string, body?: unknown, command: Command = run): Promise<T> {
  const args = ['glab', 'api', path, '--hostname', required('GITLAB_HOST')]
  if (body !== undefined) args.push('--method', 'POST', '--input', '-')
  const output = await command(args, {
    input: body === undefined ? undefined : JSON.stringify(body),
  })
  try {
    return JSON.parse(output) as T
  } catch (cause) {
    throw new Error(`GitLab ${path} 返回了无效 JSON`, { cause })
  }
}

export function projectPath(project: string): string {
  if (
    !/^[\w.-]+(?:\/[\w.-]+)+$/.test(project) ||
    project.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('项目使用完整 namespace/project 路径')
  return project
}

export function endpoint(project: string): string {
  return `projects/${encodeURIComponent(projectPath(project))}`
}
