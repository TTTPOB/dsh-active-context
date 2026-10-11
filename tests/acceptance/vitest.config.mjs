import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../deepseek-harness/vitest.shared.ts'

const path = relative => fileURLToPath(new URL(relative, import.meta.url))
const harness = path('../../../deepseek-harness/')
const ts = createRequire(resolve(harness, 'package.json'))('typescript')
const config = ts.readConfigFile(resolve(harness, 'tsconfig.base.json'), ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))

// Static source aliases apply to sibling-repository importers as well as Harness importers.
// These are deliberately NOT used by plainNode artifact/peer-installation checks.
const sourceAliases = Object.entries(config.config.compilerOptions.paths).map(([name, targets]) => {
  const target = resolve(harness, targets[0])
  const escaped = name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')
  return { find: new RegExp('^' + escaped + '$'), replacement: target.replace('*', '$1') }
})

export default {
  root: harness,
  cacheDir: path('./.cache/vite/'),
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: [
      { find: /^vitest$/, replacement: path('../../../deepseek-harness/node_modules/vitest/dist/index.js') },
      { find: /^dsh-session-tools\/context-map$/, replacement: path('../../../dsh-session-tools/src/context-map.ts') },
      { find: /^dsh-session-tools$/, replacement: path('../../../dsh-session-tools/src/index.ts') },
      ...sourceAliases,
    ],
  },
  test: {
    include: [
      path('../**/*.spec.ts'),
      path('../../../deepseek-harness/packages/session-query/session-query/tests/capture-types.spec.ts'),
    ],
    execArgv: vitestExecArgv,
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    watch: false,
  },
}
