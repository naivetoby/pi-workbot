// @env node
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { dispatch, issueRef, targets } from '../src/tasks/collaboration.ts'
import type { Command } from '../src/runtime/types.ts'

function gitlab() {
  const pipeline = {
    id: 123,
    web_url: 'https://gitlab.fixture/pipeline/123',
    sha: 'abcdef12'.repeat(5),
  }
  const create = mock(async (_body: unknown): Promise<unknown> => pipeline)
  const comment = mock(async (_body: unknown) => ({}))
  const command = mock<Command>(async (args, options) => {
    const path = args[2]
    if (path === 'projects/group%2Fcontrol') return '{"id":42,"default_branch":"develop"}'
    if (path === 'projects/group%2Fcontrol/issues/12')
      return '{"title":"需求标题","web_url":"https://gitlab.fixture/issue/12"}'
    if (path === 'projects/group%2Fcontrol/pipeline')
      return JSON.stringify(await create(JSON.parse(options!.input!)))
    if (path === 'projects/group%2Fcontrol/issues/12/notes')
      return JSON.stringify(await comment(JSON.parse(options!.input!)))
    throw new Error(`意外命令：${args.join(' ')}`)
  })
  return { pipeline, create, comment, command }
}

describe('任务引用', () => {
  it('解析完整项目路径、Issue 和可选 MR，支持 1–10 个不同项目', () => {
    expect(issueRef('group/sub/control#12')).toEqual({ project: 'group/sub/control', iid: 12 })
    expect(targets(['group/a!7', 'group/b'])).toEqual([
      { project: 'group/a', mr: 7 },
      { project: 'group/b' },
    ])
    expect(targets(Array.from({ length: 10 }, (_, i) => `group/p${i}`))).toHaveLength(10)
  })

  it.each([
    'group/control',
    'group/control#0',
    'group/control#-1',
    '../control#1',
    'https://host/group/control#1',
  ])('拒绝无效 Issue：%s', (value) => expect(() => issueRef(value)).toThrow())

  it.each([
    { name: '空目标', values: [] },
    { name: '同项目重复指定', values: ['group/a', 'group/a!7'] },
    { name: '路径穿越', values: ['group/../a'] },
    { name: '无效 MR 编号', values: ['group/a!0'] },
    { name: '路径包含命令字符', values: ['group/a;rm'] },
    { name: '超过项目数量上限', values: Array.from({ length: 11 }, (_, i) => `group/p${i}`) },
  ])('拒绝$name', ({ values }) => expect(() => targets([...values])).toThrow())
})

describe('目标输入边界', () => {
  it.each([
    { name: 'null', value: null },
    { name: '对象', value: {} },
    { name: '单个字符串', value: 'group/a' },
    { name: '数字', value: 1 },
    { name: 'null 元素', value: [null] },
    { name: '混合元素', value: ['group/a', 1] },
  ])('拒绝非字符串数组：$name', ({ value }) =>
    expect(() => targets(value)).toThrow('目标项目必须为字符串数组'),
  )
})

describe('code 派发', () => {
  beforeEach(() => {
    process.env.GITLAB_HOST = 'gitlab.fixture'
    process.env.WORKBOT_CONTROL_PROJECT = 'group/control'
    delete process.env.WORKBOT_CODE_REF
  })

  it.each([
    { name: '默认分支', ref: undefined },
    { name: '指定 ref', ref: 'release' },
  ])('使用$name 派发一个 Pipeline，并记录 Issue', async ({ ref }) => {
    if (ref) process.env.WORKBOT_CODE_REF = ref
    const { pipeline, create, comment, command } = gitlab()
    expect(await dispatch('group/control#12', ['group/a!7', 'group/b'], command)).toEqual(pipeline)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toEqual({
      ref: ref || 'develop',
      variables: [
        { key: 'MODE', value: 'code' },
        { key: 'WORKBOT_ISSUE', value: 'group/control#12' },
        { key: 'WORKBOT_TARGETS', value: '["group/a!7","group/b"]' },
      ],
    })
    expect(comment).toHaveBeenCalledWith({ body: expect.stringContaining(pipeline.web_url) })
  })

  it('拒绝控制项目之外的 Issue，且不调用 GitLab', async () => {
    const { command } = gitlab()
    await expect(dispatch('group/other#12', ['group/a'], command)).rejects.toThrow('控制项目')
    expect(command).not.toHaveBeenCalled()
  })

  it('评论失败保留已创建的 Pipeline，并输出诊断', async () => {
    const { pipeline, comment, command } = gitlab()
    comment.mockRejectedValueOnce(new Error('评论失败'))
    const error = spyOn(console, 'error').mockImplementation(() => {})
    expect(await dispatch('group/control#12', ['group/a'], command)).toEqual(pipeline)
    expect(error).toHaveBeenCalled()
  })

  it.each([
    { name: '成功', ok: true },
    { name: '失败', ok: false },
  ])('派发通知$name 均保留已创建的 Pipeline', async ({ ok }) => {
    process.env.WECOM_BOT_URL = 'https://webhook.fixture/send?key=fixture'
    spyOn(console, 'error').mockImplementation(() => {})
    const fetcher = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errcode: ok ? 0 : 93000 })),
    )
    const { pipeline, create, command } = gitlab()
    expect(await dispatch('group/control#12', ['group/a!7', 'group/b'], command)).toEqual(pipeline)
    expect(create).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const content = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).markdown.content
    expect(content).toContain('**📝 需求:** 需求标题')
    expect(content).toContain('**🧩 程序版本:** abcdef12')
    expect(content).toContain('work/42-12')
    expect(content).toContain(pipeline.web_url)
  })

  it.each(['请求失败', '无效响应'])('%s 时报告结果未知，仅派发一次', async (failure) => {
    const { create, comment, command } = gitlab()
    if (failure === '请求失败') create.mockRejectedValueOnce(new Error('连接断开'))
    else create.mockResolvedValueOnce({})
    await expect(dispatch('group/control#12', ['group/a'], command)).rejects.toThrow('结果未知')
    expect(create).toHaveBeenCalledTimes(1)
    expect(comment).not.toHaveBeenCalled()
  })
})
