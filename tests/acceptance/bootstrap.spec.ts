import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { createLoopFixture, HISTORY, runTurn, seedHistory } from './fixtures.ts'

// This validates the integration substrate, not ACP behavior or real-model task quality.
describe('shared acceptance substrate: production Loop and Session replay', () => {
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
