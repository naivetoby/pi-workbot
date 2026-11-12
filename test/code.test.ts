// @env node
import { describe, expect, it, mock, spyOn } from 'bun:test'
import { join } from 'node:path'
import { code } from '../src/code/run.ts'
import { PI_CLI } from '../src/runtime/paths.ts'
import type { Command, RunOptions } from '../src/runtime/types.ts'
import { fixture } from './helpers.ts'

const issue = 'projects/group%2Fcontrol/issues/3'
const pipelineUrl = 'https://gitlab.fixture/pipeline/123'
const mrQuery = 'projects/group%2Fa/merge_requests?source_branch=work%2F42-3&state=all&per_page=2'
const mr = {
  iid: 7,
  state: 'opened',
  source_branch: 'feature-b',
  web_url: 'https://gitlab.fixture/mr/7',
}

async function createCodeJobFixture() {
  const config = await fixture('code')
  process.env.GITLAB_HOST = 'gitlab.fixture'
  process.env.WORKBOT_ISSUE = 'group/control#3'
  process.env.WORKBOT_TARGETS = '["group/a"]'
  process.env.CI_PIPELINE_URL = pipelineUrl
  for (const project of ['a', 'b'])
    await Bun.write(
      join(config.workspace, `repos/group/${project}/.git/HEAD`),
      'ref: refs/heads/main\n',
    )
  const routes: Record<string, unknown> = {
    'projects/group%2Fcontrol': { id: 42 },
    [issue]: { title: '需求', description: '当前 Plan', web_url: 'https://gitlab.fixture/issue/3' },
    [`${issue}/notes?sort=desc&per_page=100`]: [{ body: '较新讨论' }, { body: '较早讨论' }],
    [mrQuery]: [],
    'projects/group%2Fb/merge_requests/7': mr,
  }
  const git = mock<Command>(async (args) => {
    if (args[1] === 'ls-remote')
      return args.at(-1) === 'refs/heads/feature-b' ? 'abc refs/heads/feature-b' : ''
    if (['fetch', 'checkout'].includes(args[1]!)) return ''
    throw new Error(`意外 Git 命令：${args.join(' ')}`)
  })
  const agent = mock<Command>(async () => 'a 无变更；b 已更新 MR，检查未执行。')
  const comment = mock<Command>(async () => '{}')
  const recordedNotes: string[] = []
  const agentInputs: RunOptions[] = []
  const command: Command = async (args, options) => {
    if (args[0] === 'git') return git(args, options)
    if (args.includes(PI_CLI)) {
      agentInputs.push(options ?? {})
      return agent(args, options)
    }
    if (args[0] === 'glab') {
      if (args[2] === `${issue}/notes`) {
        recordedNotes.push(JSON.parse(options!.input!).body)
        return comment(args, options)
      }
      if (Object.hasOwn(routes, args[2]!)) return JSON.stringify(routes[args[2]!]!)
    }
    throw new Error(`意外命令：${args.join(' ')}`)
  }
  spyOn(console, 'log').mockImplementation(() => {})
  return { config, routes, git, agent, comment, command, recordedNotes, agentInputs }
}

