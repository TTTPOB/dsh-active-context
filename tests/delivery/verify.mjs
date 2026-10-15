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
rows.push({ id: 'active-context', name: 'dsh-active-context', config: { basic: { auto: false }, acp: { pressureRoutes: [{ provider: 'artifact-boundary', model: 'scripted', nudgeAtTokens: 1000, resetBelowTokens: 200 }] } } })
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
  await turn('Historical beta ' + 'old detail B '.repeat(120))
  await turn('KEEP MIDDLE: public command must remain unchanged.')
  input = { regions: [0, 1].map((index, i) => ({
    range: [{ text: index === 0 ? 'Historical alpha ' : 'Historical beta ', role: 'user' },
      { text: 'Historical work complete ' + index, role: 'assistant' }],
    summary: summaries[i],
  })) }
  const initial = [...agent.session.surface.nodes]
  const targets = input.regions.map(region => {
    const indices = region.range.map(endpoint => initial.findIndex(seq => {
      const message = agent.session.deriveEventMessage(agent.session.eventAt(seq))
      return message?.role === endpoint.role && message.content.some(block => block.type === 'text' && block.text.includes(endpoint.text))
    }))
    assert.ok(indices[0] >= 0 && indices[1] >= indices[0])
    return initial.slice(indices[0], indices[1] + 1)
  })
  assert.equal(initial.indexOf(targets[0].at(-1)) + 1, initial.indexOf(targets[1][0]), 'adjacent complete regions')
  await turn('Complete the task after compressing only the selected history.')
  assert.equal(requests.length, 5)
  const events = agent.session.snapshotEvents()
  assert.equal(events.at(-1).type, 'turn/end')
  assert.equal(events.at(-1).data.reason.kind, 'completed')
  assert.ok(JSON.stringify(agent.session.deriveMessages()).includes('Continued artifact task with preserved constraints.'))
  const transactions = events.filter(event => event.type === 'compaction/summary')
  assert.deepEqual(transactions.map(event => ({ seqs: event.data.shadowedSeqs, summary: event.data.summary })), [1, 0].map(index => ({
    seqs: targets[index], summary: [{ type: 'text', text: summaries[index] }],
  })))
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'artifact-compress')
  assert.ok(result)
  assert.notEqual(result.data.message.isError, true)
  const facts = JSON.parse(result.data.message.content.find(block => block.type === 'text').text)
  assert.equal(facts.status, 'compressed')
  assert.deepEqual(facts.execution_order, [1, 0])
  assert.ok(!agent.session.surface.nodes.includes(result.seq))
  const maintenance = events.find(event => event.type === 'user/message' && event.data.source.kind === 'acp-maintenance')
  assert.ok(maintenance)
  const statusText = maintenance.data.content.find(block => block.type === 'text').text
  const record = JSON.parse(statusText.slice(statusText.indexOf('{')))
  assert.deepEqual(record.regions.map(region => region.range), input.regions.map(region => region.range))
  assert.deepEqual(record.regions.map(region => region.input_index), [0, 1])
  assert.deepEqual(record.regions.map(region => region.status), ['committed', 'committed'])
  assert.equal(record.log.result_seq, result.seq)
  assert.equal(agent.session.eventAt(record.log.tool_call_seq).type, 'tool/call')
  assert.equal(agent.session.eventAt(record.log.assistant_seq).type, 'assistant/message')
  for (const summary of summaries) assert.ok(!statusText.includes(summary))
  const replay = Session.create(SessionId('acp-artifact-replay'), structuredClone(events))
  assert.deepEqual(replay.deriveMessages(), agent.session.deriveMessages())
  assert.deepEqual(replay.surface.nodes, agent.session.surface.nodes)
  let boundaryIndex = 0
  const boundaryRequests = []
  class BoundaryAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100_000 } } }
    async * stream(options) {
      boundaryRequests.push(structuredClone(options.messages))
      let blocks
      if (boundaryIndex === 0) blocks = [{ type: 'text', text: 'Artifact relay work completed. ' + 'retained work details '.repeat(700) }]
      else if (boundaryIndex === 1) {
        const notice = options.messages.find(message => message.source?.kind === 'acp-pressure')
        assert.ok(notice)
        const text = notice.content.find(block => block.type === 'text').text
        assert.ok(text.includes('latest_task_input (1 node): user "Artifact parent relay task:'))
        assert.ok(!text.includes('sent a message:'))
        assert.ok(Buffer.byteLength(JSON.stringify(notice)) <= 6000)
        assert.ok(ctx.tokenMeter.estimateMessage(notice) <= 1200)
        blocks = [{ type: 'tool-call', id: ToolCallId('artifact-boundary-cross'), name: 'context_compress', arguments: JSON.stringify({ regions: [
          { range: [{ text: 'Host context maintenance notice:', role: 'user' }, { text: 'Host context maintenance notice:', role: 'user' }], summary: 'Display must not match.' },
          { range: [{ text: 'Artifact parent relay task:', role: 'user' }, { text: 'Artifact relay work completed.', role: 'assistant' }], summary: 'Protected task must not commit.' },
        ] }) }]
      } else if (boundaryIndex === 2) {
        const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'artifact-boundary-cross')
        const facts = JSON.parse(result.content.find(block => block.type === 'text').text)
        assert.equal(result.isError, true)
        assert.equal(facts.status, 'failed')
        assert.deepEqual(facts.retry.regions, [0, 1])
        assert.ok(facts.regions[0].error.includes('has no match'))
        assert.ok(facts.regions[1].error.includes('Artifact parent relay task:'))
        assert.ok(!facts.regions[1].error.includes('sent a message:'))
        const help = JSON.parse(facts.regions[1].error.match(/Safe split ranges .*?: (\{.*\})\. Each range/)[1])
        assert.equal(help.ranges.length, 1)
        assert.ok(!JSON.stringify(help).includes('summary'))
        blocks = [{ type: 'tool-call', id: ToolCallId('artifact-boundary-retry'), name: 'context_compress', arguments: JSON.stringify({ regions: help.ranges.map(range => ({ range, summary: 'Artifact relay work conclusion retained.' })) }) }]
      } else if (boundaryIndex === 3) blocks = [{ type: 'text', text: 'Artifact boundary retry finished.' }]
      else throw new Error('Unexpected boundary model request')
      boundaryIndex++
      for (const [i, block] of blocks.entries()) {
        yield { type: 'block-start', index: i, blockType: block.type }
        yield { type: 'block-end', index: i, block }
      }
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['artifact-boundary'], new BoundaryAdapter())
  const boundaryAgent = await ctx.agentLoop.create(SessionId('acp-artifact-boundary'), { provider: 'artifact-boundary', model: 'scripted' }, { cwd: profile })
  boundaryAgent.followup(createUserMessage({ content: [
    { type: 'text', text: 'Agent artifact-parent sent a message: ' },
    { type: 'text', text: 'Artifact parent relay task: retain the exact protection rules. ' + 'task details '.repeat(700) },
  ], source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('artifact-parent') } }))
  await boundaryAgent.whenIdle()
  boundaryAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compress the completed relay work.' }], source: { kind: 'user', form: 'notice', summary: 'Maintenance' } }))
  await boundaryAgent.whenIdle()
  const boundaryEvents = boundaryAgent.session.snapshotEvents()
  assert.equal(boundaryRequests.length, 4)
  assert.equal(boundaryEvents.at(-1).data.reason.kind, 'completed')
  assert.equal(boundaryEvents.filter(event => event.type === 'user/message' && event.data.source.kind === 'acp-pressure').length, 1)
  const rejected = boundaryEvents.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'artifact-boundary-cross')
  assert.equal(rejected.data.error.code, 'ACP_ALL_FAILED')
  const retry = boundaryEvents.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'artifact-boundary-retry')
  assert.equal(JSON.parse(retry.data.message.content.find(block => block.type === 'text').text).status, 'compressed')
  // Registration cleanup is observable while the service tree remains alive.
  const active = [...ctx.loader.entries()].find(row => row.options.id === 'active-context')
  assert.ok(ctx.tools.get('context_compress'))
  await active.fiber.dispose()
  assert.equal(ctx.get('compaction'), undefined)
  assert.equal(ctx.tools.get('context_compress'), undefined)
  console.log(JSON.stringify({
    sharedPeers: 'Host Cordis/DSH identity; same-version Schemastery',
    loader: 'all rows active, unique ACP provider, Host schema validation',
    behavior: 'two adjacent commits, independent summaries, retained constraint, pair cleanup, replay; relay-body map, display exclusion, protected split retry; provider disposal',
    compatibility, testLocalExemptionsOnly: true,
  }, null, 2))
} finally {
  await ctx?.fiber.dispose()
}
