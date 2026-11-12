// @env node
import { resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '../..')
export const PI_CLI = resolve(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
export const BRIDGE_BIN = resolve(ROOT, 'bin/pi-bridge')
export const WEB_COMMIT = 'f130910abf662b506b2ef2f475fc21a2fe57badc'
export const WEB_DIR = resolve(ROOT, '.cache/pi-web')
