// @env node
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent'
import { ROOT } from '../src/runtime/paths.ts'
import { initialize } from '../src/runtime/init.ts'
import type { Runtime } from '../src/runtime/types.ts'

const role = process.argv[2]
if (role !== 'chat' && role !== 'code')
  throw new Error('用法：bun scripts/smoke-assets.ts chat|code')
const sharedSource = join(ROOT, 'configs/shared')
const root = await mkdtemp(join(tmpdir(), `workbot-${role}-assets-`))
// 显式检查角色和共享资产，但不继承维护者的凭证、个人目录或项目清单。
process.env = {
  PATH: process.env.PATH,
  HOME: root,
  TMPDIR: process.env.TMPDIR,
  PI_OFFLINE: '1',
  PI_TELEMETRY: '0',
  PI_CHANNELS_DISABLE_SESSION_AUTOSTART: '1',
  OPENAI_RELAY_BASE_URL: 'https://relay.example.invalid/v1',
}
const config: Runtime = {
  role,
  piDir: join(root, 'pi'),
  workspace: join(root, 'workspace'),
  configSource: join(ROOT, 'configs', role),
  sharedSource,
  projectsFile: join(root, 'projects.json'),
}
try {
  const sourceSettings = await Bun.file(join(config.configSource, 'settings.json')).json()
  const sourceSkills = await readdir(join(sharedSource, 'skills'), { withFileTypes: true })
  const expectedSkills = []
  for (const entry of sourceSkills) {
    if (
      entry.isDirectory() &&
      (await Bun.file(join(entry.parentPath, entry.name, 'SKILL.md')).exists())
    ) {
      expectedSkills.push(entry.name)
    }
  }
  await Bun.write(config.projectsFile, '[]')
  await initialize(config)
  for (const name of ['models.json', 'mcp.json']) {
    const roleFile = Bun.file(join(config.configSource, name))
    const source = (await roleFile.exists()) ? roleFile : Bun.file(join(sharedSource, name))
    if (await source.exists()) {
      const expected = await source.json()
      if (
        name === 'models.json' &&
        expected.providers?.['openai-relay']?.baseUrl === '${OPENAI_RELAY_BASE_URL}'
      )
        expected.providers['openai-relay'].baseUrl = process.env.OPENAI_RELAY_BASE_URL
      assert.deepEqual(await Bun.file(join(config.piDir, name)).json(), expected, name)
    }
  }
  const settingsManager = SettingsManager.create(config.workspace, config.piDir, {
    projectTrusted: false,
  })
  const loader = new DefaultResourceLoader({
    cwd: config.workspace,
    agentDir: config.piDir,
    settingsManager,
  })
  await loader.reload()
  const { extensions, errors } = loader.getExtensions()
  assert.deepEqual(errors, [], `所有插件都应离线加载成功；先运行 prepare:pi configs/${role}`)
  const settings = await Bun.file(join(config.piDir, 'settings.json')).json()
  for (const source of settings.packages as string[]) {
    const name = source.slice(4, source.lastIndexOf('@'))
    assert(
      extensions.some((extension) => extension.path.includes(`/node_modules/${name}/`)),
      name,
    )
  }
  const tools = new Set(extensions.flatMap((extension) => [...extension.tools.keys()]))
  for (const name of ['todo', 'symbol_search', 'web_search', 'subagent']) {
    assert(tools.has(name), `应注册完整工具：${name}`)
  }
  assert.equal(tools.has('dispatch_code'), role === 'chat', 'code 不加载 chat 的协作扩展')
  if (role === 'code') assert.equal(settings['pi-channels'], undefined)
  const { skills, diagnostics } = loader.getSkills()
  assert.deepEqual(diagnostics, [])
  assert.equal(
    skills.filter((skill) => skill.filePath.startsWith(join(config.piDir, 'skills/'))).length,
    expectedSkills.length,
  )
  for (const key of ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'packages']) {
    assert.deepEqual(settings[key], sourceSettings[key], `初始化不应覆盖 ${key}`)
  }
  console.log(
    `PASS: ${role} ${settings.packages.length} 个固定版本插件、${skills.length} 个 Skills 和完整工具离线加载`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
