// @env node
import { execFileSync } from 'node:child_process'

console.log(
  JSON.stringify({
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
    childBun: JSON.parse(
      execFileSync('bun', ['-p', 'Boolean(process.versions.bun)'], {
        encoding: 'utf8',
        timeout: 5000,
      }),
    ),
  }),
)
