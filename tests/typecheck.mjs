import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const harness = fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))
const acp = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(harness, 'package.json'))
const ts = require('typescript')
const config = ts.readConfigFile(join(harness, 'tsconfig.base.json'), ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, harness)
const paths = Object.fromEntries(Object.entries(parsed.options.paths).map(([name, targets]) => [name, targets.map(target => resolve(harness, target))]))
// Vendor packages own separate compiler programs; consume their existing declaration faces.
// No diagnostics are filtered: consumer and Harness source errors must still fail this command.
for (const name of ['cordis', 'cosmokit', 'schemastery']) {
  paths['@deepseek-ai/' + name] = [join(harness, 'vendor', name, 'lib/types/index.d.ts')]
}
paths['@deepseek-ai/cordis-plugin-loader'] = [join(harness, 'vendor/loader/lib/types/index.d.ts')]
paths['@deepseek-ai/cordis-plugin-include'] = [join(harness, 'vendor/include/lib/types/index.d.ts')]
paths.vitest = [join(harness, 'node_modules/vitest/dist/index.d.ts')]
const files = [
  ...ts.sys.readDirectory(join(acp, 'src'), ['.ts'], undefined, ['**/*.ts']),
  ...ts.sys.readDirectory(join(acp, 'tests'), ['.ts'], ['**/.cache/**'], ['**/*.ts']),
]
const options = {
  ...parsed.options, paths, composite: false, incremental: false, noEmit: true,
  declaration: false, declarationMap: false, sourceMap: false, rewriteRelativeImportExtensions: false,
  typeRoots: [dirname(dirname(require.resolve('@types/node/package.json')))],
}
const program = ts.createProgram(files, options)
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.length !== 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => harness, getNewLine: () => '\n',
  }))
  process.exitCode = 1
} else {
  console.log('Strict source typecheck passed (' + files.length + ' ACP source and test roots; TypeScript ' + ts.version + '; no diagnostic filtering).')
}
