import { expect, it, vi } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createLoopFixture, runTurn } from './loop-fixtures/agent-loop.ts'
import { loadActiveContext } from './loop-fixtures/loader.ts'
import { preflightRegions, renderBatchFacts } from '../src/regions.ts'
import { providerFixture } from './provider-fixture.ts'
import { deriveEventMessage, type SessionMessageProjection } from '@deepseek-ai/dsh-session'
import type { TextEndpoint } from '../src/types.ts'

const literal = '550: fig\n551: \n552: # %% [markdown] id="anchored-case-guide"'
const select = (text: string, role?: 'tool') => ({ range: [0, 1].map(() => role === undefined ? { text } : { text, role }), summary: 'PRIVATE_SUMMARY_NOT_IN_DIAGNOSTICS' })
const diagnostics = (error: string) => JSON.parse(error.slice(error.indexOf('{')))

it('distinguishes actual same-file read candidates by their own call ranges and literal body context', async () => {
  const bodies = [
    '<path>/same/file.py</path>\n<content>\n' + 'earlier file lines\n'.repeat(200) + '549: earlier plot setup\n' + literal + '\n553: older trailing body\n</content>',
    '<path>/same/file.py</path>\n<content>\n' + literal + '\n553: later guide body\n</content>',
  ]
  const input = { regions: [select(literal, 'tool')] }
  const calls = [{ offset: 415, limit: 145 }, { offset: 550, limit: 107 }].map(args => ({ type: 'tool-call' as const,
    id: ToolCallId('reused-read-id'), name: 'read', arguments: JSON.stringify({ file_path: '/same/file.py', ...args, headers: 'PRIVATE_HEADERS', password: 'PRIVATE_PASSWORD' }),
  }))
  const f = await createLoopFixture([
    [calls[0]!], [calls[1]!], [{ type: 'text', text: 'Read work complete.' }],
    [{ type: 'tool-call', id: ToolCallId('ambiguous-read-compress'), name: 'context_compress', arguments: JSON.stringify(input) }],
    request => {
      const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'ambiguous-read-compress')
      if (result?.content[0]?.type !== 'text') throw new Error('Missing ambiguous result')
      const facts = JSON.parse(result.content[0].text)
      expect(facts.status).toBe('failed')
      expect(facts.regions[0]).toMatchObject({ input_index: 0, status: 'failed', range: input.regions[0]!.range })
      const error = facts.regions[0].error
      expect(error).toContain('endpoint 0 is ambiguous')
      const detail = diagnostics(error)
      expect(detail).toMatchObject({ text: literal, role: 'tool', candidate_count: 2, shown: 2 })
      expect(detail.clues.map((clue: { role: string; tool: string; read: object }) => ({ role: clue.role, tool: clue.tool, read: clue.read }))).toEqual([
        { role: 'tool', tool: 'read', read: { offset: 415, limit: 145 } },
        { role: 'tool', tool: 'read', read: { offset: 550, limit: 107 } },
      ])
      expect(detail.clues[0].text).toContain('549: earlier plot setup')
      expect(detail.clues[1].text).toContain('553: later guide body')
      for (const [index, clue] of detail.clues.entries()) {
        expect(clue.text).toContain(literal)
        expect(bodies[index]!).toContain(clue.text)
        expect(Array.from(clue.text).length).toBeLessThanOrEqual(160)
        expect(clue).not.toHaveProperty('seq')
        expect(clue).not.toHaveProperty('call_id')
      }
      for (const secret of ['PRIVATE_HEADERS', 'PRIVATE_PASSWORD', 'PRIVATE_SUMMARY_NOT_IN_DIAGNOSTICS', 'file_path', 'arguments']) expect(error).not.toContain(secret)
      expect(error.length).toBeLessThan(1500)
      return [{ type: 'text', text: 'Need a more distinctive literal endpoint.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
  })
  try {
    f.ctx.tools.register(defineTool({ name: 'read', description: 'Read diagnostic fixture', parameters: {
      file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' }, headers: { type: 'string' }, password: { type: 'string' },
    }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => bodies[args.offset === 415 ? 0 : 1]!,
    }))
    await runTurn(f.agent, 'Read the file twice')
    await runTurn(f.agent, 'Compress the completed reads')
    expect(f.adapter.requests).toHaveLength(5)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
  } finally { await f.ctx.fiber.dispose() }
})

it('bounds candidate count and body clues, falls back to actual role without an attributable tool, and keeps render facts', async () => {
  const f = await providerFixture()
  try {
    const derive = f.session.deriveEventMessage.bind(f.session)
    const nodes = new Set(f.session.surface.nodes.slice(0, 6))
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => nodes.has(event.seq)
      ? createToolResultMessage({ callId: ToolCallId('unattributed'), isError: false, content: [{ type: 'text', text: 'wrapper '.repeat(1000) + 'shared literal ' + event.seq + ' tail '.repeat(1000) }] })
      : derive(event))
    const input = f.input([select('shared literal')])
    const { facts } = await preflightRegions(f.ctx, f.agent, f.identity, input, f.config)
    const detail = diagnostics(facts[0]!.error!)
    expect(detail).toMatchObject({ text: 'shared literal', candidate_count: 6, shown: 4 })
    expect(detail.clues).toHaveLength(4)
    for (const clue of detail.clues) {
      expect(clue.role).toBe('tool')
      expect(clue).not.toHaveProperty('tool')
      expect(clue).not.toHaveProperty('read')
      expect(Array.from(clue.text).length).toBeLessThanOrEqual(160)
    }
    const rendered = renderBatchFacts({ status: 'all_failed', executionOrder: [], regions: facts.map(fact => ({ ...fact, error: fact.error!.repeat(20) })) }, { ...f.config, resultMaxBytes: 2000 })
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(2000)
    expect(JSON.parse(rendered).regions[0]).toMatchObject({ input_index: 0, status: 'failed', range: input.regions[0]!.range, nodes: 0 })
    expect(rendered).not.toContain('PRIVATE_SUMMARY_NOT_IN_DIAGNOSTICS')
  } finally { await f.dispose() }
})

it('explains missing text and actual role mismatches without changing the selection', async () => {
  const f = await providerFixture()
  try {
    const check = async (endpoint: TextEndpoint) => {
      const result = await preflightRegions(f.ctx, f.agent, f.identity, f.input([{ range: [endpoint, endpoint], summary: 'Not committed.' }]), f.config)
      expect(result.regions).toEqual([])
      return result.facts[0]!.error!
    }
    const missing = await check({ text: 'not in any message' })
    expect(missing).toContain('text was not found in any eligible message text block')
    expect(missing).toContain('Tool-call arguments/code, reasoning, ACP notices/status records')
    expect(missing).not.toContain('Choose more distinctive text or add role')
    expect(missing).not.toContain('Role mismatch')
    expect(diagnostics(missing)).toEqual({ text: 'not in any message', candidate_count: 0 })
    const mismatch = await check({ text: 'completed 1', role: 'tool' })
    expect(mismatch).toContain('Role mismatch')
    expect(diagnostics(mismatch)).toMatchObject({ role: 'tool', actual_roles: ['assistant'], candidate_count: 0 })
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'completed 1' }], source: { kind: 'user', form: 'notice', summary: 'Ordinary notice' } }), { surfaceOp: 'append' })
    const multipleRoles = await check({ text: 'completed 1', role: 'tool' })
    expect(diagnostics(multipleRoles).actual_roles).toEqual(['assistant', 'user'])
    const result = await preflightRegions(f.ctx, f.agent, f.identity, f.input([select('completed 1', 'tool')]), f.config)
    const rendered = renderBatchFacts({ status: 'all_failed', executionOrder: [], regions: result.facts }, { ...f.config, resultMaxBytes: 1000 })
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(1000)
    expect(JSON.parse(rendered).regions[0].range[0].role).toBe('tool')
  } finally { await f.dispose() }
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'acp-test/project': { seq: import('@deepseek-ai/dsh-session').SessionSeq; text: string } }
}

