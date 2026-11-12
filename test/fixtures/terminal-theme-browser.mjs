// Real xterm + the built-in PTY backend + offline Pi; no ttyd/Caddy or model needed.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager, getPackageDir } from '@earendil-works/pi-coding-agent'
import {
  createTerminal,
  killTerminal,
  subscribeTerminal,
  syncTerminalTheme,
  writeTerminal,
} from '../../.cache/pi-web/lib/terminal-manager.ts'

export async function checkTerminalTheme(page) {
  const root = await mkdtemp('/tmp/workbot-theme-browser-')
  const savedEnv = { ...process.env }
  let id
  let subscription
  let output = Promise.resolve()
  let recent = ''
  async function waitFor(label, check) {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await check()) return
      await Bun.sleep(25)
    }
    throw new Error(`${label} timed out: ${JSON.stringify(recent.slice(-4000))}`)
  }
  try {
    process.env = {
      PATH: savedEnv.PATH,
      HOME: root,
      SHELL: '/bin/bash',
      PI_CODING_AGENT_DIR: join(root, 'pi'),
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
    }
    const session = SessionManager.create(root, join(root, 'sessions'))
    session.appendMessage({ role: 'user', content: 'theme-browser-user', timestamp: Date.now() })
    const bundle = await Bun.build({
      entrypoints: ['.cache/pi-web/lib/workbot-terminal-theme.ts'],
      target: 'browser',
    })
    if (!bundle.success) throw new AggregateError(bundle.logs, '主题适配编译失败')
    id = createTerminal(root, 100, 40)
    await page.exposeFunction('themeFixtureInput', (data) => writeTerminal(id, data))
    await page.exposeFunction('themeFixtureChange', (theme) => {
      syncTerminalTheme(id, theme)
    })
    await page.evaluate(
      async (source) => {
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        try {
          const { createTerminalThemeSync } = await import(url)
          window.makeThemeSync = (theme) =>
            createTerminalThemeSync(window.term, theme, window.themeFixtureChange, (error) => {
              window.themeErrors.push(error.message)
            })
          window.themeErrors = []
          window.term.reset()
          window.term.resize(100, 40)
          window.themeSync = window.makeThemeSync('dark')
          await window.themeSync.setTheme('dark')
          window.themeSync.setConnected(true)
          window.themeInput = window.term.onData((data) => void window.themeFixtureInput(data))
        } finally {
          URL.revokeObjectURL(url)
        }
      },
      await bundle.outputs[0].text(),
    )
    const receive = (event) => {
      if (event.type !== 'output') return
      recent = (recent + event.data).slice(-100_000)
      output = output.then(() =>
        page.evaluate(
          (data) =>
            new Promise((resolve) => {
              window.term.write(data, resolve)
            }),
          event.data,
        ),
      )
    }
    subscription = subscribeTerminal(id, receive)
    receive(subscription.output)
    writeTerminal(id, "PS1='theme-shell$ '; printf 'theme-shell-ready\\n'\r")
    await waitFor('Bash ready', () => recent.includes('\r\ntheme-shell-ready\r\n'))
    await page.evaluate(() => window.themeSync.setTheme('light'))
    assert.doesNotMatch(recent, /\?997;/, '主题切换不能写进 shell 提示符')

    const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
    writeTerminal(
      id,
      [
        process.execPath,
        join(getPackageDir(), 'dist/bundle/cli.js'),
        '--no-extensions',
        '--session',
        session.getSessionFile(),
      ]
        .map(quote)
        .join(' ') + '\r',
    )
    await waitFor('Pi ready', () => recent.includes('theme-browser-user'))
    const userColor = () =>
      page.evaluate(() => {
        const buffer = window.term.buffer.active
        for (let row = 0; row < buffer.length; row++) {
          const line = buffer.getLine(row)
          const column = line.translateToString().indexOf('theme-browser-user')
          if (column < 0) continue
          const cell = line.getCell(column)
          if (!cell.isBgRGB()) continue
          const value = cell.getBgColor()
          return [value >> 16, (value >> 8) & 255, value & 255]
        }
      })
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => window.themeSync.setTheme(theme), theme)
      await waitFor(`${theme} user block`, async () => {
        const rgb = await userColor()
        return rgb && (theme === 'light' ? Math.min(...rgb) > 200 : Math.max(...rgb) < 100)
      })
      const rgb = await userColor()
      assert.ok(theme === 'light' ? Math.min(...rgb) > 200 : Math.max(...rgb) < 100)
    }
    // Restore the same output as a refreshed page, without sending initialization input.
    await output
    await page.evaluate(() => {
      window.themeSync.dispose()
      window.term.reset()
      window.term.options.disableStdin = true
    })
    const replay = subscribeTerminal(id, () => {})
    replay.unsubscribe()
    await page.evaluate(
      (data) => new Promise((resolve) => window.term.write(data, resolve)),
      replay.output.data,
    )
    await page.evaluate(() => {
      window.term.options.disableStdin = false
      window.themeSync = window.makeThemeSync('light')
      window.themeSync.setConnected(true)
      return window.themeSync.setTheme('dark')
    })
    await waitFor('switch after refresh', async () => {
      const rgb = await userColor()
      return rgb && Math.max(...rgb) < 100
    })
    assert.ok(Math.max(...(await userColor())) < 100)
    assert.deepEqual(await page.evaluate(() => window.themeErrors), [])
    recent = ''
    writeTerminal(id, '\x04')
    await waitFor(
      'Pi exits to Bash',
      () => recent.includes('\x1b[?2031l') && recent.endsWith('theme-shell$ '),
    )
    recent = ''
    await page.evaluate(() => window.themeSync.setTheme('light'))
    writeTerminal(id, "printf 'theme-shell-returned\\n'\r")
    await waitFor('Bash still accepts commands', () =>
      recent.includes('\r\ntheme-shell-returned\r\n'),
    )
    assert.doesNotMatch(recent, /\?997;/, 'Pi 退出后切换主题不能污染 shell')
  } finally {
    await page
      .evaluate(() => {
        window.themeSync?.dispose()
        window.themeInput?.dispose()
      })
      .catch(() => {})
    subscription?.unsubscribe()
    if (id) killTerminal(id, true)
    await output.catch(() => {})
    process.env = savedEnv
    await rm(root, { recursive: true, force: true })
  }
}
