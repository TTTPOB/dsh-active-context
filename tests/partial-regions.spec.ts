import { expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createLoopFixture, runTurn } from './loop-fixtures/agent-loop.ts'
import { loadActiveContext } from './loop-fixtures/loader.ts'
import { preflightRegions } from '../src/regions.ts'
import { providerFixture } from './provider-fixture.ts'
import { vi } from 'vitest'

const select = (text: string) => ({ range: [{ text }, { text }], summary: 'Completed conclusion.' })

it.each(['missing endpoint', 'details', 'current task'])('commits independent history while reporting %s at its original index', async text => {
  const f = await providerFixture()
  try {
    const input = f.input([select(text), f.input().regions[text === 'current task' ? 0 : 1]!])
    const { result, facts } = await f.submit(input)
    expect(result.isError).toBe(false)
    expect(facts.status).toBe('partial')
    expect(facts.regions.map((fact: { status: string }) => fact.status)).toEqual(['failed', 'committed'])
    expect(facts.regions[0]).toMatchObject({ input_index: 0, range: input.regions[0]!.range, error: expect.any(String) })
    expect(f.session.surface.nodes).not.toContain(f.old[text === 'current task' ? 0 : 2])
  } finally { await f.dispose() }
})

it('keeps the fixed head target when an independent tail summary repeats its original endpoint text', async () => {
  const f = await providerFixture()
  try {
    const input = f.input(f.input().regions.map((region, index) => index === 1
      ? { ...region, summary: 'Tail conclusion; completed 1 is a reference to prior work.' } : region))
    const { facts } = await f.submit(input)
    expect(facts.status).toBe('batch_success')
    expect(facts.execution_order).toEqual([1, 0])
    expect(facts.regions.map((fact: { status: string }) => fact.status)).toEqual(['committed', 'committed'])
    expect(f.session.surface.nodes).not.toContain(f.old[0])
  } finally { await f.dispose() }
})

it('continues to the head after a real tail native shrink failure', async () => {
  const f = await providerFixture()
  try {
    const input = f.input(f.input().regions.map((region, index) => index === 1 ? { ...region, summary: 'Too verbose. '.repeat(1800) } : region))
    const { facts } = await f.submit(input)
    expect(facts.status).toBe('partial')
    expect(facts.execution_order).toEqual([1, 0])
    expect(facts.regions.map((fact: { status: string }) => fact.status)).toEqual(['committed', 'failed'])
    expect(facts.regions[1].error).toContain('summary is not smaller')
    expect(f.session.surface.nodes).not.toContain(f.old[0])
    expect(f.session.surface.nodes).toContain(f.old[2])
  } finally { await f.dispose() }
})

it('marks all conflict participants, including a nested region, but commits independent history', async () => {
  const f = await providerFixture()
  try {
    const enclosing = { ...select('completed 1'), range: [{ text: 'completed 1' }, { text: 'completed 2' }] }
    const { facts } = await f.submit(f.input([enclosing, select('completed 1'), select('completed 2'), f.input().regions[1]!]))
    expect(facts.regions.map((fact: { status: string }) => fact.status)).toEqual(['failed', 'failed', 'failed', 'committed'])
    for (const fact of facts.regions.slice(0, 3)) expect(fact.error).toContain('overlap or are adjacent')
  } finally { await f.dispose() }
})

it('expands a result through a multi-call assistant and an intervening tool pair until closure', async () => {
  const f = await providerFixture()
  try {
    const a = ToolCallId('multi-a'), b = ToolCallId('multi-b'), c = ToolCallId('intervening-c')
    const assistant = (text: string, ids: readonly typeof a[]) => createMessage({ role: 'assistant',
      content: [{ type: 'text', text }, ...ids.map(id => ({ type: 'tool-call' as const, id, name: 'historical', arguments: '{}' }))],
      source: { kind: 'model', provider: 'author', model: 'working' } })
    const result = (id: typeof a, text: string) => createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text }] })
    const messages = [assistant('multi-call start', [a, b]), assistant('intervening call', [c]), result(a, 'first result'), result(b, 'second result'), result(c, 'closure end')]
    const derive = f.session.deriveEventMessage.bind(f.session)
    const nodes = [...f.session.surface.nodes]
    const first = nodes.indexOf(f.old[0]!)
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      const index = nodes.indexOf(event.seq) - first
      return index >= 0 && index < messages.length ? messages[index]! : derive(event)
    })
    const input = f.input([select('first result')])
    const batch = await preflightRegions(f.ctx, f.agent, f.identity, input, f.config)
    expect(batch.regions[0]!.seqs).toEqual(nodes.slice(first, first + 5))
    expect(batch.facts[0]).toMatchObject({ expanded: true, status: 'not_attempted', range: input.regions[0]!.range })
    const conflict = await preflightRegions(f.ctx, f.agent, f.identity, f.input([select('first result'), select('closure end')]), f.config)
    expect(conflict.facts.map(fact => fact.status)).toEqual(['failed', 'failed'])
    expect(conflict.facts.every(fact => fact.error?.includes('after tool-pair expansion'))).toBe(true)
  } finally { await f.dispose() }
})

