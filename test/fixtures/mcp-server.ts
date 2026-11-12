// @env node
import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line) as {
    id?: number | string
    method: string
    params?: { protocolVersion?: string }
  }
  if (request.id === undefined) return
  let result: unknown
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      }
      break
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'echo_fixture',
            description: 'Local MCP fixture',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }
      break
    default:
      result = { content: [{ type: 'text', text: 'local MCP result' }] }
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
})
