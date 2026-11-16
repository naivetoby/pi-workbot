// @env node
import { resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '../..')
export const PI_CLI = resolve(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
export const BRIDGE_BIN = resolve(ROOT, 'bin/pi-bridge')
export const WEB_COMMIT = '174bff967807cdb59abb0204198d3d7cc19c862d'
export const WEB_DIR = resolve(ROOT, '.cache/pi-web')
