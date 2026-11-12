// @env node
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { runtime } from '../runtime/config.ts'
import { dispatch } from '../tasks/collaboration.ts'
import { startWeb, stopWeb, webPid } from './web.ts'

export default function workbot(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'dispatch_code',
    label: '派发 code Job',
    description:
      '仅在当前用户明确确认中心 Issue 和完整目标集合后使用。首次与返工均需确认。目标可附 !MR编号。只派发一个 Job，不自动 Review 或返工。响应未知时不要重试。',
    parameters: Type.Object({
      issue: Type.String(),
      projects: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
    }),
    async execute(_id, input) {
      const pipeline = await dispatch(input.issue, input.projects)
      return { content: [{ type: 'text', text: `已派发 ${pipeline.web_url}` }], details: pipeline }
    },
  })
  pi.registerCommand('workbot', {
    description: '确认执行：/workbot 中心项目#IID 目标项目 ...（可附 !MR编号）',
    handler: async (args) => {
      const [issue, ...projects] = args.trim().split(/\s+/)
      const pipeline = await dispatch(issue || '', projects)
      pi.sendMessage({
        customType: 'workbot',
        content: `已派发 ${pipeline.web_url}`,
        display: true,
      })
    },
  })
  pi.registerCommand('workbot-web', {
    description: '按需管理 Web：start | stop | status',
    handler: async (args) => {
      const config = runtime('chat')
      let text: string
      switch (args.trim() || 'status') {
        case 'start':
          text = await startWeb(config)
          break
        case 'stop':
          text = await stopWeb(config)
          break
        case 'status':
          text = (await webPid(config)) ? 'Web 正在运行' : 'Web 未运行'
          break
        default:
          throw new Error('用法：/workbot-web start|stop|status')
      }
      pi.sendMessage({ customType: 'workbot', content: text, display: true })
    },
  })
}
