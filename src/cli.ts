// @env node
import { bridge } from './chat/bridge.ts'
import { chat } from './chat/host.ts'
import { startWeb, stopWeb, webPid } from './chat/web.ts'
import { code } from './code/run.ts'
import { applyRuntime, runtime } from './runtime/config.ts'
import { initialize } from './runtime/init.ts'
import { withShutdown } from './runtime/process.ts'
import { dispatch } from './tasks/collaboration.ts'
import type { Role } from './runtime/types.ts'

export async function main(args: string[]): Promise<void> {
  const [command = 'help', ...rest] = args
  if (command === 'bridge') {
    await bridge(rest)
    return
  }
  const role: Role = command === 'code' || process.env.WORKBOT_ROLE === 'code' ? 'code' : 'chat'
  const config = runtime(role)
  applyRuntime(config)
  switch (command) {
    case 'init':
      await initialize(config)
      break
    case 'chat':
      await initialize(config)
      await chat(config)
      break
    case 'code':
      await withShutdown((signal) => code(config, signal))
      break
    case 'dispatch':
      console.log((await dispatch(rest[0] || '', rest.slice(1))).web_url)
      break
    case 'web':
      if (rest[0] === 'start') console.log(await startWeb(config))
      else if (rest[0] === 'stop') console.log(await stopWeb(config))
      else if (!rest[0] || rest[0] === 'status')
        console.log((await webPid(config)) ? 'Web 正在运行' : 'Web 未运行')
      else throw new Error('用法：web start|stop|status')
      break
    default:
      console.log(
        '用法：bun src/cli.ts chat|code|init|web start|stop|status|dispatch 中心项目#IID 目标项目 ...',
      )
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
