import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { loadActiveContext } from './loop-fixtures/loader.ts'
import type { CompressInput } from '../src/types.ts'
import { createLoopFixture, HISTORY, runTurn, seedHistory } from './loop-fixtures/agent-loop.ts'

import { selection, summaries } from './loop-fixtures/compression-input.ts'

it('recovers from mixed task text by directly retrying literal regions in a separate native response', async () => {
  let input: CompressInput | undefined
  const compression = (id: string) => {
    if (input === undefined) throw new Error('Compression input was not selected')
    return { type: 'tool-call' as const, id: ToolCallId(id), name: 'context_compress', arguments: JSON.stringify(input) }
  }
  const { ctx, agent } = await createLoopFixture([
    [{ type: 'text', text: 'Historical A complete; alpha still needs verification.' }],
    [{ type: 'text', text: 'Middle constraint retained.' }],
    [{ type: 'text', text: 'Historical B complete; beta still needs verification.' }],
    () => [{ type: 'text', text: 'Task answer mixed with compression.' }, compression('mixed-compress')],
    () => {
      const rejected = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'mixed-compress')
      if (rejected?.type !== 'tool/result') throw new Error('Guard rejection was not recorded')
      expect(rejected.data.message.isError).toBe(true)
      const feedback = rejected.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      expect(feedback).toMatch(/independent native\/both call/i)
      expect(feedback).toMatch(/separate assistant response/i)
      expect(feedback).toMatch(/two.*literal text endpoints.*range/i)
      expect(feedback).toMatch(/optional role/i)
      expect(feedback).toMatch(/non-empty summary/i)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
      return [compression('retry-compress')]
    },
    request => {
      for (const summary of summaries) expect(JSON.stringify(request.messages)).toContain(summary)
      return [{ type: 'text', text: 'Continued after the independent compression retry.' }]
    },
  ], async context => {
    await context.plugin(TokenMeter)
    await context.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(context, { basic: { auto: false } })
  })
  try {
    await seedHistory(agent)
    input = selection(agent.session)
    await runTurn(agent, 'Continue the task after compressing completed history.')
    const events = agent.session.snapshotEvents()
    const retried = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'retry-compress')
    expect(retried).toMatchObject({ type: 'tool/result', data: { message: { isError: false } } })
    expect(events.filter(event => event.type === 'compaction/summary').map(event => event.data.summary)).toEqual([
      [{ type: 'text', text: input.regions[1]!.summary }],
      [{ type: 'text', text: input.regions[0]!.summary }],
    ])
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  } finally {
    await ctx.fiber.dispose()
  }
})

interface CommittedRegion {
  input_index: number
  compaction_id: string
  replacement_seq: SessionSeq
  readback: { summary_seq: SessionSeq }
  route_token_reduction: number
}

