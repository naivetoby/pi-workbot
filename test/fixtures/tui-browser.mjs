// Real browser check, invoked by smoke-tui.ts --browser. No model/network calls.
import assert from 'node:assert/strict'
import { checkTerminalInput } from './tui-input-browser.mjs'
import { chromium } from '../../.cache/pi-web/node_modules/playwright/index.mjs'

const [base, sessionId] = process.argv.slice(2)
const cookie = process.env.WORKBOT_TEST_COOKIE
const browser = await chromium.launch({
  executablePath: process.env.WORKBOT_CHROME_BIN,
  headless: true,
})
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 850 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  await context.addInitScript(() => {
    window.clipboardWrites = []
    const write = navigator.clipboard.writeText.bind(navigator.clipboard)
    navigator.clipboard.writeText = async (text) => {
      await write(text)
      window.clipboardWrites.push(text)
    }
  })
  const split = cookie.indexOf('=')
  await context.addCookies([
    { name: cookie.slice(0, split), value: cookie.slice(split + 1), url: base },
  ])
  const themeRequests = []
  context.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/workbot-terminal/theme')
      themeRequests.push(request)
  })
  const gui = await context.newPage()
  const sdkRequests = []
  gui.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(`/api/agent/${sessionId}`))
      sdkRequests.push(request.method())
  })
  await gui.goto(`${base}/?session=${sessionId}`)
  await gui
    .getByText('此会话已在 TUI 中打开，当前页面仅供查看。')
    .waitFor()
    .catch(async (error) => {
      console.error(await gui.locator('body').innerText())
      throw error
    })
  assert.equal(sdkRequests.length, 0, '只读页面不能启动 SDK 或 agent SSE')
  const popup = context.waitForEvent('page')
  const tuiLink = gui.getByRole('link', { name: '打开 TUI ↗', exact: true })
  assert.equal(await tuiLink.evaluate((link) => getComputedStyle(link).marginLeft), '0px')
  await tuiLink.click()
  const terminal = await popup
  const rendered = () =>
    terminal.waitForFunction(() => {
      const buffer = window.term?.buffer.active
      return (
        buffer &&
        Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString())
          .join('\n')
          .includes('terminal-smoke-0')
      )
    })
  async function waitForUserTheme(theme) {
    await terminal
      .waitForFunction((expected) => {
        const buffer = window.term?.buffer.active
        if (!buffer) return false
        for (let row = 0; row < buffer.length; row++) {
          const line = buffer.getLine(row)
          const column = line.translateToString().indexOf('terminal-smoke-0')
          if (column < 0) continue
          const cell = line.getCell(column)
          if (cell.isBgDefault()) return false
          const value = cell.getBgColor()
          let rgb
          if (cell.isBgRGB()) rgb = [value >> 16, (value >> 8) & 255, value & 255]
          else if (value >= 232) rgb = Array(3).fill(8 + (value - 232) * 10)
          else if (value >= 16) {
            const cube = [0, 95, 135, 175, 215, 255]
            rgb = [
              Math.floor((value - 16) / 36),
              Math.floor((value - 16) / 6) % 6,
              (value - 16) % 6,
            ].map((n) => cube[n])
          } else return false
          return expected === 'light' ? Math.min(...rgb) > 200 : Math.max(...rgb) < 100
        }
        return false
      }, theme)
      .catch(async (error) => {
        console.error(`用户消息背景未切换为 ${theme}:`, await terminal.locator('body').innerText())
        throw error
      })
  }
  await rendered()
  await terminal.waitForFunction(() => window.term.options.fontSize === 13)
  assert.equal(themeRequests.length, 0, '启动不能主动发送主题控制序列')
  const columnsBefore = await terminal.evaluate(() => {
    window.fixtureTerm = window.term
    return window.term.cols
  })
  await gui.evaluate(() => {
    localStorage.setItem('pi-chat-content-font-size', '18')
    localStorage.setItem('pi-mono-font-family', 'monospace')
    localStorage.setItem('pi-mono-font-weight', '600')
    localStorage.setItem('pi-web:terminal-theme', 'light')
  })
  await terminal.waitForFunction(
    () =>
      window.term.options.fontSize === 17 &&
      window.term.options.fontWeight === 600 &&
      window.term.options.fontFamily.startsWith('monospace') &&
      window.term.options.theme.background === '#fbfbfc',
  )
  await waitForUserTheme('light')
  assert(
    (await terminal.evaluate(() => window.term.cols)) < columnsBefore,
    '字体变化需要重新适配列数',
  )
  await terminal.getByRole('button', { name: '增大字号', exact: true }).click()
  await terminal.waitForFunction(() => window.term.options.fontSize === 18)
  assert.equal(
    await terminal.evaluate(() => localStorage.getItem('pi-chat-content-font-size')),
    '19',
  )
  await gui.evaluate(() => {
    localStorage.setItem('pi-chat-content-font-size', '14')
    localStorage.removeItem('pi-mono-font-family')
    localStorage.removeItem('pi-mono-font-weight')
    localStorage.setItem('pi-web:terminal-theme', 'dark')
  })
  await terminal.waitForFunction(
    () => window.term.options.fontSize === 13 && window.term.options.fontWeight === 400,
  )
  await waitForUserTheme('dark')
  assert(
    await terminal.evaluate(() => window.term === window.fixtureTerm),
    '字体和主题变化不能重建终端',
  )
  await context.setOffline(true)
  await terminal.locator('.terminal-status-dot.is-connecting').waitFor()
  await context.setOffline(false)
  await terminal.locator('.terminal-status-dot.is-ready').waitFor()
  await rendered()
  await waitForUserTheme('dark')
  await terminal.locator('.xterm-helper-textarea').focus()
  await terminal.keyboard.insertText('/copy')
  await terminal.waitForFunction(() => {
    const buffer = window.term.buffer.active
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString())
      .join('\n')
      .includes('/copy')
  })
  await terminal.keyboard.press('Enter')
  await terminal
    .waitForFunction(() => window.clipboardWrites.includes('离线终端 fixture'))
    .catch(async (error) => {
      console.error(
        await terminal.evaluate(() => ({
          writes: window.clipboardWrites,
          screen: Array.from({ length: window.term.buffer.active.length }, (_, i) =>
            window.term.buffer.active.getLine(i)?.translateToString(),
          ).join('\n'),
        })),
      )
      throw error
    })
  const clipboard = await terminal.evaluate(async () => ({
    text: await navigator.clipboard.readText(),
    writes: window.clipboardWrites,
    focused: document.hasFocus(),
  }))
  assert.equal(
    clipboard.text,
    '离线终端 fixture',
    `Pi /copy 必须真的写入浏览器剪贴板: ${JSON.stringify(clipboard)}`,
  )

  await terminal.locator('.terminal-panel-actions button').last().click()
  await waitForUserTheme('light')
  const requestsBeforeReload = themeRequests.length
  await terminal.reload()
  await rendered()
  await waitForUserTheme('light')
  assert.equal(themeRequests.length, requestsBeforeReload, '刷新不能额外发送主题控制序列')
  await terminal.locator('.terminal-panel-actions button').last().click()
  await waitForUserTheme('dark')
  await terminal.setViewportSize({ width: 760, height: 640 })
  await terminal.locator('.xterm-helper-textarea').focus()
  await terminal.keyboard.insertText('中文输入测试')
  await terminal.waitForFunction(() => {
    const buffer = window.term.buffer.active
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString())
      .join('\n')
      .includes('中文输入测试')
  })
  await terminal.keyboard.press('Control+u')

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  try {
    await mobileContext.addCookies(await context.cookies(base))
    const mobile = await mobileContext.newPage()
    const errors = []
    mobile.on('pageerror', (error) => errors.push(error.message))
    const socketReady = mobile.waitForEvent('websocket')
    await mobile.goto(terminal.url())
    const socket = await socketReady
    await mobile.locator('.terminal-status-dot.is-ready').waitFor()
    const toolbar = mobile.getByRole('toolbar')
    await toolbar.waitFor()
    assert.equal(await toolbar.getByRole('button').count(), 14)
    await mobile.waitForFunction(() => window.term.modes.mouseTrackingMode !== 'none')
    const cdp = await mobileContext.newCDPSession(mobile)
    try {
      const screen = await mobile.locator('.xterm-screen').boundingBox()
      const x = screen.x + screen.width / 2
      const y = screen.y + screen.height / 2
      async function swipe(direction) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y }],
        })
        for (let step = 1; step <= 8; step++)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x, y: y + direction * step * 20 }],
          })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
      const up = socket.waitForEvent('framesent', {
        predicate: (frame) => frame.payload.toString().startsWith('0\u001b[<64;'),
      })
      await swipe(1)
      await up
      const down = socket.waitForEvent('framesent', {
        predicate: (frame) => frame.payload.toString().startsWith('0\u001b[<65;'),
      })
      await swipe(-1)
      await down
      assert.equal(
        await mobile
          .locator('.xterm-screen')
          .evaluate((screen) => getComputedStyle(screen).touchAction),
        'pinch-zoom',
      )
    } finally {
      await cdp.detach()
    }
    await mobile.locator('.xterm-helper-textarea').focus()
    await checkTerminalInput(mobile)
    await mobile.keyboard.insertText('移动端中文😊')
    await mobile.waitForFunction(() => {
      const buffer = window.term.buffer.active
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString())
        .join('\n')
        .includes('移动端中文😊')
    })
    const ctrl = toolbar.getByRole('button', { name: 'CTRL', exact: true })
    await ctrl.tap()
    assert.equal(await ctrl.getAttribute('aria-pressed'), 'true')
    const cleared = socket.waitForEvent('framesent', {
      predicate: (frame) => frame.payload.toString() === '0\u0015',
    })
    await mobile.keyboard.insertText('u')
    await cleared
    assert.equal(await ctrl.getAttribute('aria-pressed'), 'false')
    assert(
      await mobile.evaluate(() => document.activeElement?.matches('.xterm-helper-textarea')),
      '快捷键不能让软键盘失去焦点',
    )
    const tab = socket.waitForEvent('framesent', {
      predicate: (frame) => frame.payload.toString() === '0\t',
    })
    await toolbar.getByRole('button', { name: 'TAB', exact: true }).tap()
    await tab
    const escape = socket.waitForEvent('framesent', {
      predicate: (frame) => frame.payload.toString() === '0\u001b',
    })
    await toolbar.getByRole('button', { name: 'ESC', exact: true }).tap()
    await escape

    // Headless browsers have no OS keyboard: drive its visual-viewport geometry explicitly.
    await mobile.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 450 })
      window.visualViewport.dispatchEvent(new Event('resize'))
    })
    await mobile.waitForFunction(
      () => document.documentElement.style.getPropertyValue('--app-viewport-height') === '450px',
    )
    const bounds = await mobile.evaluate(() => {
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect()
      const host = document.querySelector('.terminal-xterm-host').getBoundingClientRect()
      return {
        bottom: document.querySelector('.terminal-extra-keys').getBoundingClientRect().bottom,
        gap: host.right - screen.right,
        fontSize: window.term.options.fontSize,
        overflow: document.documentElement.scrollWidth > innerWidth,
        scrollback: window.term.options.scrollback,
      }
    })
    assert(bounds.bottom <= 451, `快捷键被软键盘遮挡：${JSON.stringify(bounds)}`)
    assert(
      bounds.gap >= -1 && bounds.gap < bounds.fontSize,
      `存在多余滚动占位：${JSON.stringify(bounds)}`,
    )
    assert.equal(bounds.overflow, false)
    assert.equal(bounds.scrollback, 0)
    await mobile.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 400 })
      document.dispatchEvent(new CompositionEvent('compositionupdate', { data: '中' }))
    })
    await mobile.waitForFunction(
      () => document.documentElement.style.getPropertyValue('--app-viewport-height') === '400px',
    )
    await mobile.evaluate(() => {
      delete window.visualViewport.height
      window.visualViewport.dispatchEvent(new Event('resize'))
    })
    await mobile.waitForFunction(
      () => !document.documentElement.style.getPropertyValue('--app-viewport-height'),
    )
    assert.deepEqual(errors, [])
    console.log(
      'PASS: 手机双向触摸滚动、竖屏快捷键、组合键和焦点、中文与 emoji、键盘/候选栏高度适配、无横向溢出或额外滚动占位',
    )
  } finally {
    await mobileContext.close()
  }
  await terminal.bringToFront()
  await terminal.locator('.xterm-helper-textarea').focus()
  const resumed = gui.waitForRequest((request) =>
    new URL(request.url()).pathname.startsWith(`/api/agent/${sessionId}`),
  )
  await terminal.keyboard.press('Control+d')
  await gui.bringToFront()
  await gui.getByText('此会话已在 TUI 中打开，当前页面仅供查看。').waitFor({ state: 'hidden' })
  const launch = gui.getByRole('button', { name: '打开 TUI ↗', exact: true })
  await launch.waitFor()
  assert.equal(await launch.evaluate((button) => getComputedStyle(button).marginLeft), '0px')
  assert.equal(await gui.getByText('可在新标签页使用 Pi TUI。').count(), 0)
  await resumed
  assert(sdkRequests.length > 0, 'TUI 退出后才恢复 GUI agent 请求')
  const reopening = context.waitForEvent('page')
  await launch.click()
  const reopened = await reopening
  await gui.getByText('此会话已在 TUI 中打开，当前页面仅供查看。').waitFor()
  await reopened.waitForFunction(() => Boolean(window.term?.buffer.active.length))
  await reopened.close()
  await terminal.close()
  console.log(
    'PASS: 浏览器独立标签页、只读无 SDK、退出恢复 GUI、GUI 释放后重新打开 TUI、刷新重绘、中文输入和真实 OSC 52 剪贴板',
  )
} finally {
  await browser.close()
}