it('matches committed projected text, not hidden stored text, with projectionMode none', async () => {
  const f = await providerFixture()
  try {
    const projection: SessionMessageProjection<'acp-test/project'> = { type: 'acp-test/project', project(event, context) {
      const original = deriveEventMessage(context.events[event.data.seq - context.baseSeq]!, context.messages)!
      return new Map([[event.data.seq, { ...original, content: [{ type: 'text' as const, text: event.data.text }] }]])
    } }
    f.ctx.sessions.registerMessageProjection(projection)
    f.session.append('acp-test/project', { seq: f.old[0]!, text: 'Visible projected endpoint' })
    expect(JSON.stringify(f.session.deriveMessages())).toContain('Visible projected endpoint')
    expect(JSON.stringify(f.session.deriveMessages())).not.toContain('completed 1')
    expect(JSON.stringify(f.session.eventAt(f.old[0]!)!)).toContain('completed 1')
    const { regions, facts } = await preflightRegions(f.ctx, f.agent, f.identity, f.input([
      select('Visible projected endpoint'), select('completed 1'),
    ]), f.config)
    expect(regions[0]!.seqs).toEqual([f.old[0]])
    expect(facts[1]!.error).toContain('has no match')
  } finally { await f.dispose() }
})

it('attributes each protection blocker to the original range or tool-pair expansion', async () => {
  const f = await providerFixture()
  try {
    const callId = ToolCallId('protected-span')
    const derive = f.session.deriveEventMessage.bind(f.session)
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      if (event.seq === f.old[0]) return createMessage({ role: 'assistant', source: { kind: 'model', provider: 'author', model: 'working' }, content: [{ type: 'tool-call', id: callId, name: 'old-tool', arguments: '{}' }] })
      if (event.seq === f.old[1]) return createUserMessage({ source: { kind: 'user', form: 'instructions' }, content: [{ type: 'text', text: 'Protected instruction inside span' }] })
      if (event.seq === f.old[2]) return createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'Historical span result' }] })
      return derive(event)
    })
    for (const [range, origin] of [
      [[{ text: 'Protected instruction inside span' }, { text: 'Historical span result' }], 'original_range'],
      [[{ text: 'Historical span result' }, { text: 'Historical span result' }], 'tool_pair_expansion'],
    ] as const) {
      const { facts } = await preflightRegions(f.ctx, f.agent, f.identity, f.input([{ range, summary: 'Rejected.' }]), f.config)
      expect(facts[0]!.expanded).toBe(true)
      const blockers = JSON.parse(facts[0]!.error!.match(/showing [0-9]+. (\[.*\]) Safe split ranges/)![1]!)
      expect(blockers).toContainEqual(expect.objectContaining({ reasons: ['live_instructions'], selection_origin: origin }))
      expect(facts[0]!.error).toContain('Move the boundaries or split around the blockers')
    }
    f.session.append('tool/result', { turn: 4, step: 1, message: createToolResultMessage({ callId: f.identity.callId, isError: false, content: [{ type: 'text', text: 'Current call finished' }] }) }, { surfaceOp: 'append' })
    f.session.append('user/message', createUserMessage({ source: { kind: 'user', form: 'notice', summary: 'Current notice' }, content: [{ type: 'text', text: 'Current-Step endpoint' }] }), { surfaceOp: 'append' })
    const { facts } = await preflightRegions(f.ctx, f.agent, f.identity, f.input([select('Current-Step endpoint')]), f.config)
    expect(facts[0]!.error).toContain('Current-Step nodes can only be compressed in a later Step')
    expect(facts[0]!.error).not.toContain('Move the boundaries or split around the blockers')
    expect(facts[0]!.error).toContain('"selection_origin":"original_range"')
  } finally { await f.dispose() }
})