it('commits two nonadjacent native regions, hides only their finalized successful pair, then continues real tool work and replays', async () => {
  let input: CompressInput | undefined
  const work: string[] = []
  const { ctx, agent, adapter } = await createLoopFixture([
    [{ type: 'text', text: 'Historical A complete; alpha still needs verification.' }],
    [{ type: 'text', text: 'Middle constraint retained.' }],
    [{ type: 'text', text: 'Historical B complete; beta still needs verification.' }],
    () => {
      if (input === undefined) throw new Error('Compression input was not sampled')
      return [{ type: 'tool-call', id: ToolCallId('compress-two'), name: 'context_compress', arguments: JSON.stringify(input) }]
    },
    request => {
      const visible = JSON.stringify(request.messages)
      expect(visible).toContain(summaries[0])
      expect(visible).toContain(summaries[1])
      expect(visible).toContain(HISTORY[1].text)
      expect(visible).not.toContain('old detail A')
      expect(visible).not.toContain('old detail B')
      expect(visible).not.toContain('compress-two')
      expect(request.messages.some(message => message.source?.kind === 'acp-maintenance')).toBe(true)
      return [{ type: 'tool-call', id: ToolCallId('continued-verification'), name: 'acceptance_verify', arguments: '{"value":"alpha and beta verified"}' }]
    },
    request => {
      expect(JSON.stringify(request.messages)).toContain('VERIFIED: alpha and beta verified')
      return [{ type: 'text', text: 'Task completed after compression; public command unchanged.' }]
    },
  ], async context => {
    await context.plugin(TokenMeter)
    await context.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(context, { basic: { auto: false } })
  })
  try {
    ctx.tools.register(defineContentToolFixture({
      name: 'acceptance_verify', description: 'External deterministic work after compression',
      parameters: { value: { type: 'string' } },
      async execute(args) {
        work.push(args.value as string)
        return [{ type: 'text', text: 'VERIFIED: ' + args.value }]
      },
    }))
    await seedHistory(agent)
    input = selection(agent.session)
    const originalSurface = [...agent.session.surface.nodes]
    const originalTargets = input.regions.map(region => {
      const indices = region.range.map(endpoint => originalSurface.findIndex(seq => {
        const event = agent.session.eventAt(seq)!
        const message = agent.session.deriveEventMessage(event)
        return message !== null && message.role === endpoint.role && message.content.some(block => block.type === 'text' && block.text === endpoint.text)
      }))
      expect(indices[0]).toBeGreaterThanOrEqual(0)
      expect(indices[1]).toBeGreaterThanOrEqual(indices[0]!)
      return originalSurface.slice(indices[0], indices[1]! + 1)
    })
    await runTurn(agent, 'Complete alpha and beta verification using the preserved constraints.')
    expect(adapter.requests).toHaveLength(6)
    expect(work).toEqual(['alpha and beta verified'])
    const events = agent.session.snapshotEvents()
    const native = events.filter(event => event.type === 'compaction/summary')
    expect(native).toHaveLength(2)
    expect(native.every(event => event.data.provider === 'acceptance' && event.data.model === 'scripted')).toBe(true)
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'compress-two')
    if (result?.type !== 'tool/result') throw new Error('Final durable compression result missing')
    expect(result.data.message.isError).not.toBe(true)
    const text = result.data.message.content.find(block => block.type === 'text')
    if (text?.type !== 'text') throw new Error('Final compression content missing')
    const facts: { status: string; execution_order: number[]; regions: CommittedRegion[] } = JSON.parse(text.text)
    expect(facts.status).toBe('batch_success')
    expect(facts.execution_order).toEqual([1, 0])
    expect(facts.regions.map(region => region.input_index)).toEqual([0, 1])
    const assertAssociations = (regions: CommittedRegion[]) => {
      for (const region of regions) {
        const target = originalTargets[region.input_index]!
        const summary = input!.regions[region.input_index]!.summary
        const transaction = native.find(event => event.data.compactionId === region.compaction_id)
        expect(transaction).toBeDefined()
        expect(region.readback.summary_seq).toBe(transaction!.seq)
        expect(transaction!.data.shadowedSeqs).toEqual(target)
        expect(transaction!.data.summary).toEqual([{ type: 'text', text: summary }])
        const replacement = agent.session.eventAt(region.replacement_seq)
        expect(replacement).toMatchObject({
          type: 'user/message',
          surfaceOp: { op: 'replace', startSeq: target[0], endSeq: target.at(-1) },
          sourceEventSeqs: expect.arrayContaining([transaction!.seq, ...target]),
        })
        expect(agent.session.surface.nodes).toContain(region.replacement_seq)
        const message = agent.session.deriveEventMessage(replacement!)
        expect(message?.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining(summary) }))
      }
    }
    assertAssociations(facts.regions)
    // The input labels stay correct while transaction facts or only readbacks cross.
    expect(() => assertAssociations(facts.regions.map((region, index) => ({
      ...facts.regions[1 - index]!, input_index: region.input_index,
    })))).toThrow()
    expect(() => assertAssociations(facts.regions.map((region, index) => ({
      ...region, readback: facts.regions[1 - index]!.readback,
    })))).toThrow()
    expect(facts.regions.every(region => region.route_token_reduction > 0)).toBe(true)
    const maintenance = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'acp-maintenance')
    expect(maintenance).toHaveLength(1)
    expect(maintenance[0]!.seq).toBeGreaterThan(result.seq)
    expect(agent.session.surface.nodes).not.toContain(result.seq)
    const author = events.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call' && block.id === 'compress-two'))
    expect(author).toBeDefined()
    expect(agent.session.surface.nodes).not.toContain(author!.seq)
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const replay = Session.create(SessionId('active-context-replay'), JSON.parse(JSON.stringify(events)) as SessionEvent[])
    expect(replay.surface.nodes).toEqual(agent.session.surface.nodes)
    expect(replay.deriveMessages()).toEqual(agent.session.deriveMessages())
    expect(ctx.tokenMeter.measure(replay).nodes).toEqual(ctx.tokenMeter.measure(agent.session).nodes)
  } finally {
    await ctx.fiber.dispose()
  }
})
