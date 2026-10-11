import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import type { CompressInput } from '../../src/types.ts'
import { loadActiveContext } from './composition.ts'
import { createLoopFixture, runTurn, seedHistory } from './fixtures.ts'
import { selection } from './compression-fixture.ts'

it.each(['partial-no-shrink', 'cancel-after-commit', 'post-policy-error'] as const)(
  'keeps real native commits and the original tool pair after %s', async mode => {
    let input: CompressInput | undefined
    const { ctx, agent, adapter } = await createLoopFixture([
      [{ type: 'text', text: 'Historical A completed.' }],
      [{ type: 'text', text: 'Middle retained.' }],
      [{ type: 'text', text: 'Historical B completed.' }],
      () => {
        if (input === undefined) throw new Error('Missing sampled compression input')
        return [{ type: 'tool-call', id: ToolCallId('compress-failure'), name: 'context_compress', arguments: JSON.stringify(input) }]
      },
      request => {
        expect(JSON.stringify(request.messages)).toContain('compress-failure')
        return [{ type: 'text', text: 'Committed facts acknowledged; select current text again before retrying.' }]
      },
    ], async context => {
      await context.plugin(TokenMeter)
      await context.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
      await loadActiveContext(context, { basic: { auto: false } })
    })
    try {
      await seedHistory(agent)
      input = selection(agent.session)
      if (mode === 'partial-no-shrink') input = { ...input, regions: input.regions.map((region, index) => index === 0
        ? { ...region, summary: 'Verbose summary fails the native shrink check. '.repeat(160) } : region) }
      let stimulated = false
      ctx.on('session/event', (session, event) => {
        if (session !== agent.session || event.type !== 'compaction/end' || stimulated || mode !== 'cancel-after-commit') return
        stimulated = true
        agent.cancel({ kind: 'user' })
      })
      if (mode === 'post-policy-error') ctx.on('tools/post-execute', async (exec, _result, next) => {
        if (exec.name !== 'context_compress') return next()
        return { kind: 'block', feedback: [{ type: 'text', text: 'INDEPENDENT POST POLICY DETAIL: verification denied after real commits.' }] }
      })
      await runTurn(agent, 'Compress the old analyses, then continue without discarding partial diagnostics.')
      const events = agent.session.snapshotEvents()
      const native = events.filter(event => event.type === 'compaction/summary')
      expect(native).toHaveLength(mode === 'post-policy-error' ? 2 : 1)
      expect(JSON.stringify(agent.session.eventAt(native[0]!.data.shadowedSeqs[0]!))).toContain('Completed analysis B:')
      const author = events.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call' && block.id === 'compress-failure'))
      const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'compress-failure')
      if (author === undefined || result?.type !== 'tool/result') throw new Error('Original author/result diagnostic pair missing')
      expect(agent.session.surface.nodes).toContain(author.seq)
      expect(agent.session.surface.nodes).toContain(result.seq)
      expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'acp-maintenance')).toBe(false)
      const content = result.data.message.content.find(block => block.type === 'text')
      if (content?.type !== 'text') throw new Error('Final committed-facts content missing')
      const facts = JSON.parse(content.text)
      expect(facts.regions).toHaveLength(2)
      expect(facts.regions[1].compaction_id).toBeDefined()
      expect(facts.regions[1].replacement_seq).toBeDefined()
      expect(facts.cleanup).toBe(mode === 'partial-no-shrink' ? 'not_eligible' : 'retained')
      if (mode === 'post-policy-error') {
        expect(result.data.message.isError).toBe(true)
        expect(facts.status).toBe('batch_success')
        expect(facts.regions.every((region: { status: string }) => region.status === 'committed')).toBe(true)
        expect(content.text).toContain('INDEPENDENT POST POLICY DETAIL')
        expect(adapter.requests).toHaveLength(5)
      } else if (mode === 'cancel-after-commit') {
        expect(result.data.message.isError).toBe(true)
        expect(result.data.error?.code).toBe('ABORTED')
        expect(content.text).toContain('ABORTED')
        expect(facts.status).toBe('partial')
        expect(facts.regions[0].status).toBe('failed')
        expect(adapter.requests).toHaveLength(4)
      } else {
        expect(facts.status).toBe('partial')
        expect(facts.regions[0].status).toBe('failed')
        expect(facts.execution_order).toEqual([1, 0])
        expect(adapter.requests).toHaveLength(5)
      }
      const replay = Session.create(SessionId('failure-replay'), JSON.parse(JSON.stringify(events)) as SessionEvent[])
      expect(replay.surface.nodes).toEqual(agent.session.surface.nodes)
      expect(replay.deriveMessages()).toEqual(agent.session.deriveMessages())
      expect(ctx.tokenMeter.measure(replay).nodes).toEqual(ctx.tokenMeter.measure(agent.session).nodes)
    } finally {
      await ctx.fiber.dispose()
    }
  },
)
