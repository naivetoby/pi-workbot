// @env node
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

/** Only loaded by the managed TUI; its tmux name must keep identifying this session. */
export default function tuiSession(pi: ExtensionAPI): void {
  const keepSession = (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.hasUI)
      ctx.ui.notify('此终端固定当前会话；请退出 TUI 后在 GUI 新建、切换或分叉。', 'warning')
    return { cancel: true }
  }
  pi.on('session_before_switch', keepSession)
  pi.on('session_before_fork', keepSession)
}
