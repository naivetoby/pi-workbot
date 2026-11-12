// @env node
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../runtime/process.ts'
import { api, endpoint, projectPath } from './client.ts'
import type { Command } from '../runtime/types.ts'
import type { GitLabProject, ProjectSpec } from './types.ts'

export function projectSpecs(value: unknown): ProjectSpec[] {
  if (!Array.isArray(value)) throw new Error('项目清单必须是数组')
  const projects = value.map((entry: unknown, index) => {
    const label = `项目清单第 ${index + 1} 项`
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('project' in entry) ||
      typeof entry.project !== 'string'
    )
      throw new Error(`${label} 必须包含字符串 project`)
    const project = projectPath(entry.project)
    if ('branch' in entry) {
      if (typeof entry.branch !== 'string' || !entry.branch.trim())
        throw new Error(`${label} 的 branch 必须为非空字符串`)
      return { project, branch: entry.branch }
    }
    return { project }
  })
  if (new Set(projects.map((entry) => entry.project)).size !== projects.length)
    throw new Error('项目清单不能包含重复项目')
  return projects
}

export async function repository(
  spec: ProjectSpec,
  workspace: string,
  command: Command = run,
): Promise<string> {
  const dir = join(workspace, 'repos', projectPath(spec.project))
  if (await Bun.file(join(dir, '.git/HEAD')).exists()) return dir
  const project = await api<GitLabProject>(endpoint(spec.project), undefined, command)
  const url = `${project.web_url}.git`
  const branch = spec.branch || project.default_branch
  await mkdir(dir, { recursive: true })
  await command(['git', '-c', 'credential.helper=', 'clone', '--branch', branch, url, dir])
  await command(['git', 'config', 'user.name', 'Pi Workbot'], { cwd: dir })
  await command(['git', 'config', 'user.email', 'pi-workbot@noreply.local'], { cwd: dir })
  return dir
}
