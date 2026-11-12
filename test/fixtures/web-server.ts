#!/usr/bin/env node
// @env node
// 模拟 Next 进程，验证运行时、环境传递和信号退出。
import { execFileSync } from 'node:child_process'
process.on('SIGTERM', () => process.exit(0))
await Bun.write(
  process.env.WORKBOT_TEST_READY!,
  JSON.stringify({
    piDir: process.env.PI_CODING_AGENT_DIR,
    defaultCwd: process.env.PI_WEB_DEFAULT_CWD,
    channelsDisabled: process.env.PI_CHANNELS_DISABLE_SESSION_AUTOSTART,
    bun: Boolean(process.versions.bun),
    node: JSON.parse(
      execFileSync(
        'sh',
        ['-c', 'node -p "Boolean(process.versions.node && !process.versions.bun)"'],
        {
          encoding: 'utf8',
          timeout: 5000,
        },
      ),
    ),
  }),
)
setInterval(() => {}, 1000)
