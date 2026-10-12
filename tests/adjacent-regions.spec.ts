import { expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertCompleteToolPairs } from '../src/protection.ts'
import { ActiveCompactionEngine } from '../src/provider.ts'
import { createLoopFixture, runTurn } from './loop-fixtures/agent-loop.ts'
import { loadActiveContext } from './loop-fixtures/loader.ts'

it.each(['complete', 'closure'] as const)('commits %s adjacent native regions separately, then cleans up and replays', async mode => {
  const resultText = 'Historical read result boundary '
  const summaries = ['First retained conclusion.', resultText + 'is retained in the second conclusion.']
  const input = { regions: [
    { range: [{ text: mode === 'complete' ? 'Historical call boundary' : resultText, role: mode === 'complete' ? 'assistant' : 'tool' },
      { text: resultText, role: 'tool' }], summary: summaries[0] },
    { range: [{ text: 'Historical final boundary', role: 'assistant' }, { text: 'Historical final boundary', role: 'assistant' }], summary: summaries[1] },
  ] }
  const f = await createLoopFixture([
    [{ type: 'text', text: 'Historical call boundary' }, { type: 'tool-call', id: ToolCallId('adjacent-history'), name: 'historical_read', arguments: '{}' }],
    [{ type: 'text', text: 'Historical final boundary ' + 'final details '.repeat(700) }],
    [{ type: 'tool-call', id: ToolCallId('adjacent-compress'), name: 'context_compress', arguments: JSON.stringify(input) }],
    request => {
      const visible = JSON.stringify(request.messages)
      for (const summary of summaries) expect(visible).toContain(summary)
      expect(visible).not.toContain('adjacent-history')
      expect(visible).not.toContain('adjacent-compress')
      expect(visible).not.toContain('final details')
      expect(request.messages.some(message => message.source?.kind === 'acp-maintenance')).toBe(true)
      return [{ type: 'text', text: 'Continued with both conclusions.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
  })
  try {
    f.ctx.tools.register(defineTool({ name: 'historical_read', description: 'Historical test result', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => resultText + 'read details '.repeat(700),
    }))
    await runTurn(f.agent, 'Historical task')
    const history = f.agent.session.snapshotEvents()
    const author = history.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call'))!
    const read = history.find(event => event.type === 'tool/result')!
    const final = history.findLast(event => event.type === 'assistant/message')!
    const initial = [...f.agent.session.surface.nodes]
    expect(initial.indexOf(final.seq)).toBe(initial.indexOf(read.seq) + 1)
    const engine = f.ctx.compaction as ActiveCompactionEngine
    const submit = vi.spyOn(engine, 'compactPrewritten')
    await runTurn(f.agent, 'Compress the completed history')
    expect(submit.mock.calls.map(([region]) => ({ index: region.inputIndex, endpoints: region.endpointSeqs, seqs: region.seqs }))).toEqual([
      { index: 1, endpoints: [final.seq, final.seq], seqs: [final.seq] },
      { index: 0, endpoints: [mode === 'complete' ? author.seq : read.seq, read.seq], seqs: [author.seq, read.seq] },
    ])
    const events = f.agent.session.snapshotEvents()
    const native = events.filter(event => event.type === 'compaction/summary')
    expect(native.map(event => ({ seqs: event.data.shadowedSeqs, summary: event.data.summary }))).toEqual([
      { seqs: [final.seq], summary: [{ type: 'text', text: summaries[1] }] },
      { seqs: [author.seq, read.seq], summary: [{ type: 'text', text: summaries[0] }] },
    ])
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'adjacent-compress')
    if (result?.type !== 'tool/result' || result.data.message.content[0]?.type !== 'text') throw new Error('Missing compression result')
    expect(result.data.message.isError).toBe(false)
    const facts = JSON.parse(result.data.message.content[0].text)
    expect(facts.status).toBe('batch_success')
    expect(facts.execution_order).toEqual([1, 0])
    expect(facts.regions.map((fact: { range: object; status: string; expanded: boolean }) => ({ range: fact.range, status: fact.status, expanded: fact.expanded }))).toEqual([
      { range: input.regions[0]!.range, status: 'committed', expanded: mode === 'closure' },
      { range: input.regions[1]!.range, status: 'committed', expanded: false },
    ])
    const maintenance = events.find(event => event.type === 'user/message' && event.data.source.kind === 'acp-maintenance')
    if (maintenance?.type !== 'user/message' || maintenance.data.content[0]?.type !== 'text') throw new Error('Missing cleanup record')
    const body = maintenance.data.content[0].text
    const record = JSON.parse(body.slice(body.indexOf('{')))
    expect(record.regions.map((region: { range: object; status: string }) => ({ range: region.range, status: region.status }))).toEqual(
      input.regions.map(region => ({ range: region.range, status: 'committed' })))
    for (const summary of summaries) expect(body).not.toContain(summary)
    expect(f.agent.session.surface.nodes).not.toContain(result.seq)
    assertCompleteToolPairs(f.agent.session.deriveMessages())
    const replay = Session.create(SessionId('adjacent-replay'), JSON.parse(JSON.stringify(events)) as SessionEvent[])
    expect(replay.surface.nodes).toEqual(f.agent.session.surface.nodes)
    expect(replay.deriveMessages()).toEqual(f.agent.session.deriveMessages())
    expect(f.adapter.requests).toHaveLength(4)
  } finally { await f.ctx.fiber.dispose() }
})

it('rejects both disjoint original nodes when native tool closure makes their regions identical', async () => {
  const input = { regions: ['Shared call body', 'Shared result body'].map(text => ({ range: [{ text }, { text }], summary: 'Retained conclusion.' })) }
  const f = await createLoopFixture([
    [{ type: 'text', text: 'Shared call body' }, { type: 'tool-call', id: ToolCallId('shared-history'), name: 'historical', arguments: '{}' }],
    [{ type: 'text', text: 'Shared tool work completed.' }],
    [{ type: 'tool-call', id: ToolCallId('shared-compress'), name: 'context_compress', arguments: JSON.stringify(input) }],
    request => {
      const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'shared-compress')
      if (result?.content[0]?.type !== 'text') throw new Error('Missing conflict result')
      const facts = JSON.parse(result.content[0].text)
      expect(facts.status).toBe('all_failed')
      expect(facts.execution_order).toEqual([])
      expect(facts.regions.map((fact: { status: string; expanded: boolean; node_count: number }) => ({ status: fact.status, expanded: fact.expanded, node_count: fact.node_count })))
        .toEqual([{ status: 'failed', expanded: true, node_count: 2 }, { status: 'failed', expanded: true, node_count: 2 }])
      for (const [index, fact] of facts.regions.entries()) {
        expect(fact.range).toEqual(input.regions[index]!.range)
        expect(fact.error).toBe('ACP: regions 0 and 1 have identical ranges after tool-pair expansion (shared node_count: 2); select them again')
      }
      return [{ type: 'text', text: 'Reselect non-overlapping historical work.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
  })
  try {
    f.ctx.tools.register(defineTool({ name: 'historical', description: 'Shared closure fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'Shared result body ' + 'old details '.repeat(700),
    }))
    await runTurn(f.agent, 'Historical shared span')
    await runTurn(f.agent, 'Attempt to compress the original disjoint nodes')
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
    assertCompleteToolPairs(f.agent.session.deriveMessages())
  } finally { await f.ctx.fiber.dispose() }
})
