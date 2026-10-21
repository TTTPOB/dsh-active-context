import { expect, it, vi } from 'vitest'
import { createMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { endpointClues, endpointMatches } from '../src/endpoints.ts'
import type { SurfaceCapture } from '../src/protection.ts'
import { preflightRegions } from '../src/regions.ts'
import { ACP_INSTRUCTIONS } from '../src/index.ts'
import { providerFixture } from './provider-fixture.ts'
import { createLoopFixture, runTurn } from './loop-fixtures/agent-loop.ts'
import { loadActiveContext } from './loop-fixtures/loader.ts'

const call = (name: string, args: unknown): ContentBlock => ({ type: 'tool-call', name, id: ToolCallId(name), arguments: JSON.stringify(args) })
function surface(nodes: ContentBlock[][]): SurfaceCapture {
  const session = Session.create(SessionId('argument-endpoints'))
  for (const content of nodes) session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'test', model: 'test' } }) }, { surfaceOp: 'append' })
  const log = session.snapshotEvents()
  const seqs = [...session.surface.nodes]
  const events = seqs.map(seq => log[seq]!)
  return { seqs, events, log, messages: events.map(event => session.deriveEventMessage(event)) }
}

it('uses argument values only on zero text hits, retaining text uniqueness and ambiguity', () => {
  const s = surface([
    [{ type: 'text', text: 'shared endpoint; unique text' }],
    [{ type: 'text', text: 'shared endpoint' }],
    [call('send_message', { message: 'shared endpoint; unique text; argument only' })],
    [call('other', { text: 'unique text' })],
  ])
  expect(endpointMatches(s, { text: 'unique text' }).map(match => match.index)).toEqual([0])
  expect(endpointMatches(s, { text: 'shared endpoint' }).map(match => match.index)).toEqual([0, 1])
  expect(endpointMatches(s, { text: 'argument only' })).toMatchObject([{ index: 2, role: 'assistant', argument: { tool: 'send_message', path: ['message'] } }])
  expect(endpointMatches(s, { text: 'argument only', role: 'tool' })).toEqual([])
})

it('searches decoded string leaves recursively, not keys, numbers, raw escapes, or malformed JSON', () => {
  const decoded = "first line\nsecond \"quoted\" line"
  const s = surface([
    [call('nested', { nested: [{ keyOnly: decoded, number: 987654, absent: null }], again: decoded }), call('same-node', { value: decoded })],
    [{ type: 'tool-call', name: 'broken', id: ToolCallId('broken'), arguments: '{"value":"malformed only"' }],
    [call('array-root', ['root array value'])],
  ])
  expect(endpointMatches(s, { text: decoded })).toMatchObject([{ index: 0, text: decoded, argument: { path: ['nested', 0, 'keyOnly'] } }])
  for (const text of ["keyOnly","987654","null","malformed only","first line\\nsecond","\\\"quoted\\\""]) expect(endpointMatches(s, { text })).toEqual([])
  expect(endpointMatches(s, { text: 'root array value' })).toMatchObject([{ index: 2, argument: { path: [0] } }])
})

it('excludes every native compression argument and canonical PTC code without excluding ordinary programs', () => {
  const endpoint = 'original historical argument'
  const range = [{ text: endpoint }, { text: endpoint }]
  const s = surface([
    [call('send_message', { message: endpoint })],
    [call('context_compress', { regions: [{ range, summary: 'Failed or partial earlier attempt' }] })],
    [call('context_compress', { regions: [{ range, summary: endpoint }] })],
    [call('run_code', { code: 'return await tools.context_compress(' + JSON.stringify({ regions: [{ range, summary: endpoint }] }) + ');', description: 'canonical description still searchable' })],
    [call('run_code', { code: 'console.log("ordinary code endpoint")' })],
  ])
  expect(endpointMatches(s, { text: endpoint }).map(match => match.index)).toEqual([0])
  expect(endpointMatches(s, { text: 'Failed or partial earlier attempt' })).toEqual([])
  expect(endpointMatches(s, { text: 'tools.context_compress' })).toEqual([])
  expect(endpointMatches(s, { text: 'ordinary code endpoint' }).map(match => match.index)).toEqual([4])
  expect(endpointMatches(s, { text: 'canonical description still searchable' }).map(match => match.index)).toEqual([3])
})