describe('code Job', () => {
  it('在同一会话中处理新任务和指定 MR，按时间顺序读取讨论并回写结果', async () => {
    const { config, git, agent, command, recordedNotes, agentInputs } = await createCodeJobFixture()
    process.env.WORKBOT_TARGETS = '["group/a", "group/b!7"]'
    await code(config, undefined, command)
    expect(agent).toHaveBeenCalledTimes(1)
    expect(agent.mock.calls[0]![0]).toContain('--print')
    const input = agentInputs[0]!
    expect(input.cwd).toBe(config.workspace)
    expect(input.input).toContain('当前 Plan')
    expect(input.input).toContain(join(config.workspace, 'repos/group/a'))
    expect(input.input).toContain(mr.web_url)
    expect(input.input).toMatch(/较早讨论[\s\S]*较新讨论/)
    // 分支准备顺序是安全契约：先查询远端，再 fetch，最后切换分支。
    expect(git.mock.calls.map(([args]) => args)).toEqual([
      ['git', 'ls-remote', '--heads', 'origin', 'refs/heads/work/42-3'],
      ['git', 'checkout', '-b', 'work/42-3'],
      ['git', 'ls-remote', '--heads', 'origin', 'refs/heads/feature-b'],
      ['git', 'fetch', 'origin', 'feature-b'],
      ['git', 'checkout', '-B', 'feature-b', 'FETCH_HEAD'],
    ])
    expect(recordedNotes).toHaveLength(1)
    expect(recordedNotes[0]).toContain(pipelineUrl)
    expect(recordedNotes[0]).toContain('b 已更新 MR')
  })

  it('按任务分支找到已有 MR 后继续其源分支', async () => {
    const { config, routes, git, command, agentInputs } = await createCodeJobFixture()
    routes[mrQuery] = [mr]
    await code(config, undefined, command)
    expect(git).toHaveBeenCalledWith(['git', 'fetch', 'origin', 'feature-b'], expect.anything())
    expect(agentInputs[0]?.input).toContain(mr.web_url)
  })

  it.each([
    { name: '已合并', found: [{ ...mr, state: 'merged' }], error: '已关闭或合并' },
    { name: '已关闭', found: [{ ...mr, state: 'closed' }], error: '已关闭或合并' },
    { name: '不唯一', found: [mr, mr], error: '不唯一' },
    { name: '源分支丢失', found: [{ ...mr, source_branch: 'missing' }], error: '源分支不存在' },
  ])('MR $name 时停止执行并记录原因', async ({ found, error }) => {
    const { config, routes, agent, command, recordedNotes } = await createCodeJobFixture()
    routes[mrQuery] = found
    await expect(code(config, undefined, command)).rejects.toThrow(error)
    expect(agent).not.toHaveBeenCalled()
    expect(recordedNotes[0]).toContain(error)
  })

  it.each([
    { value: '{broken', error: 'JSON 数组' },
    { value: 'null', error: '字符串数组' },
    { value: '{}', error: '字符串数组' },
    { value: '"group/a"', error: '字符串数组' },
    { value: '["group/a", 1]', error: '字符串数组' },
  ])('目标输入 $value 无效时不准备仓库，并回写可理解的错误', async ({ value, error }) => {
    const { config, git, agent, command, recordedNotes } = await createCodeJobFixture()
    process.env.WORKBOT_TARGETS = value
    await expect(code(config, undefined, command)).rejects.toThrow(error)
    expect(git).not.toHaveBeenCalled()
    expect(agent).not.toHaveBeenCalled()
    expect(recordedNotes[0]).toContain(error)
  })

  it('准备仓库时可取消，反馈记录不受取消信号影响', async () => {
    const { config, git, agent, comment, command } = await createCodeJobFixture()
    const controller = new AbortController()
    git.mockImplementationOnce(async (_args, options) => {
      expect(options?.signal).toBe(controller.signal)
      controller.abort()
      options!.signal!.throwIfAborted()
      return ''
    })
    await expect(code(config, controller.signal, command)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(agent).not.toHaveBeenCalled()
    expect(comment).toHaveBeenCalledTimes(1)
    expect(comment.mock.calls[0]![1]?.signal).toBeUndefined()
  })

  it.each([
    { name: '项目访问失败', clone: false, commentFails: false },
    { name: '克隆失败', clone: true, commentFails: false },
    { name: '项目访问和评论均失败', clone: false, commentFails: true },
  ])('初始化$name 时尝试回写 Issue，保留原始错误', async ({ name, clone, commentFails }) => {
    const { config, routes, git, agent, comment, command, recordedNotes } =
      await createCodeJobFixture()
    const project = 'projects/group%2Fpreload'
    const failure = new Error(name)
    await Bun.write(config.projectsFile, '[{"project":"group/preload"}]')
    routes[project] = { default_branch: 'main', web_url: 'https://gitlab.fixture/group/preload' }
    if (clone) git.mockRejectedValueOnce(failure)
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    if (commentFails) comment.mockRejectedValueOnce(new Error('评论失败'))
    const execute: Command = (args, options) => {
      if (!clone && args[0] === 'glab' && args[2] === project) return Promise.reject(failure)
      return command(args, options)
    }
    await expect(code(config, undefined, execute)).rejects.toBe(failure)
    expect(agent).not.toHaveBeenCalled()
    expect(recordedNotes).toHaveLength(1)
    expect(recordedNotes[0]).toContain(name)
    expect(recordedNotes[0]).toContain(pipelineUrl)
    if (commentFails) expect(errorLog).toHaveBeenCalled()
  })

  it('Pi 执行失败时保留原始错误并向 Issue 报告', async () => {
    const { config, agent, command, recordedNotes } = await createCodeJobFixture()
    agent.mockRejectedValueOnce(new Error('模型请求失败'))
    await expect(code(config, undefined, command)).rejects.toThrow('模型请求失败')
    expect(agent).toHaveBeenCalledTimes(1)
    expect(recordedNotes[0]).toContain('模型请求失败')
  })
})
