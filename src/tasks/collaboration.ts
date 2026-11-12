// @env node
import { api, endpoint, projectPath } from '../gitlab/client.ts'
import { dispatchMessage } from '../notice/messages.ts'
import { notify } from '../notice/wecom.ts'
import { required } from '../runtime/config.ts'
import { run } from '../runtime/process.ts'
import type { GitLabProject, Issue, Pipeline } from '../gitlab/types.ts'
import type { Command } from '../runtime/types.ts'

export interface IssueRef {
  project: string
  iid: number
}

export interface Target {
  project: string
  mr?: number
}

export function issueRef(value: string): IssueRef {
  const match = /^(\S+)#([1-9]\d*)$/.exec(value)
  if (!match) throw new Error('Issue 格式：namespace/project#IID')
  return { project: projectPath(match[1]!), iid: Number(match[2]) }
}

export function targets(values: unknown): Target[] {
  if (!Array.isArray(values) || !values.every((value) => typeof value === 'string'))
    throw new Error('目标项目必须为字符串数组')
  if (values.length < 1 || values.length > 10) throw new Error('一次明确选择 1–10 个项目')
  const result = values.map((value) => {
    const match = /^(.+?)(?:!([1-9]\d*))?$/.exec(value)
    if (!match) throw new Error('目标格式：namespace/project 或 namespace/project!MR编号')
    return { project: projectPath(match[1]!), ...(match[2] ? { mr: Number(match[2]) } : {}) }
  })
  if (new Set(result.map((item) => item.project)).size !== result.length)
    throw new Error('目标项目不能重复')
  return result
}

export async function record(
  reference: string,
  body: string,
  command: Command = run,
): Promise<void> {
  const issue = issueRef(reference)
  try {
    await api(`${endpoint(issue.project)}/issues/${issue.iid}/notes`, { body }, command)
  } catch (error) {
    console.error('Issue 记录失败，不改变已经发生的执行结果：', error)
  }
}

export async function dispatch(
  reference: string,
  selected: string[],
  command: Command = run,
): Promise<Pipeline> {
  const issue = issueRef(reference)
  if (issue.project !== required('WORKBOT_CONTROL_PROJECT'))
    throw new Error('请指定控制项目中的中心 Issue')
  const chosen = targets(selected)
  const project = await api<GitLabProject>(endpoint(issue.project), undefined, command)
  const request = await api<Issue>(
    `${endpoint(issue.project)}/issues/${issue.iid}`,
    undefined,
    command,
  )
  let pipeline: Pipeline
  try {
    pipeline = await api<Pipeline>(
      `${endpoint(issue.project)}/pipeline`,
      {
        ref: process.env.WORKBOT_CODE_REF || project.default_branch,
        variables: [
          { key: 'MODE', value: 'code' },
          { key: 'WORKBOT_ISSUE', value: reference },
          { key: 'WORKBOT_TARGETS', value: JSON.stringify(selected) },
        ],
      },
      command,
    )
    if (!pipeline.id || !pipeline.web_url) throw new Error('没有有效 Pipeline 引用')
  } catch (cause) {
    throw new Error('派发失败或结果未知，请到 GitLab 核对，不要自动重试。', { cause })
  }
  await record(
    reference,
    `已派发 [Pipeline #${pipeline.id}](${pipeline.web_url})。\n\n目标：${selected.join('、')}`,
    command,
  )
  await notify(
    dispatchMessage({
      title: request.title,
      execution: String(pipeline.id),
      executorSha: pipeline.sha || '未知',
      pipelineUrl: pipeline.web_url,
      targets: chosen.map((target, index) => ({
        reference: selected[index]!,
        sourceBranch: target.mr
          ? `沿用 MR !${target.mr} 源分支`
          : `work/${project.id}-${issue.iid}`,
        url: request.web_url,
      })),
    }),
  )
  return pipeline
}
