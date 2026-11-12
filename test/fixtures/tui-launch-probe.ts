// @env node
export {}

await Bun.write(
  process.env.WORKBOT_TEST_REPORT!,
  JSON.stringify({
    pid: process.pid,
    args: process.argv.slice(2),
    value: process.env.WORKBOT_TEST_VALUE,
    removed: process.env.WORKBOT_TEST_REMOVED,
    passwordPresent: 'PI_WEB_PASSWORD' in process.env,
    term: process.env.TERM,
    pane: process.env.TMUX_PANE,
    clipboard: process.env.PI_CLIPBOARD_OSC52,
  }),
)
