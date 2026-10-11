import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Runner mode avoids Vite's default config bundle in node_modules/.vite-temp.
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../../../deepseek-harness/node_modules/vitest/vitest.mjs', import.meta.url)),
  'run', '--configLoader', 'runner',
  '--config', fileURLToPath(new URL('./vitest.config.mjs', import.meta.url)),
  ...process.argv.slice(2),
], {
  cwd: fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url)),
  env: process.env,
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.signal) throw new Error('Acceptance runner terminated by ' + result.signal)
process.exitCode = result.status ?? 1
