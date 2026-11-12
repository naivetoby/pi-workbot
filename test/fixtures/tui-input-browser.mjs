// Shared by the full TUI browser smoke and an isolated real-xterm event-sequence check.
import assert from 'node:assert/strict'
import { checkTerminalShellErase } from './terminal-shell-browser.mjs'
import { checkTerminalTheme } from './terminal-theme-browser.mjs'

export async function checkTerminalInput(page) {
  const results = await page.evaluate(async () => {
    const terminal = window.term
    const textarea = terminal.textarea
    const writes = []
    const subscription = terminal.onData((text) => writes.push(text))
    // Flush xterm's documented zero-delay textarea/composition tasks.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const key = (type, keyCode = 229, key = 'Unidentified') =>
      textarea.dispatchEvent(new KeyboardEvent(type, { key, keyCode, bubbles: true }))
    function commit(data, inputType = 'insertText', isComposing = false) {
      const options = { data, inputType, isComposing, bubbles: true, composed: true }
      const proceed = textarea.dispatchEvent(
        new InputEvent('beforeinput', { ...options, cancelable: true }),
      )
      if (proceed) {
        textarea.value += data
        textarea.dispatchEvent(new InputEvent('input', options))
      }
    }
    const results = {}
    try {
      for (const delayed of [false, true]) {
        writes.length = 0
        textarea.value = ''
        key('keydown')
        if (delayed) await flush()
        for (const text of ['中文', '中文', '日本語', '한국어', '😊']) commit(text)
        key('keyup')
        await flush()
        results[delayed ? 'candidateAfterKeyTimer' : 'candidateBeforeKeyTimer'] = [...writes]
      }
      writes.length = 0
      textarea.value = ''
      key('keydown')
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      textarea.dispatchEvent(
        new CompositionEvent('compositionupdate', { data: 'zhong', bubbles: true }),
      )
      commit('zhong', 'insertCompositionText', true)
      await flush()
      textarea.value = '中'
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '中', bubbles: true }))
      // Some browsers follow compositionend with an insertText for the same text.
      const trailing = new InputEvent('beforeinput', {
        data: '中',
        inputType: 'insertText',
        bubbles: true,
        cancelable: true,
      })
      textarea.dispatchEvent(trailing)
      textarea.dispatchEvent(
        new InputEvent('input', {
          data: '中',
          inputType: 'insertText',
          bubbles: true,
          composed: true,
        }),
      )
      key('keyup')
      await flush()
      results.inlineComposition = [...writes]
      results.trailingCancelled = trailing.defaultPrevented

      writes.length = 0
      textarea.value = ''
      key('keydown', 65, 'A')
      textarea.dispatchEvent(
        new KeyboardEvent('keypress', { key: 'A', charCode: 65, bubbles: true }),
      )
      commit('A')
      key('keyup', 65, 'A')
      await flush()
      results.physicalKey = [...writes]

      writes.length = 0
      textarea.value = ''
      commit('无按键😊')
      await flush()
      results.withoutKey = [...writes]
      return results
    } finally {
      subscription.dispose()
      textarea.value = ''
      terminal.input('\u0015', true)
    }
  })
  const expected = ['中文', '中文', '日本語', '한국어', '😊']
  assert.deepEqual(
    results.candidateAfterKeyTimer,
    expected,
    '延迟确认的候选栏文本必须逐次且仅发送一次',
  )
  assert.deepEqual(
    results.candidateBeforeKeyTimer,
    expected,
    '尚未执行的 xterm 差分定时器不能重复发送',
  )
  assert.deepEqual(results.inlineComposition, ['中'], '原生输入框组合输入不能丢字或重复')
  assert.equal(results.trailingCancelled, false, 'compositionend 后的事件仍交给 xterm')
  assert.deepEqual(results.physicalKey, ['A'], '物理键不能重复发送')
  assert.deepEqual(results.withoutKey, ['无按键😊'])
}

// Useful without ttyd/caddy: this still runs the pinned xterm in a real browser,
// but synthetic event traces do not replace iOS/Android keyboard acceptance.
if (import.meta.main) {
  const { chromium } = await import('../../.cache/pi-web/node_modules/playwright/index.mjs')
  const bundle = await Bun.build({
    entrypoints: ['.cache/pi-web/lib/workbot-terminal-input.ts'],
    target: 'browser',
  })
  if (!bundle.success) throw new AggregateError(bundle.logs, '输入适配编译失败')
  const browser = await chromium.launch({
    executablePath: process.env.WORKBOT_CHROME_BIN,
    headless: true,
  })
  try {
    // Pi Web 内置终端启用读屏模式，独立 TUI 关闭；两者的原生 input 路径不同。
    for (const screenReaderMode of [false, true]) {
      const page = await browser.newPage()
      try {
        await page.setContent('<div id="terminal"></div>')
        await page.addScriptTag({ path: '.cache/pi-web/node_modules/@xterm/xterm/lib/xterm.js' })
        await page.evaluate(
          async ({ source, screenReaderMode }) => {
            const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
            try {
              const { attachTerminalInput } = await import(url)
              window.term = new window.Terminal({ screenReaderMode })
              window.term.open(document.getElementById('terminal'))
              attachTerminalInput(window.term)
            } finally {
              URL.revokeObjectURL(url)
            }
          },
          { source: await bundle.outputs[0].text(), screenReaderMode },
        )
        await checkTerminalInput(page)
        await checkTerminalShellErase(page)
        await checkTerminalTheme(page)
        console.log(
          `PASS: 真实 xterm screenReaderMode=${screenReaderMode} 候选提交、组合输入、物理键去重、Bash 中文删除重绘及 Pi 主题切换`,
        )
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
}
