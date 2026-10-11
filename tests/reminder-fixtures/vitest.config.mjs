import { fileURLToPath } from 'node:url'
import base from '../acceptance/vitest.config.mjs'
const path = relative => fileURLToPath(new URL(relative, import.meta.url))
export default {
  ...base,
  cacheDir: path('../../../deepseek-harness/tmp/acp-reminder-vitest-scratch/'),
  test: { ...base.test, include: [path('../reminder*.spec.ts')] },
}
