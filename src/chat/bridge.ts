// @env node
import { PI_CLI } from '../runtime/paths.ts'
import { run, withShutdown } from '../runtime/process.ts'

export const MESSAGE_PREFIX = '来自即时通讯的用户消息：\n'

export function bridgeInput(incoming: string[]): { args: string[]; prompt: string } {
  const args: string[] = []
  let prompt: string | undefined
  for (let index = 0; index < incoming.length; index++) {
    const value = incoming[index]!
    // bridge 的启动默认值不应覆盖 Pi 文件配置或已续接会话的选择。
    if (value === '--no-extensions') continue
    if (value === '--model' || value === '--provider') {
      index++
      continue
    }
    if (index === incoming.length - 1 && value.startsWith(MESSAGE_PREFIX)) {
      prompt = value.slice(MESSAGE_PREFIX.length)
    } else args.push(value)
  }
  if (prompt === undefined) throw new Error('缺少原生 bridge 消息正文')
  return { args, prompt }
}

export async function bridge(incoming: string[]): Promise<void> {
  const { args, prompt } = bridgeInput(incoming)
  const output = await withShutdown((signal) =>
    run([process.execPath, PI_CLI, ...args], {
      input: prompt,
      signal,
      env: { ...process.env, PI_CHANNELS_DISABLE_SESSION_AUTOSTART: '1' },
    }),
  )
  console.log(output)
}