it.each(['protected', 'missing'] as const)('fails a region when automatic completion hits a %s counterpart', async mode => {
  const f = await providerFixture()
  try {
    const id = ToolCallId('protected-pair')
    const derive = f.session.deriveEventMessage.bind(f.session)
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      if (event.seq === f.old[2]) return createMessage({ role: 'assistant', content: [
        { type: 'text', text: 'select incomplete call' }, { type: 'tool-call', id, name: 'historical', arguments: '{}' },
      ] as ContentBlock[], source: { kind: 'model', provider: 'author', model: 'working' } })
      if (mode === 'protected' && event.seq === f.latestTask) return createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: 'protected result' }] })
      return derive(event)
    })
    const batch = await preflightRegions(f.ctx, f.agent, f.identity, f.input([select('select incomplete call'), f.input().regions[0]!]), f.config)
    expect(batch.facts[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(mode === 'protected' ? /protected context/ : /counterpart is missing/) })
    if (mode === 'protected') expect(batch.facts[0]!.expanded).toBe(true)
    expect(batch.facts[1]!.status).toBe('not_attempted')
  } finally { await f.dispose() }
})

it.each(['result', 'intervening-notice'] as const)('commits the real multi-call span selected by %s and an independent head', async mode => {
  const input = { regions: [select('Independent historical head '), select(mode === 'result' ? 'Result A boundary' : 'Intervening historical notice')] }
  const f = await createLoopFixture([
    [{ type: 'text', text: 'Independent head phase complete.' }],
    [{ type: 'text', text: 'Historical tool batch starts.' },
      { type: 'tool-call', id: ToolCallId('historical-a'), name: 'historical_batch', arguments: '{"label":"A"}' },
      { type: 'tool-call', id: ToolCallId('historical-b'), name: 'historical_batch', arguments: '{"label":"B"}' }],
    [{ type: 'text', text: 'Historical tool phase complete.' }],
    [{ type: 'tool-call', id: ToolCallId('compress-expanded'), name: 'context_compress', arguments: JSON.stringify(input) }],
    request => {
      const visible = JSON.stringify(request.messages)
      expect(visible).toContain('Completed conclusion.')
      expect(visible).not.toContain('historical-a')
      expect(visible).not.toContain('historical-b')
      expect(visible).not.toContain('compress-expanded')
      expect(visible).toContain(input.regions[1]!.range[0]!.text)
      return [{ type: 'text', text: 'Completed using the retained tool conclusions.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
  })
  try {
    f.ctx.tools.register(defineTool({ name: 'historical_batch', description: 'Historical multi-call fixture',
      parameters: { label: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        if (args.label === 'A') exec.agent!.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Intervening historical notice' }],
          source: { kind: 'user', form: 'notice', summary: 'Intervening tool batch notice' },
        }), { surfaceOp: 'append' })
        return 'Result ' + args.label + ' boundary; ' + 'historical details '.repeat(700)
      },
    }))
    await runTurn(f.agent, 'Independent historical head ' + 'head details '.repeat(700))
    await runTurn(f.agent, 'Run the historical tool batch.')
    const originals = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result' || (event.type === 'user/message' && 'form' in event.data.source && event.data.source.form === 'notice')).map(event => event.seq)
    const author = f.agent.session.snapshotEvents().find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call' && block.id === 'historical-a'))!
    await runTurn(f.agent, 'Compress the completed historical tools and continue.')
    const native = f.agent.session.snapshotEvents().find(event => event.type === 'compaction/summary')
    expect(native?.type === 'compaction/summary' && native.data.shadowedSeqs).toEqual([author.seq, ...originals])
    const result = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'compress-expanded')
    if (result?.type !== 'tool/result' || result.data.message.content[0]?.type !== 'text') throw new Error('Missing actual compression result')
    const facts = JSON.parse(result.data.message.content[0].text)
    expect(facts.regions[0]).toMatchObject({ input_index: 0, status: 'committed', range: input.regions[0]!.range })
    expect(facts.regions[1]).toMatchObject({ input_index: 1, status: 'committed', expanded: true, range: input.regions[1]!.range, node_count: 4 })
    expect(facts.execution_order).toEqual([1, 0])
    expect(f.adapter.requests).toHaveLength(5)
  } finally { await f.ctx.fiber.dispose() }
})

