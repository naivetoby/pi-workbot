// @env node
import { expect, it } from 'bun:test'
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import type { ToolCall } from '@earendil-works/pi-ai'
import workbot from '../src/chat/extension.ts'
import { fixture } from './helpers.ts'

it('Pi 原生参数校验兼容 dispatch_code 的 TypeBox schema，保留必填与目标数量约束', async () => {
  const config = await fixture()
  const loader = new DefaultResourceLoader({
    cwd: config.workspace,
    agentDir: config.piDir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [workbot],
  })
  await loader.reload()
  const { extensions, errors } = loader.getExtensions()
  expect(errors).toEqual([])
  const tool = extensions
    .flatMap((extension) => [...extension.tools.values()])
    .find((tool) => tool.definition.name === 'dispatch_code')!.definition
  const validate = (args: ToolCall['arguments']) =>
    validateToolArguments(tool, {
      type: 'toolCall',
      id: 'compat',
      name: tool.name,
      arguments: args,
    })

  expect(validate({ issue: 'group/control#1', projects: ['group/project'] })).toEqual({
    issue: 'group/control#1',
    projects: ['group/project'],
  })
  // Pi 1.5 的 JSON Schema 校验会将单值转成数组；派发业务约束仍由 dispatch 检查。
  expect(validate({ issue: 'group/control#1', projects: 'group/project' })).toEqual({
    issue: 'group/control#1',
    projects: ['group/project'],
  })
  expect(() => validate({ projects: ['group/project'] })).toThrow()
  expect(() => validate({ issue: 'group/control#1', projects: [] })).toThrow()
  expect(() =>
    validate({ issue: 'group/control#1', projects: Array(11).fill('group/project') }),
  ).toThrow()
})
