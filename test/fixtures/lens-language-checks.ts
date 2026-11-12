// @env node
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionRunner } from '@earendil-works/pi-coding-agent'

interface Diagnostics {
  diagnostics: { message: string }[]
  primaryDiagnosticsCount: number
  cleanFiles: number
  totalDiagnostics: number
  outcomeCounts: { clean?: number }
}

export function diagnosticsDetails(value: unknown): Diagnostics | undefined {
  if (!value || typeof value !== 'object') return
  if (!('diagnostics' in value) || !Array.isArray(value.diagnostics)) return
  if (
    !value.diagnostics.every(
      (item) => item && typeof item === 'object' && typeof item.message === 'string',
    )
  )
    return
  for (const key of ['primaryDiagnosticsCount', 'cleanFiles', 'totalDiagnostics']) {
    if (!(key in value) || typeof Reflect.get(value, key) !== 'number') return
  }
  if (
    !('outcomeCounts' in value) ||
    !value.outcomeCounts ||
    typeof value.outcomeCounts !== 'object'
  )
    return
  if ('clean' in value.outcomeCounts && typeof value.outcomeCounts.clean !== 'number') return
  return value as Diagnostics
}

async function waitForDiagnostics(
  runner: ExtensionRunner,
  path: string,
  label: string,
  ready: (details: Diagnostics) => boolean,
): Promise<Diagnostics> {
  const tool = runner.getToolDefinition('lens_diagnostics')
  assert(tool, 'lens_diagnostics 必须真实注册')
  const deadline = Date.now() + 60_000
  let result: unknown
  do {
    result = await tool.execute(
      label,
      { source: 'lsp', scope: 'paths', paths: [path], serverScope: 'primary', waitMs: 5000 },
      undefined,
      undefined,
      runner.createToolContext(label, undefined),
    )
    if (result && typeof result === 'object' && !('isError' in result && result.isError)) {
      const details = diagnosticsDetails('details' in result ? result.details : undefined)
      if (details && ready(details)) return details
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  } while (Date.now() < deadline)
  const log = join(process.env.PI_LENS_HOME!, 'sessionstart.log')
  const recent = existsSync(log) ? readFileSync(log, 'utf8').slice(-8000) : 'no session log'
  throw new Error(`${label}: 未收到预期诊断；最近结果 ${JSON.stringify(result)}\n${recent}`)
}

const cases = [
  [
    'typed.ts',
    'export const value: number = "bad";\n',
    'export const value: number = 1;\n',
    'not assignable',
  ],
  ['typed.py', 'value: int = "bad"\n', 'value: int = 1\n', 'not assignable'],
  ['sample.json', '{"value": }\n', '{"value": 1}\n', 'Value expected'],
  ['sample.yaml', 'value: [\n', 'value: 1\n', 'sequence'],
  ['sample.css', 'a { color: ; }\n', 'a { color: red; }\n', 'value expected'],
  [
    'sample.cpp',
    'int main() { return unknown_identifier; }\n',
    'int main() { return 0; }\n',
    'unknown_identifier',
  ],
  [
    'java/src/Main.java',
    'public class Main { int value = "bad"; }\n',
    'public class Main { int value = 1; }\n',
    'convert',
  ],
] as const

export function prepareLanguageFixtures(cwd: string): void {
  writeFileSync(join(cwd, 'package.json'), '{"private":true,"type":"module"}')
  writeFileSync(
    join(cwd, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['typed.ts'],
    }),
  )
  writeFileSync(join(cwd, 'pyrightconfig.json'), '{"include":["typed.py"]}')
  // Eclipse 项目只验证 JDT LS；不把业务 Maven 依赖下载混入禁网验收。
  mkdirSync(join(cwd, 'java/src'), { recursive: true })
  writeFileSync(
    join(cwd, 'java/.project'),
    '<projectDescription><name>lens-java-check</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>',
  )
  writeFileSync(
    join(cwd, 'java/.classpath'),
    '<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>',
  )
  for (const [file, bad] of cases) writeFileSync(join(cwd, file), bad)
}

export async function verifyLanguageServers(runner: ExtensionRunner, cwd: string): Promise<void> {
  for (const [file, bad, good, expected] of cases) {
    const path = join(cwd, file)
    assert.equal(readFileSync(path, 'utf8'), bad, `${file}: 初始错误样例必须存在`)
    const errors = await waitForDiagnostics(runner, path, `${file} 错误样例`, (details) =>
      details.diagnostics.some((d) => d.message.toLowerCase().includes(expected.toLowerCase())),
    )
    assert(errors.primaryDiagnosticsCount > 0, `${file}: 辅助扫描不能替代语言检查`)
    console.log(`PASS LSP ${file}: ${errors.diagnostics.map((d) => d.message).join('; ')}`)

    writeFileSync(path, good)
    const fixed = await waitForDiagnostics(
      runner,
      path,
      `${file} 修复样例`,
      (details) => details.cleanFiles === 1 && details.totalDiagnostics === 0,
    )
    assert.equal(fixed.outcomeCounts.clean, 1, `${file}: 不能把不确定当通过`)
    console.log(`PASS LSP ${file}: fixed and confirmed clean`)
  }

  const html = join(cwd, 'navigation.html')
  writeFileSync(
    html,
    '<!DOCTYPE html><html><head><title>Probe</title></head><body><div id="probe-section"></div></body></html>',
  )
  const navigation = runner.getToolDefinition('lsp_navigation')
  assert(navigation, 'lsp_navigation 必须真实注册')
  const symbols = await navigation.execute(
    'html-symbols',
    { operation: 'documentSymbol', path: html },
    undefined,
    undefined,
    runner.createToolContext('html-symbols', undefined),
  )
  assert(
    !('isError' in symbols && symbols.isError) && JSON.stringify(symbols).includes('probe-section'),
    JSON.stringify(symbols),
  )
  console.log('PASS HTML LSP: document symbols')
}
