import { harness } from './source-root.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Runner mode avoids Vite's default config bundle in node_modules/.vite-temp.
const result = spawnSync(process.execPath, [
  harness + '/node_modules/vitest/vitest.mjs',
  'run', '--configLoader', 'runner',
  '--config', fileURLToPath(new URL('./vitest.config.mjs', import.meta.url)),
  ...process.argv.slice(2),
], {
  cwd: harness,
  env: process.env,
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.signal) throw new Error('Acceptance runner terminated by ' + result.signal)
process.exitCode = result.status ?? 1
