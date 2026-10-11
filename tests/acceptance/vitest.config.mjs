import { fileURLToPath } from 'node:url'
import tsconfigPaths from '../../../deepseek-harness/node_modules/vite-tsconfig-paths/dist/index.js'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../deepseek-harness/vitest.shared.ts'

const path = relative => fileURLToPath(new URL(relative, import.meta.url))

// Source-plane only: this deliberately uses the checkout's existing paths facade.
export default {
  root: path('../../../deepseek-harness/'),
  cacheDir: path('./.cache/vite/'),
  plugins: [
    tsconfigPaths({ projects: [path('./tsconfig.source.json')] }),
    standardDecoratorPlugin(),
  ],
  resolve: {
    alias: [{ find: /^vitest$/, replacement: path('../../../deepseek-harness/node_modules/vitest/dist/index.js') }],
  },
  test: {
    include: [path('./**/*.spec.ts')],
    execArgv: vitestExecArgv,
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    watch: false,
  },
}
