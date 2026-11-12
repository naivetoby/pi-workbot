// @env node
import { describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import { runtime } from '../src/runtime/config.ts'
import { initialize } from '../src/runtime/init.ts'
import type { Command } from '../src/runtime/types.ts'
import { fixture } from './helpers.ts'

describe('工作区初始化', () => {
  it('使用运行目录和项目清单的环境配置', () => {
    const config = runtime('code', {
      PI_CODING_AGENT_DIR: '/tmp/pi',
      WORKBOT_WORKSPACE: '/tmp/workspace',
      WORKBOT_PROJECTS_FILE: '/tmp/projects.json',
    })
    expect(config).toMatchObject({
      role: 'code',
      piDir: '/tmp/pi',
      workspace: '/tmp/workspace',
      projectsFile: '/tmp/projects.json',
    })
  })

  it.each(['chat', 'code'] as const)('%s 复制共享资产，同名文件使用角色配置', async (role) => {
    const config = await fixture(role)
    await Bun.write(join(config.sharedSource, 'skills/shared/SKILL.md'), '# 共享 Skill')
    await Bun.write(join(config.sharedSource, 'models.json'), '{"providers":{}}')
    await Bun.write(
      join(config.sharedSource, 'mcp.json'),
      '{"mcpServers":{},"autoEnableCodemode":false}',
    )
    await Bun.write(join(config.configSource, 'mcp.json'), '{"mcpServers":{}}')
    await Bun.write(join(config.configSource, 'AGENTS.md'), '# 角色约定')
    await initialize(config)
    expect(await Bun.file(join(config.piDir, 'skills/shared/SKILL.md')).text()).toBe('# 共享 Skill')
    expect(await Bun.file(join(config.piDir, 'models.json')).json()).toEqual({ providers: {} })
    expect(await Bun.file(join(config.piDir, 'mcp.json')).json()).toEqual({ mcpServers: {} })
    expect(await Bun.file(join(config.piDir, 'AGENTS.md')).text()).toBe('# 角色约定')
  })

  it('重复初始化保留在线设置、凭证和 Skills', async () => {
    const config = await fixture()
    await initialize(config)
    const settings = { defaultModel: 'online-model' }
    const auth = { example: { type: 'api_key', key: 'fixture' } }
    await Bun.write(join(config.piDir, 'settings.json'), JSON.stringify(settings))
    await Bun.write(join(config.piDir, 'auth.json'), JSON.stringify(auth))
    await Bun.write(join(config.piDir, 'skills/shared/SKILL.md'), '# 在线修改')
    await Bun.write(join(config.sharedSource, 'skills/shared/SKILL.md'), '# 新的默认值')
    await initialize(config)
    expect(await Bun.file(join(config.piDir, 'settings.json')).json()).toEqual(settings)
    expect(await Bun.file(join(config.piDir, 'auth.json')).json()).toEqual(auth)
    expect(await Bun.file(join(config.piDir, 'skills/shared/SKILL.md')).text()).toBe('# 在线修改')
  })

  it.each([
    { value: null, error: '项目清单必须是数组' },
    { value: [null], error: '必须包含字符串 project' },
    { value: [{ project: 1 }], error: '必须包含字符串 project' },
    { value: [{ project: '../escape' }], error: '完整 namespace/project' },
    { value: [{ project: 'group/a', branch: '' }], error: 'branch 必须为非空字符串' },
    { value: [{ project: 'group/a', branch: 1 }], error: 'branch 必须为非空字符串' },
    { value: [{ project: 'group/a' }, { project: 'group/a' }], error: '重复项目' },
    { value: [{ project: 'group/a' }, null], error: '第 2 项' },
  ])('项目清单无效时不执行任何外部命令：$error', async ({ value, error }) => {
    const config = await fixture()
    await Bun.write(config.projectsFile, JSON.stringify(value))
    const command = mock<Command>(async () => '')
    await expect(initialize(config, command)).rejects.toThrow(error)
    expect(command).not.toHaveBeenCalled()
  })

  it('按项目分支克隆并生成目录说明，已有副本继续使用', async () => {
    const config = await fixture()
    process.env.GITLAB_HOST = 'gitlab.fixture'
    await Bun.write(
      config.projectsFile,
      JSON.stringify([{ project: 'group/a' }, { project: 'group/b', branch: 'release' }]),
    )
    const command = mock<Command>(async (args) => {
      if (args[0] === 'glab' && ['projects/group%2Fa', 'projects/group%2Fb'].includes(args[2]!))
        return JSON.stringify({
          default_branch: 'main',
          web_url: `https://gitlab.fixture/${decodeURIComponent(args[2]!.slice('projects/'.length))}`,
        })
      if (args[0] === 'git' && args.includes('clone')) {
        await Bun.write(join(args.at(-1)!, '.git/HEAD'), 'ref: refs/heads/main\n')
        return ''
      }
      if (args[0] === 'git' && args[1] === 'config') return ''
      throw new Error(`意外命令：${args.join(' ')}`)
    })
    await initialize(config, command)
    const clones = command.mock.calls.map(([args]) => args).filter((args) => args.includes('clone'))
    expect(clones.map((args) => args.slice(-3))).toEqual([
      ['main', 'https://gitlab.fixture/group/a.git', join(config.workspace, 'repos/group/a')],
      ['release', 'https://gitlab.fixture/group/b.git', join(config.workspace, 'repos/group/b')],
    ])
    const instructions = await Bun.file(join(config.workspace, 'AGENTS.md')).text()
    expect(instructions).toContain(join(config.workspace, 'repos/group/a'))
    expect(instructions).toContain(join(config.workspace, 'repos/group/b'))
    command.mockClear()
    await initialize(config, command)
    expect(command).not.toHaveBeenCalled()
  })
})
