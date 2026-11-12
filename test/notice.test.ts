// @env node
import { describe, expect, it, mock, spyOn } from 'bun:test'
import { join, resolve } from 'node:path'
import { ciMessage, notice, recentCommits } from '../src/notice/ci.ts'
import { deployMessage, dispatchMessage } from '../src/notice/messages.ts'
import { notify } from '../src/notice/wecom.ts'
import type { NoticeFetch } from '../src/notice/wecom.ts'
import { ROOT } from '../src/runtime/paths.ts'
import { run } from '../src/runtime/process.ts'
import type { Command } from '../src/runtime/types.ts'
import { fixture } from './helpers.ts'

const webhook = 'https://webhook.fixture/send?key=fixture-secret'
const env = { WECOM_BOT_URL: webhook }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const ci = {
  CI_PROJECT_PATH: 'agent-works/pi-workbot',
  CI_PROJECT_NAME: 'pi-workbot',
  CI_PROJECT_DESCRIPTION: '云端研发工作区',
  CI_PROJECT_URL: 'https://gitlab.fixture/agent-works/pi-workbot',
  CI_PROJECT_NAMESPACE: 'agent-works',
  CI_COMMIT_REF_NAME: 'main',
  GITLAB_USER_LOGIN: 'toby',
  CI_PIPELINE_URL: 'https://gitlab.fixture/pipeline/123',
  CI_SERVER_URL: 'https://gitlab.fixture',
  WORKBOT_ISSUE: 'agent-works/pi-workbot#12',
  WORKBOT_TARGETS: '["group/a!7","group/b"]',
}

describe('通知模板', () => {
  it('部署通知保留标题、项目描述链接、字段图标、分组和最近 5 条提交格式', () => {
    const commits = Array.from({ length: 6 }, (_, index) => ({
      title: `feat: 提交 ${index + 1}`,
      author: 'Toby',
      time: '54 seconds ago',
    }))
    expect(ciMessage('deploy-success', ci, commits)).toBe(
      [
        '### 🤖 Pi Workbot 机器人部署成功了~',
        '\u200b',
        '**🚀 项目:** [pi-workbot - 云端研发工作区](https://gitlab.fixture/agent-works/pi-workbot)',
        '**🔖 分支:** main',
        '**🏷️ 群组:** agent-works',
        '**👷 发布人:** toby',
        '\u200b',
        ...commits
          .slice(0, 5)
          .map((commit) => `• ${commit.title} (${commit.author}) ${commit.time}`),
      ].join('\n'),
    )
  })

  it('失败通知仅替换标题，字段、最近 5 条提交和排版与成功通知相同', () => {
    const commits = Array.from({ length: 6 }, (_, index) => ({
      title: `fix: 提交 ${index + 1}`,
      author: 'Toby',
      time: '刚刚',
    }))
    const success = ciMessage('deploy-success', ci, commits)
    const failure = ciMessage('deploy-failure', ci, commits)
    expect(failure).toBe(
      success.replace('### 🤖 Pi Workbot 机器人部署成功了~', '### ❌ Pi Workbot 机器人部署失败了~'),
    )
    expect(failure).toContain('• fix: 提交 5 (Toby) 刚刚')
    expect(failure).not.toContain('提交 6')
  })

  it('派发通知保留需求、执行编号、程序版本、流水线和项目分组格式', () => {
    expect(
      dispatchMessage({
        title: '需求标题',
        execution: '123',
        executorSha: 'abcdef123456',
        pipelineUrl: ci.CI_PIPELINE_URL,
        targets: [
          {
            reference: 'group/a',
            sourceBranch: 'work/42-12',
            url: 'https://gitlab.fixture/issue/12',
          },
        ],
      }),
    ).toBe(
      [
        '### 📨 需求已派发',
        '\u200b',
        '**📝 需求:** 需求标题',
        '**🧾 执行编号:** 123',
        '**🧩 程序版本:** abcdef12',
        '**🚀 流水线:** [查看流水线](https://gitlab.fixture/pipeline/123)',
        '',
        '**🎯 涉及项目 (1):**',
        '• [group/a](https://gitlab.fixture/issue/12) — 任务分支：work/42-12',
      ].join('\n'),
    )
  })

  it('超长部署通知优先减少提交条目，保留项目字段', () => {
    const content = deployMessage({
      project: {
        name: 'pi-workbot',
        url: ci.CI_PROJECT_URL,
        branch: 'main',
        namespace: 'agent-works',
        publisher: 'toby',
      },
      commits: Array.from({ length: 5 }, () => ({
        title: '提交',
        author: '很长的作者'.repeat(300),
        time: '刚刚',
      })),
    })
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(4096)
    expect(content).toContain('**👷 发布人:** toby')
  })
})

