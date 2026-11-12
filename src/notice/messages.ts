// @env node
export interface NoticeProject {
  name: string
  description?: string
  url: string
  branch: string
  namespace: string
  publisher: string
}

export interface NoticeCommit {
  title: string
  author: string
  time: string
}

export interface DeployNotice {
  status?: 'success' | 'failure'
  project: NoticeProject
  commits: NoticeCommit[]
}

export interface DispatchNotice {
  title?: string
  execution: string
  executorSha: string
  targets: { reference: string; sourceBranch: string; url?: string }[]
  pipelineUrl: string
}

const MAX_CONTENT_BYTES = 4096
const PLACEHOLDER = '\u200b'

function clean(value: string | undefined): string {
  return (value || '').replace(/[\r\n\t]+/g, ' ').trim()
}

function truncateChars(value: string, limit: number): string {
  const characters = [...value]
  return characters.length <= limit ? value : characters.slice(0, limit - 1).join('') + '…'
}

function finish(content: string): string {
  const bytes = Buffer.from(content, 'utf8')
  return bytes.length <= MAX_CONTENT_BYTES
    ? content
    : new TextDecoder().decode(bytes.subarray(0, MAX_CONTENT_BYTES - 3), { stream: true }) + '…'
}

function joinGroups(...groups: string[][]): string {
  return groups
    .filter((group) => group.length > 0)
    .map((group) => group.join('\n'))
    .join(`\n${PLACEHOLDER}\n`)
}

export function deployMessage(notice: DeployNotice): string {
  const project = notice.project
  const name = clean(project.name) || '未知项目'
  const description = clean(project.description)
  const label = description ? `${name} - ${description}` : name
  const heading = [
    notice.status === 'failure'
      ? '### ❌ Pi Workbot 机器人部署失败了~'
      : '### 🤖 Pi Workbot 机器人部署成功了~',
  ]
  const fields = [
    `**🚀 项目:** [${label}](${clean(project.url)})`,
    `**🔖 分支:** ${clean(project.branch)}`,
    `**🏷️ 群组:** ${clean(project.namespace)}`,
    `**👷 发布人:** ${clean(project.publisher)}`,
  ]
  const commits = notice.commits
    .slice(0, 5)
    .map(
      (commit) =>
        `• ${truncateChars(clean(commit.title), 80)} (${clean(commit.author)}) ${clean(commit.time)}`,
    )
  let content = joinGroups(heading, fields, commits)
  while (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES && commits.length) {
    commits.pop()
    content = joinGroups(heading, fields, commits)
  }
  return finish(content)
}

export function dispatchMessage(notice: DispatchNotice): string {
  const heading = ['### 📨 需求已派发']
  const detail = (branchLimit?: number, includeUrl = true): string[] => [
    `**📝 需求:** ${clean(notice.title) || '未知需求'}`,
    `**🧾 执行编号:** ${clean(notice.execution)}`,
    `**🧩 程序版本:** ${clean(notice.executorSha).slice(0, 8)}`,
    `**🚀 流水线:** [查看流水线](${clean(notice.pipelineUrl)})`,
    '',
    `**🎯 涉及项目 (${notice.targets.length}):**`,
    ...notice.targets.map((target) => {
      const reference =
        includeUrl && target.url
          ? `[${clean(target.reference)}](${clean(target.url)})`
          : clean(target.reference)
      const branch =
        branchLimit === undefined
          ? clean(target.sourceBranch)
          : truncateChars(clean(target.sourceBranch), branchLimit)
      return `• ${reference} — 任务分支：${branch}`
    }),
  ]
  let content = joinGroups(heading, detail())
  for (const limit of [40, 16]) {
    if (Buffer.byteLength(content, 'utf8') <= MAX_CONTENT_BYTES) break
    content = joinGroups(heading, detail(limit, false))
  }
  return finish(content)
}