it('reports known expansion and rejects both overlap participants even when another counterpart is missing', async () => {
  const f = await providerFixture()
  try {
    const a = ToolCallId('known-pair'), b = ToolCallId('missing-pair')
    const derive = f.session.deriveEventMessage.bind(f.session)
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      if (event.seq === f.old[0]) return createMessage({ role: 'assistant', content: [
        { type: 'text', text: 'partially available calls' },
        ...[a, b].map(id => ({ type: 'tool-call' as const, id, name: 'historical', arguments: '{}' })),
      ], source: { kind: 'model', provider: 'author', model: 'working' } })
      if (event.seq === f.old[1]) return createToolResultMessage({ callId: a, isError: false, content: [{ type: 'text', text: 'known counterpart' }] })
      return derive(event)
    })
    const batch = await preflightRegions(f.ctx, f.agent, f.identity,
      f.input([select('known counterpart'), select('partially available calls'), select('completed 3')]), f.config)
    expect(batch.facts.map(fact => fact.status)).toEqual(['failed', 'failed', 'not_attempted'])
    expect(batch.facts[0]).toMatchObject({ expanded: true, error: expect.stringContaining('counterpart is missing') })
    expect(batch.facts[0]!.error).toContain('overlap or are adjacent')
    expect(batch.facts[1]!.error).toContain('overlap or are adjacent')
  } finally { await f.dispose() }
})

it.each(['interior-notice', 'missing-overlap'] as const)('handles native historical events for review regression %s', async mode => {
  const f = await providerFixture()
  try {
    const session = f.session
    session.append('tool/result', { turn: 4, step: 1, message: createToolResultMessage({
      callId: f.identity.callId, isError: false, content: [{ type: 'text', text: 'Previous current call complete.' }],
    }) }, { surfaceOp: 'append', sourceEventSeqs: [f.identity.assistantSeq] })
    session.append('step/end', { turn: 4, step: 1 })
    session.append('step/start', { turn: 4, step: 2 })
    const callId = ToolCallId('historical-review-call')
    const assistant = session.append('assistant/message', { turn: 4, step: 2, stream: [], message: createMessage({
      role: 'assistant', content: [
        { type: 'text', text: 'Historical missing counterpart' },
        { type: 'tool-call', id: callId, name: 'historical', arguments: '{}' },
      ], source: { kind: 'model', provider: 'author', model: 'working' },
    }) }, { surfaceOp: 'append' })
    if (mode === 'interior-notice') {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Historical in-tool notice ' + 'details '.repeat(700) }],
        source: { kind: 'user', form: 'notice', summary: 'Historical in-tool notice' },
      }), { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 4, step: 2, callId, name: 'historical', arguments: '{}' })
      session.append('tool/result', { turn: 4, step: 2, message: createToolResultMessage({
        callId, isError: false, content: [{ type: 'text', text: 'Historical matching result ' + 'details '.repeat(700) }],
      }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    session.append('step/end', { turn: 4, step: 2 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'New live task' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 4, step: 3 })
    const input = mode === 'interior-notice'
      ? f.input([f.input().regions[0]!, select('Historical in-tool notice')])
      : f.input([{ ...select('completed 1'), range: [{ text: 'completed 1' }, { text: 'Historical missing counterpart' }] }, f.input().regions[0]!])
    const { result, facts } = await f.submit(input, { ...f.identity, step: 3 })
    expect(result.isError).toBe(false)
    if (mode === 'interior-notice') {
      expect(facts.status).toBe('batch_success')
      expect(facts.regions.map((fact: { status: string }) => fact.status)).toEqual(['committed', 'committed'])
      expect(facts.regions[1]).toMatchObject({ expanded: true, node_count: 3 })
      expect(facts.execution_order).toEqual([1, 0])
      expect(session.surface.nodes).not.toContain(assistant.seq)
      expect(session.surface.nodes).not.toContain(f.old[0])
    } else {
      expect(facts.status).toBe('all_failed')
      expect(facts.regions.map((fact: { status: string }) => fact.status)).toEqual(['failed', 'failed'])
      expect(facts.regions[0].error).toContain('counterpart is missing')
      expect(facts.regions[1].error).toContain('overlap or are adjacent')
      expect(session.surface.nodes).toContain(f.old[0])
    }
  } finally { await f.dispose() }
})
