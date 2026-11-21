import { describe, expect, it } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createLoopFixture, HISTORY, runTurn, seedHistory } from './loop-fixtures/agent-loop.ts'

import { loadActiveContext } from './loop-fixtures/loader.ts'
import { selection } from './loop-fixtures/compression-input.ts'
import type { CompressInput } from '../src/types.ts'
describe('production Loop tool execution and Session replay', () => {
  it('executes tools, consumes their real results, then resumes from the same durable history', async () => {
    const writes: string[] = []
    const { ctx, adapter, agent } = await createLoopFixture([
      [{ type: 'text', text: 'Analysis A complete; alpha remains required.' }],
      [{ type: 'text', text: 'Middle constraint recorded.' }],
      [{ type: 'text', text: 'Analysis B complete; beta verification remains open.' }],
      request => {
        expect(JSON.stringify(request.messages)).toContain(HISTORY[1].text)
        return [{ type: 'tool-call', id: ToolCallId('verify-alpha'), name: 'acceptance_work', arguments: '{"value":"alpha verified"}' }]
      },
      request => {
        expect(JSON.stringify(request.messages)).toContain('WORK RESULT: alpha verified')
        return [{ type: 'tool-call', id: ToolCallId('verify-beta'), name: 'acceptance_work', arguments: '{"value":"beta verified"}' }]
      },
      request => {
        expect(JSON.stringify(request.messages)).toContain('WORK RESULT: beta verified')
        return [{ type: 'text', text: 'Both checks complete; public command unchanged.' }]
      },
    ])
    try {
      ctx.tools.register(defineContentToolFixture({
        name: 'acceptance_work', description: 'Deterministic external work fixture',
        parameters: { value: { type: 'string' } },
        async execute(args) {
          const value = args.value as string
          writes.push(value)
          return [{ type: 'text', text: 'WORK RESULT: ' + value }]
        },
      }))
      await seedHistory(agent)
      await runTurn(agent, 'Finish alpha and beta verification without changing the public command.')
      expect(writes).toEqual(['alpha verified', 'beta verified'])
      expect(adapter.requests).toHaveLength(6)
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'tool/result')).toHaveLength(2)
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })

      // Serialized producer output, not a hand-built expected Surface, is the replay input.
      const replay = Session.create(SessionId('acceptance-replay'), JSON.parse(JSON.stringify(events)) as SessionEvent[])
      expect(replay.surface.nodes).toEqual(agent.session.surface.nodes)
      expect(replay.deriveMessages()).toEqual(agent.session.deriveMessages())
      expect(replay.deriveMessages().at(-1)?.content).toEqual([
        { type: 'text', text: 'Both checks complete; public command unchanged.' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
it('rejects spans across instructions after a runtime-context injection, then replays native cleanup', async () => {
  const instruction = 'Live instruction: preserve the external API.'
  const runtime = 'Current runtime constraint: preserve the checked environment.'
  const crossed = ToolCallId('crossed-boundary')
  const accepted = ToolCallId('safe-region')
  let safe: CompressInput
  const compression = (id: ToolCallId, input: CompressInput) => [{
    type: 'tool-call' as const, id, name: 'context_compress', arguments: JSON.stringify(input),
  }]
  const f = await createLoopFixture([
    [{ type: 'text', text: 'Finished alpha work.' }],
    [{ type: 'text', text: 'Finished middle work.' }],
    [{ type: 'text', text: 'Finished beta work.' }],
    request => {
      expect(JSON.stringify(request.messages)).toContain(runtime)
      return compression(crossed, { regions: [{
        range: [safe.regions[0]!.range[0]!, safe.regions[1]!.range[1]!], summary: 'Must not replace instructions.',
      }] })
    },
    () => compression(accepted, { regions: [safe.regions[1]!] }),
    request => {
      const text = JSON.stringify(request.messages)
      expect(text).toContain(runtime)
      expect(text).toContain(instruction)
      expect(text).toContain(safe.regions[1]!.summary)
      return [{ type: 'text', text: 'Continued with both constraints.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
  })
  try {
    await runTurn(f.agent, HISTORY[0].text)
    const instructionNode = f.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: instruction }], source: { kind: 'user', form: 'instructions' },
    }), { surfaceOp: 'append' })
    f.ctx.systemPrompt.context({ name: 'replay-runtime', order: 10, required: true, text: runtime })
    for (const item of HISTORY.slice(1)) await runTurn(f.agent, item.text)
    safe = selection(f.agent.session)
    await runTurn(f.agent, 'Complete the replay without removing any instructions.')

    const events = f.agent.session.snapshotEvents()
    const rejected = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === crossed)
    expect(rejected).toMatchObject({ data: { error: { code: 'ACP_ALL_FAILED' }, message: { isError: true } } })
    expect(JSON.stringify(rejected)).toContain(instruction)
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === accepted)
    expect(result).toMatchObject({ data: { message: { isError: false } } })
    expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    const runtimeNode = events.find(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
    expect(runtimeNode?.seq).toBeGreaterThan(instructionNode.seq)
    expect(f.agent.session.surface.nodes).toContain(runtimeNode?.seq)
    expect(f.agent.session.surface.nodes).toContain(instructionNode.seq)
    expect(f.agent.session.surface.nodes).not.toContain(result?.seq)
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const replay = Session.create(SessionId('native-acp-replay'), structuredClone(events))
    expect(replay.surface.nodes).toEqual(f.agent.session.surface.nodes)
    expect(replay.deriveMessages()).toEqual(f.agent.session.deriveMessages())
  } finally { await f.ctx.fiber.dispose() }
})
