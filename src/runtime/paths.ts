// @env node
import { resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '../..')
export const PI_CLI = resolve(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
export const BRIDGE_BIN = resolve(ROOT, 'bin/pi-bridge')
export const WEB_COMMIT = '2daa0d131eae6c2fd8c2a80872eee01ea3c7a0a1'
export const WEB_DIR = resolve(ROOT, '.cache/pi-web')