it('reports bounded argument ambiguity clues with tool names and key paths, counting nodes once', () => {
  const s = surface([
    [call('send_message', { nested: [{ message: '前'.repeat(200) + 'shared argument' + '後'.repeat(200) }], duplicate: 'shared argument' })],
    [call('run_code', { code: 'shared argument' })],
  ])
  const matches = endpointMatches(s, { text: 'shared argument' })
  expect(matches).toHaveLength(2)
  const clues = endpointClues(s, { text: 'shared argument' }, matches)
  expect(clues[0]).toMatchObject({ role: 'assistant', tool: 'send_message', argument_path: ['nested', 0, 'message'] })
  expect(clues[1]).toMatchObject({ role: 'assistant', tool: 'run_code', argument_path: ['code'] })
  for (const clue of clues) {
    expect(clue.text).toContain('shared argument')
    expect(Array.from(clue.text).length).toBeLessThanOrEqual(160)
  }
})

it('reports the assistant role on argument-only misses without correcting it', async () => {
  const f = await providerFixture()
  try {
    const derive = f.session.deriveEventMessage.bind(f.session)
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => event.seq === f.old[0]
      ? createMessage({ role: 'assistant', source: { kind: 'model', provider: 'author', model: 'working' }, content: [call('send_message', { message: 'argument role endpoint' })] }) : derive(event))
    const endpoint = { text: 'argument role endpoint', role: 'tool' as const }
    const result = await preflightRegions(f.ctx, f.agent, f.identity, f.input([{ range: [endpoint, endpoint], summary: 'Rejected role.' }]), f.config)
    expect(result.regions).toEqual([])
    expect(result.facts[0]!.error).toContain('Role mismatch')
    expect(result.facts[0]!.error).toContain('"actual_roles":["assistant"]')
    vi.mocked(f.session.deriveEventMessage).mockImplementation(event => f.old.slice(0, 2).includes(event.seq)
      ? createMessage({ role: 'assistant', source: { kind: 'model', provider: 'author', model: 'working' }, content: [call('send_message', { message: 'argument role endpoint' })] }) : derive(event))
    const ambiguous = { text: endpoint.text, role: 'assistant' as const }
    const rejected = await preflightRegions(f.ctx, f.agent, f.identity, f.input([{ range: [ambiguous, ambiguous], summary: 'Ambiguous arguments.' }]), f.config)
    expect(rejected.facts[0]!.error).toContain('endpoint 0 is ambiguous')
    const detail = JSON.parse(rejected.facts[0]!.error!.slice(rejected.facts[0]!.error!.indexOf('{')))
    expect(detail).toMatchObject({ candidate_count: 2, shown: 2 })
    expect(detail.clues).toEqual([
      { role: 'assistant', tool: 'send_message', argument_path: ['message'], text: endpoint.text },
      { role: 'assistant', tool: 'send_message', argument_path: ['message'], text: endpoint.text },
    ])
  } finally { await f.dispose() }
})

it('real Loop selects an argument-only historical assistant and completes its tool pair', async () => {
  const text = "Keep the exact argument\nincluding \"quotes\"."
  const endpoint = { text, role: 'assistant' as const }
  const input = { regions: [{ range: [endpoint, endpoint], summary: 'Historical tool call and result retained.' }] }
  const f = await createLoopFixture([
    [call('historical_message', { message: text })],
    [{ type: 'text', text: 'Historical work done.' }],
    [call('context_compress', input)],
    request => {
      const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'context_compress')!
      if (result.content[0]?.type !== 'text') throw new Error('Missing compression result')
      const facts = JSON.parse(result.content[0].text)
      expect(facts.status).toBe('compressed')
      expect(facts.regions[0]).toMatchObject({ expanded: true, nodes: 2, range: input.regions[0]!.range })
      return [{ type: 'text', text: 'Historical pair compressed.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
    ctx.tools.register(defineTool({ name: 'historical_message', description: 'Historical argument fixture', parameters: { message: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'result details '.repeat(700),
    }))
  })
  try {
    await runTurn(f.agent, 'Historical task')
    await runTurn(f.agent, 'Compress historical pair')
    expect(f.adapter.requests).toHaveLength(4)
    const tool = f.ctx.tools.schemas().find(tool => tool.name === 'context_compress')!
    for (const guidance of [ACP_INSTRUCTIONS, tool.description, JSON.stringify(tool.parameters)]) {
      expect(guidance).toContain('including earlier failed/partial calls')
      expect(guidance).toContain('canonical PTC compression run_code code')
    }
    expect(ACP_INSTRUCTIONS).toContain('Prefer a native context_compress call whenever directly callable')
    expect(tool.description).toContain('Prefer native context_compress when directly callable')
  } finally { await f.ctx.fiber.dispose() }
})