describe('企业微信通知', () => {
  it('缺少 Webhook 时跳过', async () => {
    const fetcher = mock<NoticeFetch>(async () => response({ errcode: 0 }))
    expect(await notify('部署完成', {}, fetcher)).toBe('skipped')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('原样发送 Markdown，超长正文按 UTF-8 字节截断', async () => {
    const fetcher = mock<NoticeFetch>(async () => response({ errcode: 0 }))
    const input = '项目 pi-workbot，分支 main，模型 deepseek-flash\n' + '测试🚀'.repeat(1500)
    expect(await notify(input, env, fetcher)).toBe('sent')
    const [url, options] = fetcher.mock.calls[0]!
    expect(url).toBe(webhook)
    expect(options).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(String(options.body))
    expect(body.msgtype).toBe('markdown')
    expect(body.markdown.content).toStartWith(input.split('\n')[0])
    expect(Buffer.byteLength(body.markdown.content, 'utf8')).toBeLessThanOrEqual(4096)
    expect(body.markdown.content).toEndWith('…')
    expect(body.markdown.content).not.toContain('\uFFFD')
  })

  it.each(['HTTP 错误', '业务错误', '无效 JSON', '网络异常'])(
    '%s 只记录诊断，不抛错或泄露 Webhook',
    async (kind) => {
      const error = spyOn(console, 'error').mockImplementation(() => {})
      const fetcher = mock<NoticeFetch>(async () => {
        if (kind === 'HTTP 错误') return response({}, 500)
        if (kind === '业务错误') return response({ errcode: 93000, errmsg: webhook })
        if (kind === '无效 JSON') return new Response(webhook)
        throw new Error(webhook)
      })
      expect(await notify('code 结束', env, fetcher)).toBe('failed')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalled()
      expect(JSON.stringify(error.mock.calls)).not.toContain('fixture-secret')
    },
  )
})

describe('CI 通知', () => {
  it.each(['code-success', 'code-failure'] as const)('%s 包含 Issue、目标和流水线', (kind) => {
    const message = ciMessage(kind, ci)
    expect(message).toStartWith(
      (kind === 'code-success' ? '### ✅ 编码执行结束，请核对逐项目结果' : '### ❌ 需求编码失败') +
        '\n\u200b\n',
    )
    expect(message).not.toContain('**项目：**')
    expect(message).toContain(ci.CI_PIPELINE_URL)
    expect(message).toContain('https://gitlab.fixture/agent-works/pi-workbot/-/issues/12')
    expect(message).toContain('group/a!7、group/b')
    expect(message).toEndWith(
      '\n\u200b\n' +
        (kind === 'code-success'
          ? '执行结束不代表需求全部完成；请核对 Issue 中的逐项目结果、实际 MR 和项目 CI，再人工审核合并。'
          : '请查看 Job 日志并核对 Issue/MR，可能已有部分成果。'),
    )
  })

  it('从当前提交读取最近 5 条提交的标题、作者和相对时间', async () => {
    const config = await fixture()
    const root = resolve(config.workspace, '../repo')
    const gitEnv = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    }
    await run(['git', 'init', '--initial-branch=main', root], { env: gitEnv })
    for (let index = 1; index <= 6; index++)
      await run(
        [
          'git',
          '-c',
          'user.name=Toby',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '-m',
          `feat: 提交 ${index}`,
        ],
        { cwd: root, env: gitEnv },
      )
    const sha = await run(['git', 'rev-parse', 'HEAD'], { cwd: root, env: gitEnv })
    const commits = await recentCommits({ ...gitEnv, CI_PROJECT_DIR: root, CI_COMMIT_SHA: sha })
    expect(commits.map((commit) => commit.title)).toEqual(
      [6, 5, 4, 3, 2].map((index) => `feat: 提交 ${index}`),
    )
    expect(commits.every((commit) => commit.author === 'Toby' && commit.time.length > 0)).toBe(true)
  })

  it.each(['deploy-success', 'deploy-failure'] as const)(
    '%s 读取最近提交并发送同一模板',
    async (kind) => {
      const log = spyOn(console, 'log').mockImplementation(() => {})
      const fetcher = mock<NoticeFetch>(async () => response({ errcode: 0 }))
      const command = mock<Command>(async () => 'fix: 修复构建\x1fToby\x1f刚刚')
      expect(await notice(kind, { ...ci, ...env }, fetcher, command)).toBe('sent')
      expect(command).toHaveBeenCalledTimes(1)
      expect(command.mock.calls[0]![0]).toContain('-5')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(fetcher.mock.calls[0]![1].body)).markdown.content).toBe(
        ciMessage(kind, ci, [{ title: 'fix: 修复构建', author: 'Toby', time: '刚刚' }]),
      )
      expect(log).toHaveBeenCalledWith(`[notice] ${kind}: sent`)
    },
  )

  it.each(['deploy-success', 'deploy-failure'] as const)(
    '%s 获取提交失败时仍发送项目字段',
    async (kind) => {
      const error = spyOn(console, 'error').mockImplementation(() => {})
      spyOn(console, 'log').mockImplementation(() => {})
      const fetcher = mock<NoticeFetch>(async () => response({ errcode: 0 }))
      const command = mock<Command>(async () => {
        throw new Error('Git 不可用')
      })
      expect(await notice(kind, { ...ci, ...env }, fetcher, command)).toBe('sent')
      expect(JSON.parse(String(fetcher.mock.calls[0]![1].body)).markdown.content).toBe(
        ciMessage(kind, ci),
      )
      expect(error).toHaveBeenCalled()
    },
  )

  it.each(['deploy-success', 'deploy-failure'] as const)(
    '%s 未配置 Webhook 时不读取提交或发送请求',
    async (kind) => {
      spyOn(console, 'log').mockImplementation(() => {})
      const fetcher = mock<NoticeFetch>(async () => response({ errcode: 0 }))
      const command = mock<Command>(async () => '')
      expect(await notice(kind, ci, fetcher, command)).toBe('skipped')
      expect(command).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each(['code-failure', 'deploy-failure'] as const)(
    '%s 通知发送失败时正常结束并输出结果',
    async (kind) => {
      const log = spyOn(console, 'log').mockImplementation(() => {})
      spyOn(console, 'error').mockImplementation(() => {})
      expect(
        await notice(
          kind,
          { ...ci, ...env },
          async () => response({}, 500),
          async () => '',
        ),
      ).toBe('failed')
      expect(log).toHaveBeenCalledWith(`[notice] ${kind}: failed`)
    },
  )

  it('CI 入口无需项目依赖、模型或 GitLab 凭证', async () => {
    const config = await fixture()
    const root = resolve(config.workspace, '../notice-source')
    for (const file of [
      'scripts/notice.ts',
      'src/notice/ci.ts',
      'src/notice/wecom.ts',
      'src/notice/messages.ts',
      'src/runtime/process.ts',
    ])
      await Bun.write(join(root, file), Bun.file(join(ROOT, file)))
    for (const kind of ['deploy-success', 'deploy-failure', 'code-success', 'code-failure']) {
      const output = await run([process.execPath, join(root, 'scripts/notice.ts'), kind], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root },
      })
      expect(output).toBe(`[notice] ${kind}: skipped`)
    }
  })
})
