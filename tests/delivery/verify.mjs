import assert from 'node:assert/strict'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [anchor, home] = process.argv.slice(2)
const profile = join(home, 'profiles/web')
const hostRequire = createRequire(anchor)
const profileRequire = createRequire(join(profile, 'package.json'))
const hostImport = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const boot = await hostImport('@deepseek-ai/dsh-app-boot')
const { LlmAdapter, ToolCallId, createUserMessage } = await hostImport('@deepseek-ai/dsh-llm')
const { Session, SessionId } = await hostImport('@deepseek-ai/dsh-session')
const rows = [
  ['llm'], ['session'], ['session-projection'], ['system-prompt'], ['tools', { mode: 'native' }],
  ['agent'], ['token-meter'], ['session-persistence-jsonl', { root: join(home, 'sessions') }],
  ['storage'], ['storage-json', { root: join(home, 'storages') }], ['storage-domain', { backend: 'json' }],
  ['workspace'], ['session-query-sqlite', { path: ':memory:', openAt: 'never' }],
  ['agent-loop', { agents: [] }],
].map(([name, config]) => ({ id: name, name: '@deepseek-ai/dsh-' + name, ...(config ? { config } : {}) }))
rows.push({ id: 'active-context', name: 'dsh-active-context', config: { basic: { auto: false } } })
const configPath = join(profile, 'cordis.yml')
const consumerPath = join(profile, 'consumer.mjs')
await writeFile(consumerPath, `export * as acp from 'dsh-active-context'
export const entries = { 'dsh-active-context': import.meta.resolve('dsh-active-context') }
`)
await writeFile(configPath, JSON.stringify(rows) + '\n')
const loaded = boot.loadProfileDirectory('ACP delivery', profile, anchor)
const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile: loaded, home })
const compatibility = []
let ctx
let consumer
try {
  // Test-local grants are limited to these explicit exact package/runtime combinations.
  const accepted = {
    'dsh-active-context': JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
    '@deepseek-ai/dsh-session-query': '0.1.7-rc.2-fork4',
    '@deepseek-ai/dsh-session-query-sqlite': '0.1.7-rc.2-fork6',
  }
  for (const [name, version] of Object.entries(accepted)) {
    const path = name.startsWith('@') ? join(resolution.entries.find(item => item.name === name && item.scope === 'installation').packageDir, 'package.json') : join(profile, 'node_modules', name, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(manifest.version, version, 'exact accepted package ' + name)
    const issue = boot.evaluatePluginCompatibility(manifest)
    if (issue) {
      compatibility.push(issue)
      assert.equal(issue.exempted, false)
      await boot.setProfileVersionExemption(profile, `${name}@${version}`, issue.runtimeVersion, true, true)
    }
  }
  ctx = await boot.boot('ACP delivery', configPath, undefined, async context => {
    context.provide('profileContext', {
      name: 'web', dir: profile, patchPath: join(profile, 'cordis.patch.yml'), installAnchor: anchor,
      cwd: profile, home, startedBundles: [], overlays: [], telemetryDisabledEnv: '1',
    })
    await context.plugin(boot.PluginPackages, { resolution })
    for (const row of rows.filter(row => row.name.startsWith('@'))) {
      // Preserve the actual package import error before Loader condenses startup diagnostics.
      try { await import(pathToFileURL(profileRequire.resolve(row.name)).href) }
      catch (cause) { throw new Error('Built import failed: ' + row.name, { cause }) }
    }
    // ESM-only exports must be consumed with import conditions, not require.resolve.
    consumer = await import(pathToFileURL(consumerPath).href)
  })
  for (const name of ['dsh-active-context']) {
    const entry = await realpath(fileURLToPath(consumer.entries[name]))
    const directory = join(profile, 'node_modules', name)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    assert.match(entry, /\.js$/, 'built entry ' + name)
    assert.ok((await stat(join(directory, manifest.types))).isFile(), 'shipped declarations ' + name)
    for (const peer of Object.keys(manifest.peerDependencies)) {
      const actual = ctx.pluginPackages.packageOf(peer, pathToFileURL(entry).href)
      assert.ok(actual, `${name} resolves ${peer}`)
      assert.equal(actual.version, manifest.peerDependencies[peer], 'exact peer version ' + peer)
      const expected = resolution.entries.find(item => item.name === peer && item.scope === 'installation')
      assert.ok(expected, 'Host/profile provides ' + peer)
      if (peer === '@deepseek-ai/schemastery') assert.equal(actual.version, expected.version)
      else assert.equal(await realpath(actual.dir), await realpath(expected.packageDir ?? expected.dir), `shared identity ${name} -> ${peer}`)
    }
  }
  const acp = consumer.acp
  const { BasicCompactionEngine } = await hostImport('@deepseek-ai/dsh-compaction-basic')
  assert.ok(ctx.compaction instanceof acp.ActiveCompactionEngine)
  assert.ok(ctx.compaction instanceof BasicCompactionEngine, 'ACP extends the Host Basic engine')
  const schema = (await hostImport('@deepseek-ai/schemastery')).default
  assert.deepEqual(schema.resolve({}, acp.Config, {})[0].acp.pressureRoutes, [])
  assert.throws(() => schema.resolve({ acp: { maxRegions: 1 } }, acp.Config, {}))
  // Cordis 4.0.4 publishes FiberState as an erased const enum; ACTIVE is 2.
  for (const row of ctx.loader.entries()) if (!row.disabled) assert.equal(row.fiber?.state, 2, 'active Loader row ' + row.options.name)
  let input
  let index = 0
  const requests = []
  const summaries = ['Artifact alpha: preserve the failed alpha assertion; verify next.', 'Artifact beta: preserve the unresolved beta verification and public command.']
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100_000 } } }
    async * stream(options) {
      requests.push(structuredClone(options.messages))
      let blocks
      if (index < 3) blocks = [{ type: 'text', text: 'Historical work complete ' + index }]
      else if (index === 3) blocks = [{ type: 'tool-call', id: ToolCallId('artifact-compress'), name: 'context_compress', arguments: JSON.stringify(input) }]
      else if (index === 4) {
        const text = JSON.stringify(options.messages)
        for (const summary of summaries) assert.ok(text.includes(summary))
        assert.ok(text.includes('KEEP MIDDLE'))
        assert.ok(!text.includes('old detail'))
        assert.ok(!text.includes('artifact-compress'))
        assert.ok(options.messages.some(message => message.source?.kind === 'acp-maintenance'))
        blocks = [{ type: 'text', text: 'Continued artifact task with preserved constraints.' }]
      } else throw new Error('Unexpected artifact model request')
      index++
      for (const [i, block] of blocks.entries()) {
        yield { type: 'block-start', index: i, blockType: block.type }
        yield { type: 'block-end', index: i, block }
      }
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['artifact'], new Adapter())
  const agent = await ctx.agentLoop.create(SessionId('acp-artifact'), { provider: 'artifact', model: 'scripted' }, { cwd: profile })
  const turn = async text => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  await turn('Historical alpha ' + 'old detail A '.repeat(120))
  await turn('KEEP MIDDLE: public command must remain unchanged.')
  await turn('Historical beta ' + 'old detail B '.repeat(120))
  input = { regions: [0, 2].map((index, i) => ({
    range: [{ text: index === 0 ? 'Historical alpha ' : 'Historical beta ', role: 'user' },
      { text: 'Historical work complete ' + index, role: 'assistant' }],
    summary: summaries[i],
  })) }
  await turn('Complete the task after compressing only the selected history.')
  assert.equal(requests.length, 5)
  const events = agent.session.snapshotEvents()
  assert.equal(events.at(-1).type, 'turn/end')
  assert.equal(events.at(-1).data.reason.kind, 'completed')
  assert.ok(JSON.stringify(agent.session.deriveMessages()).includes('Continued artifact task with preserved constraints.'))
  assert.equal(events.filter(event => event.type === 'compaction/summary').length, 2)
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'artifact-compress')
  assert.ok(result)
  assert.notEqual(result.data.message.isError, true)
  const facts = JSON.parse(result.data.message.content.find(block => block.type === 'text').text)
  assert.equal(facts.status, 'batch_success')
  assert.deepEqual(facts.execution_order, [1, 0])
  assert.ok(!agent.session.surface.nodes.includes(result.seq))
  const replay = Session.create(SessionId('acp-artifact-replay'), structuredClone(events))
  assert.deepEqual(replay.deriveMessages(), agent.session.deriveMessages())
  assert.deepEqual(replay.surface.nodes, agent.session.surface.nodes)
  // Registration cleanup is observable while the service tree remains alive.
  const active = [...ctx.loader.entries()].find(row => row.options.id === 'active-context')
  assert.ok(ctx.tools.get('context_compress'))
  await active.fiber.dispose()
  assert.equal(ctx.get('compaction'), undefined)
  assert.equal(ctx.tools.get('context_compress'), undefined)
  console.log(JSON.stringify({
    sharedPeers: 'Host Cordis/DSH identity; same-version Schemastery',
    loader: 'all rows active, unique ACP provider, Host schema validation',
    behavior: 'two nonadjacent commits, middle preserved, next-request pair cleanup, replay, provider disposal',
    compatibility, testLocalExemptionsOnly: true,
  }, null, 2))
} finally {
  await ctx?.fiber.dispose()
}
