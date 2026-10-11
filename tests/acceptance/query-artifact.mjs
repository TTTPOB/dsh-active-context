import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harness = fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url))
const archive = resolve(process.argv[2] ?? join(harness, 'dist/daily-driver/deepseek-ai-dsh-session-query-0.1.7-rc.2-fork4.tgz'))
await stat(archive)
// mkdtemp exclusively allocates a new owned path; existing peer links are never changed.
const root = await mkdtemp(join(harness, 'packages/session-query/session-query/.acceptance-artifact-'))
let ctx
try {
  execFileSync('tar', ['-xzf', archive, '-C', root], { stdio: 'pipe' })
  const directory = join(root, 'package')
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const entry = join(directory, manifest.main)
  const require = createRequire(entry)
  const peers = []
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session']) {
    const resolved = require.resolve(name)
    const metadata = JSON.parse(await readFile(require.resolve(name + '/package.json'), 'utf8'))
    peers.push({ name, version: metadata.version, resolved })
  }
  const query = await import(pathToFileURL(entry).href)
  assert.equal(typeof query.default.prototype.captureSession, 'function')
  const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  const session = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
  class ExactReadBackend extends query.default {
    searchSessions() { throw new Error('Artifact capture must not issue a search') }
    searchEvents() { throw new Error('Artifact capture must not issue a search') }
  }
  ctx = new cordis.Context()
  await ctx.plugin(session.default)
  await ctx.plugin(ExactReadBackend)
  const live = ctx.sessions.create(session.SessionId('artifact-live'))
  const captured = await ctx.sessionQuery.captureSession(live.id, (reader, observation) => {
    assert.equal(reader, live)
    return { id: reader.id, nodes: [...reader.surface.nodes], cut: observation.cursor }
  }, { projectionMode: 'none' })
  assert.deepEqual(captured, { id: 'artifact-live', nodes: [], cut: -1 })

  const consumer = join(directory, 'acceptance-consumer.mts')
  await writeFile(consumer, `import type Query from '@deepseek-ai/dsh-session-query'
import type { SessionCaptureReader } from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'
declare const query: Query
declare const id: SessionId
const result: Promise<string> = query.captureSession(id, reader => {
  const typed: SessionCaptureReader = reader
  const text: string = typed.id
  // @ts-expect-error -- Artifact declarations must hide Session writes.
  typed.append('turn/start', { turn: 1 })
  // @ts-expect-error -- Artifact declarations must make positional nodes readonly.
  typed.surface.nodes.push(0)
  return text
})
// @ts-expect-error -- Artifact declarations must reject async captures.
query.captureSession(id, async () => 1)
void result
`)
  const ts = createRequire(join(harness, 'package.json'))('typescript')
  const program = ts.createProgram([consumer], {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023, strict: true, exactOptionalPropertyTypes: true,
    noEmit: true, skipLibCheck: true, types: ['node'],
    typeRoots: [dirname(dirname(createRequire(join(harness, 'package.json')).resolve('@types/node/package.json')))],
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => dirname(consumer), getNewLine: () => '\n',
  }))
  console.log(JSON.stringify({
    archive, package: manifest.name, version: manifest.version,
    plainNodeRootImport: 'passed', originalSessionCapture: 'passed', nodeNextConsumerTypes: 'passed',
    peerLayout: 'existing Harness workspace peers; NOT a clean package-manager installation', peers,
  }, null, 2))
} finally {
  await ctx?.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
