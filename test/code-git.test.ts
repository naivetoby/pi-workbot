// @env node
import { describe, expect, it, spyOn } from 'bun:test'
import { join } from 'node:path'
import { code } from '../src/code/run.ts'
import { PI_CLI } from '../src/runtime/paths.ts'
import { run } from '../src/runtime/process.ts'
import type { Command } from '../src/runtime/types.ts'
import { fixture, testEnvironment } from './helpers.ts'

describe('code 分支准备（真实本地 Git）', () => {
  it.each([
    { name: '新任务从默认分支创建任务分支', resume: false },
    { name: '返工检出原 MR 的远端源分支', resume: true },
  ])(
    '$name / 不改写远端记录',
    async ({ resume }) => {
      const config = await fixture('code')
      const root = join(config.piDir, '..')
      const remote = join(root, 'remote.git')
      const seed = join(root, 'seed')
      const env = testEnvironment()
      const git = (args: string[], cwd = seed) =>
        run(
          [
            'git',
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          { cwd, env },
        )
      await git(['init', '--quiet', '--bare', '--initial-branch=main', remote], root)
      await git(['init', '--quiet', '--initial-branch=main', seed], root)
      await git(['commit', '--quiet', '--allow-empty', '-m', 'initial'])
      await git(['remote', 'add', 'origin', remote])
      await git(['push', '--quiet', 'origin', 'main'])
      const branch = resume ? 'feature-existing' : 'work/42-3'
      if (resume) {
        await git(['checkout', '--quiet', '-b', branch])
        await git(['commit', '--quiet', '--allow-empty', '-m', 'existing work'])
        await git(['push', '--quiet', 'origin', branch])
      }
      const expectedHead = await git(['rev-parse', 'HEAD'])
      const remoteBefore = await git(['ls-remote', '--heads', 'origin'])
      process.env.GITLAB_HOST = 'gitlab.fixture'
      process.env.WORKBOT_ISSUE = 'group/control#3'
      process.env.WORKBOT_TARGETS = '["group/repo"]'
      const repo = join(config.workspace, 'repos/group/repo')
      const routes: Record<string, unknown> = {
        'projects/group%2Fcontrol': { id: 42 },
        'projects/group%2Fcontrol/issues/3': {
          title: '需求',
          description: 'Plan',
          web_url: 'https://gitlab.fixture/issue/3',
        },
        'projects/group%2Fcontrol/issues/3/notes?sort=desc&per_page=100': [],
        'projects/group%2Fcontrol/issues/3/notes': {},
        'projects/group%2Frepo': {
          default_branch: 'main',
          web_url: `file://${join(root, 'remote')}`,
        },
        'projects/group%2Frepo/merge_requests?source_branch=work%2F42-3&state=all&per_page=2':
          resume
            ? [
                {
                  iid: 7,
                  state: 'opened',
                  source_branch: branch,
                  web_url: 'https://gitlab.fixture/mr/7',
                },
              ]
            : [],
      }
      let prepared: { branch: string; head: string } | undefined
      const command: Command = async (args, options) => {
        if (args[0] === 'git') return run(args, { ...options, env })
        if (args[0] === 'glab' && Object.hasOwn(routes, args[2]!))
          return JSON.stringify(routes[args[2]!])
        if (args.includes(PI_CLI)) {
          prepared = {
            branch: await git(['branch', '--show-current'], repo),
            head: await git(['rev-parse', 'HEAD'], repo),
          }
          return '分支已准备；本机 fixture 不调用模型、不推送变更。'
        }
        throw new Error(`意外命令：${args.join(' ')}`)
      }
      spyOn(console, 'log').mockImplementation(() => {})
      await code(config, undefined, command)
      expect(prepared).toEqual({ branch, head: expectedHead })
      expect(await git(['ls-remote', '--heads', 'origin'])).toBe(remoteBefore)
      expect(await git(['status', '--porcelain'], repo)).toBe('')
    },
    20_000,
  )
})
