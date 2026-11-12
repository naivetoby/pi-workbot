// @env node
import { notice } from '../src/notice/ci.ts'

if (import.meta.main) await notice(process.argv[2])
