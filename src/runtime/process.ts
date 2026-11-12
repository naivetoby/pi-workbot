// @env node
import { spawn } from 'node:child_process'
import type { Command } from './types.ts'

export const run: Command = (args, options = {}) =>
  new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    const child = spawn(args[0]!, args.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['pipe', options.inherit ? 'inherit' : 'pipe', 'inherit'],
    })
    let output = ''
    let force: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    const abort = (): void => {
      kill('SIGTERM')
      force = setTimeout(() => kill('SIGKILL'), 5_000)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input)
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', abort)
      if (force) clearTimeout(force)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code) => {
      if (options.signal?.aborted) kill('SIGKILL')
      cleanup()
      if (options.signal?.aborted) reject(new Error('进程已取消'))
      else if (code !== 0) reject(new Error(`${args[0]} 退出码 ${code}\n${output}`))
      else resolve(output.trim())
    })
  })

export async function withShutdown<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    return await action(controller.signal)
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}