it('real Loop matches finalized result text, not canonical values or superseded render output', async () => {
  const input = { regions: [select('Canonical value not shown'), select('Superseded rendered text'), select('Visible finalized endpoint', 'tool')] }
  const f = await createLoopFixture([
    [{ type: 'tool-call', id: ToolCallId('finalized-tool'), name: 'finalized_fixture', arguments: '{}' }],
    [{ type: 'text', text: 'Historical tool work finished.' }],
    [{ type: 'tool-call', id: ToolCallId('finalized-compress'), name: 'context_compress', arguments: JSON.stringify(input) }],
    request => {
      const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'finalized-compress')!
      if (result.content[0]?.type !== 'text') throw new Error('Missing compression facts')
      const facts = JSON.parse(result.content[0].text)
      expect(facts.status).toBe('partial')
      expect(facts.regions.map((region: { status: string }) => region.status)).toEqual(['failed', 'failed', 'committed'])
      for (const region of facts.regions.slice(0, 2)) expect(region.error).toContain('has no match')
      return [{ type: 'text', text: 'Finalized text was selected.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
    ctx.tools.register(defineTool({ name: 'finalized_fixture', description: 'Finalized result fixture', parameters: {},
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'Superseded rendered text' }] },
      finalizeContent: () => [{ type: 'text', text: 'Visible finalized endpoint ' + 'details '.repeat(700) }],
      execute: async () => 'Canonical value not shown',
    }))
  })
  try {
    await runTurn(f.agent, 'Complete historical tool work')
    await runTurn(f.agent, 'Compress finalized history')
    expect(f.adapter.requests).toHaveLength(4)
  } finally { await f.ctx.fiber.dispose() }
})
