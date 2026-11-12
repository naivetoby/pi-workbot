// @env node
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function localExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'local_fixture_tool',
    label: 'fixture',
    description: 'local fixture',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'fixture' }], details: undefined }),
  })
}
