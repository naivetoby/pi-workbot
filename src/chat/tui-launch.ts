// @env node
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// A private, short-lived file keeps credentials out of tmux's command arguments.
// Replace the launcher rather than keeping a supervisor process for every Pi.
const [snapshot, cli, session] = process.argv.slice(2)
if (!snapshot || !cli || !session) throw new Error('缺少 TUI 启动参数')
let value: unknown
try {
  const source = readFileSync(snapshot, 'utf8')
  unlinkSync(snapshot)
  value = JSON.parse(source)
} catch {
  throw new Error('无法读取 TUI 运行环境')
}
if (
  !value ||
  typeof value !== 'object' ||
  Array.isArray(value) ||
  !Object.values(value).every((entry) => typeof entry === 'string')
)
  throw new Error('无效的 TUI 运行环境')
const env = value as Record<string, string>
delete env.PI_WEB_PASSWORD
// Only terminal metadata comes from tmux, never its older runtime credentials.
for (const key of ['TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TMUX', 'TMUX_PANE']) {
  const entry = process.env[key]
  if (entry !== undefined) env[key] = entry
}
env.PI_CLIPBOARD_OSC52 = '1'
env.PI_CHANNELS_DISABLE_SESSION_AUTOSTART = '1'
if (!process.execve) throw new Error('当前 Bun 不支持 execve，请升级 Bun')
process.execve(
  process.execPath,
  [
    process.execPath,
    cli,
    '--session',
    session,
    '--extension',
    join(import.meta.dir, 'tui-session.ts'),
  ],
  env,
)
