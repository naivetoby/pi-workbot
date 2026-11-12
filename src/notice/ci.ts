// @env node
import { resolve } from 'node:path'
import { run } from '../runtime/process.ts'
import type { Command, Environment } from '../runtime/types.ts'
import { deployMessage } from './messages.ts'
import type { NoticeCommit, NoticeProject } from './messages.ts'
import { notify } from './wecom.ts'
import type { NoticeFetch, NoticeResult } from './wecom.ts'

const codeTitles = {
  'code-success': '✅ 编码执行结束，请核对逐项目结果',
  'code-failure': '❌ 需求编码失败',
}

type DeployCiNotice = 'deploy-success' | 'deploy-failure'
export type CiNotice = DeployCiNotice | keyof typeof codeTitles

function isDeployNotice(kind: string | undefined): kind is DeployCiNotice {
  return kind === 'deploy-success' || kind === 'deploy-failure'
}

function projectFromEnvironment(env: Environment): NoticeProject {
  const url = env.CI_PROJECT_URL?.trim() || ''
  let path = env.CI_PROJECT_PATH?.trim() || ''
  if (!path && url) {
    try {
      path = new URL(url).pathname.replace(/^\/|\/$/g, '')
    } catch {
      /* 使用默认项目信息。 */
    }
  }
  const parts = path.split('/').filter(Boolean)
  return {
    name: env.CI_PROJECT_NAME?.trim() || parts.at(-1) || '未知项目',
    description: env.CI_PROJECT_DESCRIPTION,
    url,
    branch:
      env.CI_COMMIT_REF_NAME?.trim() ||
      env.CI_COMMIT_BRANCH?.trim() ||
      env.CI_DEFAULT_BRANCH?.trim() ||
      'main',
    namespace: env.CI_PROJECT_NAMESPACE?.trim() || parts.slice(0, -1).join('/') || '未知群组',
    publisher: env.GITLAB_USER_LOGIN?.trim() || 'pi-workbot',
  }
}

export async function recentCommits(
  env: Environment,
  command: Command = run,
): Promise<NoticeCommit[]> {
  const cwd = resolve(env.CI_PROJECT_DIR || process.cwd())
  const args = [
    'git',
    '-c',
    `safe.directory=${cwd}`,
    '-C',
    cwd,
    'log',
    '--format=%s%x1f%an%x1f%cr',
    '--no-merges',
    '-5',
  ]
  if (env.CI_COMMIT_SHA && /^[a-f0-9]{40}$/.test(env.CI_COMMIT_SHA)) args.push(env.CI_COMMIT_SHA)
  try {
    const output = await command(args, { cwd, env })
    return output.split('\n').flatMap((line) => {
      const [title, author, time] = line.split('\x1f')
      return title && author !== undefined && time !== undefined ? [{ title, author, time }] : []
    })
  } catch {
    console.error('[notice] 获取最近提交失败')
    return []
  }
}

export function ciMessage(kind: CiNotice, env: Environment, commits: NoticeCommit[] = []): string {
  if (isDeployNotice(kind))
    return deployMessage({
      status: kind === 'deploy-success' ? 'success' : 'failure',
      project: projectFromEnvironment(env),
      commits,
    })
  const lines = [
    `### ${codeTitles[kind]}`,
    '\u200b',
    `**流水线：** ${env.CI_PIPELINE_URL || '查看 GitLab'}`,
  ]
  const reference = env.WORKBOT_ISSUE || ''
  const match = /^(.+)#([1-9]\d*)$/.exec(reference)
  const url =
    match && env.CI_SERVER_URL ? `${env.CI_SERVER_URL}/${match[1]}/-/issues/${match[2]}` : undefined
  lines.push(`**需求：** ${url ? `[${reference}](${url})` : reference || '查看流水线'}`)
  try {
    const projects: unknown = JSON.parse(env.WORKBOT_TARGETS || '[]')
    if (Array.isArray(projects) && projects.every((item) => typeof item === 'string'))
      lines.push(`**目标项目：** ${projects.join('、')}`)
  } catch {
    /* 反馈仍可通过 Issue 和流水线查询。 */
  }
  lines.push(
    '\u200b',
    kind === 'code-success'
      ? '执行结束不代表需求全部完成；请核对 Issue 中的逐项目结果、实际 MR 和项目 CI，再人工审核合并。'
      : '请查看 Job 日志并核对 Issue/MR，可能已有部分成果。',
  )
  return lines.join('\n')
}

export async function notice(
  kind: string | undefined,
  env: Environment = process.env,
  fetcher: NoticeFetch = fetch,
  command: Command = run,
): Promise<NoticeResult> {
  if (!isDeployNotice(kind) && (!kind || !Object.hasOwn(codeTitles, kind)))
    throw new Error('未知 CI 通知类型')
  const commits =
    isDeployNotice(kind) && env.WECOM_BOT_URL?.trim() ? await recentCommits(env, command) : []
  const result = await notify(ciMessage(kind as CiNotice, env, commits), env, fetcher)
  console.log(`[notice] ${kind}: ${result}`)
  return result
}
