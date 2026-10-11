import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { buildContextMap } from '../../../dsh-session-tools/src/context-map.ts'
import { loadActiveContext } from './composition.ts'
import type { CompressInput } from '../../src/types.ts'
import { createLoopFixture, HISTORY, runTurn, seedHistory } from './fixtures.ts'

import { mapOptions, selection, summaries } from './compression-fixture.ts'

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
    const map = await ctx.sessionQuery.captureSession(agent.id, (reader, observation) => buildContextMap(
      reader, observation, ctx.tokenMeter.measure(reader as Session), { view: 'messages', limit: 100 }, mapOptions,
    ), { projectionMode: 'all' })
    input = selection(map)
    await runTurn(agent, 'Complete alpha and beta verification using the preserved constraints.')
    expect(adapter.requests).toHaveLength(6)
    expect(work).toEqual(['alpha and beta verified'])
    const events = agent.session.snapshotEvents()
    const native = events.filter(event => event.type === 'compaction/summary')
    expect(native).toHaveLength(2)
    expect(native.map(event => event.data.shadowedSeqs[0])).toEqual([input.regions[1]!.start.seq, input.regions[0]!.start.seq])
    expect(native.every(event => event.data.provider === 'acceptance' && event.data.model === 'scripted')).toBe(true)
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'compress-two')
    if (result?.type !== 'tool/result') throw new Error('Final durable compression result missing')
    expect(result.data.message.isError).not.toBe(true)
    const text = result.data.message.content.find(block => block.type === 'text')
    if (text?.type !== 'text') throw new Error('Final compression content missing')
    const facts = JSON.parse(text.text)
    expect(facts.status).toBe('batch_success')
    expect(facts.execution_order).toEqual(['older-b', 'older-a'])
    expect(facts.regions.map((region: { id: string }) => region.id)).toEqual(['older-a', 'older-b'])
    expect(facts.regions.every((region: { route_token_reduction?: number }) => typeof region.route_token_reduction === 'number' && region.route_token_reduction > 0)).toBe(true)
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
