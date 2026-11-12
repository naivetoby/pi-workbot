// @env node
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ROOT, WEB_DIR } from '../src/runtime/paths.ts'
import { run } from '../src/runtime/process.ts'
import { prepareWeb } from './prepare-web.ts'

// Keep the backend pinned; the page reuses the same Pi Web sources and dependencies.
const commit = '2922cb89f518bae4d0fcf4d757a7419638fc71fc'
const archive = join(ROOT, `terminal/ttyd-${commit}.tar.gz`)
const expected = (await Bun.file(`${archive}.sha256`).text()).trim().split(/\s+/)[0]
const actual = createHash('sha256')
  .update(await Bun.file(archive).bytes())
  .digest('hex')
if (actual !== expected) throw new Error('ttyd 源码包 SHA-256 校验失败')
await prepareWeb()
await run([
  process.execPath,
  join(WEB_DIR, 'node_modules/typescript/bin/tsc'),
  '--noEmit',
  '--project',
  join(WEB_DIR, 'tsconfig.json'),
])
const result = await Bun.build({
  entrypoints: [join(WEB_DIR, 'components/WorkbotTui.tsx')],
  tsconfig: join(WEB_DIR, 'tsconfig.json'),
  target: 'browser',
  format: 'iife',
  minify: true,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})
if (!result.success) throw new AggregateError(result.logs, 'TUI 前端编译失败')
const script = result.outputs.find((output) => output.type.includes('javascript'))
const css = result.outputs.find((output) => output.type.includes('css'))
if (!script || !css) throw new Error('TUI 前端缺少脚本或样式')

// Reuse the pinned terminal styles, rather than maintaining a second mobile toolbar/theme.
const upstream = await Bun.file(join(WEB_DIR, 'app/globals.css')).text()
const terminalStyles = upstream.match(
  /\.terminal-panel \{[\s\S]*?(?=\/\*\n \* Chromium-only scrollbars)/,
)?.[0]
const fontStyles = upstream.match(/:root \{\n  --font-ui-default:[\s\S]*?\n\}/)?.[0]
if (!terminalStyles || !fontStyles) throw new Error('pi-web 终端样式边界变化，请核对适配')
const font = Buffer.from(
  await Bun.file(join(ROOT, 'web/fonts/NotoSansMono.woff2')).bytes(),
).toString('base64')
const styles = [
  `@font-face{font-family:"Noto Sans Mono";font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${font}) format("woff2")}`,
  await css.text(),
  fontStyles,
  terminalStyles,
  await Bun.file(join(ROOT, 'terminal/client.css')).text(),
].join('\n')
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="mobile-web-app-capable" content="yes"><title>Pi TUI</title>
<style>${styles}</style></head><body><div id="root"></div>
<script>${(await script.text()).replace(/<\/script/gi, '<\\/script')}</script></body></html>`
await Bun.write(join(ROOT, '.cache/ttyd/index.html'), html)
console.log(`Pi Web 适配的 ttyd 页面 ${commit} 已准备`)
