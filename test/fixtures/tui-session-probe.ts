// @env node
import { writeFile } from 'node:fs/promises'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// Exercise real Pi session operations without a model or selector keystroke timing.
export default function tuiProbe(pi: ExtensionAPI): void {
  pi.registerCommand('tui-test', {
    description: 'Offline TUI smoke probe',
    handler: async (operation, ctx) => {
      const entry = ctx.sessionManager
        .getEntries()
        .find(
          (item) =>
            item.type === 'message' && (operation !== 'tree' || item.message.role === 'assistant'),
        )
      let cancelled: boolean | undefined
      switch (operation) {
        case 'new':
          cancelled = (await ctx.newSession()).cancelled
          break
        case 'resume':
          cancelled = (await ctx.switchSession(process.env.WORKBOT_TEST_OTHER_SESSION!)).cancelled
          break
        case 'fork':
          if (!entry) throw new Error('Missing fixture message')
          cancelled = (await ctx.fork(entry.id)).cancelled
          break
        case 'tree':
          if (!entry) throw new Error('Missing fixture message')
          cancelled = (await ctx.navigateTree(entry.id, { summarize: false })).cancelled
          break
      }
      await writeFile(
        process.env.WORKBOT_TEST_REPORT!,
        JSON.stringify({
          operation,
          cancelled,
          sessionId: ctx.sessionManager.getSessionId(),
          value: process.env.WORKBOT_TEST_VALUE,
          removed: process.env.WORKBOT_TEST_REMOVED,
          passwordPresent: 'PI_WEB_PASSWORD' in process.env,
          pid: process.pid,
        }),
      )
    },
  })
}
