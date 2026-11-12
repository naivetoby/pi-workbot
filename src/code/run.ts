// @env node
import { join } from 'node:path'
import { api, endpoint } from '../gitlab/client.ts'
import { repository } from '../gitlab/repository.ts'
import { required } from '../runtime/config.ts'
import { initialize } from '../runtime/init.ts'
import { PI_CLI } from '../runtime/paths.ts'
import { run } from '../runtime/process.ts'
import { issueRef, record, targets } from '../tasks/collaboration.ts'
import type { GitLabProject, Issue, MergeRequest } from '../gitlab/types.ts'
import type { Command, Runtime } from '../runtime/types.ts'

export async function code(
  config: Runtime,
  signal?: AbortSignal,
  command: Command = run,
): Promise<void> {
  const reference = required('WORKBOT_ISSUE')
  const issue = issueRef(reference)
  const pipeline = process.env.CI_PIPELINE_URL || '本地 code 执行'
  const execute: Command = (args, options) => command(args, { ...options, signal })
  try {
    signal?.throwIfAborted()
    let selected: unknown
    try {
      selected = JSON.parse(required('WORKBOT_TARGETS'))
    } catch (cause) {
      throw new Error('WORKBOT_TARGETS 必须为目标项目引用的 JSON 数组', { cause })
    }
    const chosen = targets(selected)
    await initialize(config, execute)
    const controller = await api<GitLabProject>(endpoint(issue.project), undefined, execute)
    const request = await api<Issue>(
      `${endpoint(issue.project)}/issues/${issue.iid}`,
      undefined,
      execute,
    )
    const notes = await api<{ body: string }[]>(
      `${endpoint(issue.project)}/issues/${issue.iid}/notes?sort=desc&per_page=100`,
      undefined,
      execute,
    )
    const repositories: string[] = []
    for (const target of chosen) {
      const dir = await repository(target, config.workspace, execute)
      const prefix = endpoint(target.project)
      const branch = `work/${controller.id}-${issue.iid}`
      let mr: MergeRequest | undefined
      if (target.mr)
        mr = await api<MergeRequest>(`${prefix}/merge_requests/${target.mr}`, undefined, execute)
      else {
        const found = await api<MergeRequest[]>(
          `${prefix}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&per_page=2`,
          undefined,
          execute,
        )
        if (found.length > 1) throw new Error(`${target.project} 的 MR 不唯一，请明确指定 !IID`)
        mr = found[0]
      }
      if (mr && mr.state !== 'opened')
        throw new Error(`${target.project}!${mr.iid} 已关闭或合并，请先讨论后续处理`)
      const source = mr?.source_branch || branch
      const remote = await execute(
        ['git', 'ls-remote', '--heads', 'origin', `refs/heads/${source}`],
        { cwd: dir },
      )
      if (remote) {
        await execute(['git', 'fetch', 'origin', source], { cwd: dir })
        await execute(['git', 'checkout', '-B', source, 'FETCH_HEAD'], { cwd: dir })
      } else if (mr) throw new Error(`${target.project} 原 MR 源分支不存在`)
      else await execute(['git', 'checkout', '-b', source], { cwd: dir })
      repositories.push(
        `- ${target.project}：${dir}；任务分支 ${source}${mr ? `；原 MR ${mr.web_url}` : '；有改动时创建 MR'}`,
      )
    }
    const prompt = [
      `中心 Issue：${reference} ${request.web_url}`,
      `执行：${pipeline}`,
      ...repositories,
      `# ${request.title}\n${request.description}`,
      '## 最近 100 条讨论（时间正序，需要更早上下文时用 glab 分页查询）',
      ...notes.toReversed().map((note) => note.body),
      '请按 code 工作约定在一次会话中实现目标，提交并交付或更新原 MR。最终逐项目如实报告结果与检查情况，不自动合并。',
    ].join('\n\n')
    const summary = await execute(
      [process.execPath, PI_CLI, '--print', '--session-dir', join(config.piDir, 'sessions')],
      {
        cwd: config.workspace,
        input: prompt,
        signal,
        env: { ...process.env, PI_CHANNELS_DISABLE_SESSION_AUTOSTART: '1' },
      },
    )
    console.log(summary)
    await record(
      reference,
      `执行：${pipeline}\n\n${summary.slice(0, 50_000) || 'Pi 未返回完成摘要，请核对 Job 日志和实际 MR。'}`,
      command,
    )
  } catch (error) {
    await record(
      reference,
      `执行失败或已取消：${pipeline}\n\n${String(error).slice(0, 10_000)}\n\n请核对 GitLab 实际分支/MR，可能已有部分成果，不自动重试。`,
      command,
    )
    throw error
  }
}
