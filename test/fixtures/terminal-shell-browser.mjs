// Real browser -> terminal input -> Bun PTY -> Bash -> xterm screen, without a model.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function checkTerminalShellErase(page) {
  const root = await mkdtemp(join(tmpdir(), 'workbot-shell-'))
  let child
  let pending = ''
  let recent = ''
  const prompt = 'workbot-shell> '
  const decoder = new TextDecoder()
  async function screen() {
    const data = pending
    pending = ''
    return page.evaluate(async (data) => {
      const terminal = window.term
      if (data) await new Promise((resolve) => terminal.write(data, resolve))
      const buffer = terminal.buffer.active
      return {
        line: buffer
          .getLine(buffer.baseY + buffer.cursorY)
          .translateToString(true)
          .trimEnd(),
        cursorX: buffer.cursorX,
      }
    }, data)
  }
  async function waitForShellScreen(label, check) {
    const deadline = Date.now() + 5000
    let current
    do {
      current = await screen()
      if (check(current)) return current
      await Bun.sleep(10)
    } while (Date.now() < deadline)
    throw new Error(`${label}: ${JSON.stringify({ screen: current, output: recent.slice(-2000) })}`)
  }
  async function sendInput() {
    const data = await page.evaluate(() => window.shellWrites.splice(0).join(''))
    child.terminal.write(data)
    return data
  }
  try {
    await page.evaluate(() => {
      window.term.reset()
      window.term.focus()
      window.shellWrites = []
      window.shellSubscription = window.term.onData((data) => window.shellWrites.push(data))
    })
    // Skip host profiles/history; exercise the same Bash readline and UTF-8 path as the image.
    child = Bun.spawn(['/bin/bash', '--noprofile', '--norc', '-i'], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        HISTFILE: '/dev/null',
        BASH_SILENCE_DEPRECATION_WARNING: '1',
        TERM: 'xterm-256color',
        LANG: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
        PS1: prompt,
      },
      terminal: {
        cols: 80,
        rows: 24,
        data: (_, bytes) => {
          const text = decoder.decode(bytes, { stream: true })
          pending += text
          recent += text
        },
      },
    })
    await waitForShellScreen('Bash prompt', ({ line }) => line === prompt.trimEnd())
    for (const text of ['中文', '中A文', '日本語', '한국어']) {
      await page.evaluate((text) => {
        const textarea = window.term.textarea
        textarea.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, bubbles: true }))
        textarea.dispatchEvent(
          new InputEvent('beforeinput', {
            data: text,
            inputType: 'insertText',
            bubbles: true,
            cancelable: true,
          }),
        )
        textarea.dispatchEvent(new KeyboardEvent('keyup', { keyCode: 229, bubbles: true }))
      }, text)
      assert.equal(await sendInput(), text, '候选文本应完整到达 PTY')
      const typed = await waitForShellScreen('候选文本回显', ({ line }) => line === prompt + text)
      assert.equal(typed.line, prompt + text)
      for (const _ of text) await page.keyboard.press('Backspace')
      assert.equal(await sendInput(), '\x7f'.repeat([...text].length), '每次退格只发送一次')
      const erased = await waitForShellScreen(
        '删除后清除所有残字',
        ({ line, cursorX }) => line === prompt.trimEnd() && cursorX === prompt.length,
      )
      assert.equal(erased.line, prompt.trimEnd(), '回车前屏幕就应没有残留汉字')
      assert.equal(erased.cursorX, prompt.length, '光标应回到提示符之后')
      await page.keyboard.press('Enter')
      await sendInput()
      await waitForShellScreen('空行回车后仍可输入', ({ line }) => line === prompt.trimEnd())
    }
  } finally {
    try {
      if (child) {
        child.kill('SIGKILL')
        await child.exited
        child.terminal.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      await page.evaluate(() => window.shellSubscription?.dispose())
    }
  }
}
