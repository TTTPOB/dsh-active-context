import { describe, expect, it, vi } from 'vitest'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { configFor, largeTask, notices, reminderFixture, replaceHistory } from './reminder-fixtures/fixture.ts'

const body = (message: { content: readonly { type: string; text?: string }[] }) => message.content.map(block => block.text ?? '').join('\n')

describe('post-native thresholds and complete pressure notice budgets', () => {
  it('triggers at exact S, does not rearm at exact R, and rearms strictly below R using real measurements', async () => {
    const route = { provider: 'reminder', model: 'working', nudgeAtTokens: 1000, resetBelowTokens: 200 }
    const fixture = await reminderFixture(configFor({ pressureRoutes: [route], reminderMaxRegions: 0 }))
    const { ctx, agent } = fixture
    try {
      await fixture.run(largeTask)
      route.nudgeAtTokens = ctx.tokenMeter.measure(agent.session).totalTokens + 1
      await fixture.run('Below S')
      expect(notices(agent.session)).toHaveLength(0)
      route.nudgeAtTokens = ctx.tokenMeter.measure(agent.session).totalTokens
      await fixture.run('Exactly S')
      expect(notices(agent.session)).toHaveLength(1)
      replaceHistory(agent.session, 'Small checkpoint')
      route.resetBelowTokens = ctx.tokenMeter.measure(agent.session).totalTokens
      await fixture.run('Exactly R does not rearm')
      await fixture.run(largeTask)
      await fixture.run('High again but still same episode')
      expect(notices(agent.session)).toHaveLength(1)
      replaceHistory(agent.session, 'Small checkpoint')
      route.resetBelowTokens = ctx.tokenMeter.measure(agent.session).totalTokens + 1
      await fixture.run('Strictly below R')
      await fixture.run(largeTask)
      await fixture.run('Next high episode')
      expect(notices(agent.session)).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('rechecks actual pruned tool results before notifying and avoids an unnecessary summary request', async () => {
    const fixture = await reminderFixture(configFor({ reminderMaxRegions: 0 }))
    const { ctx, adapter, agent } = fixture
    try {
      adapter.capacity = 4000
      await ctx.plugin(ToolResultPruner, { thresholdChars: 300, headChars: 60, tailChars: 40 })
      ctx.tools.register(defineContentToolFixture({ name: 'huge_result', description: 'Large external fixture result', parameters: {},
        async execute() { return [{ type: 'text', text: 'temporary tool payload '.repeat(1200) }] },
      }))
      adapter.reply = () => {
        if (adapter.requests.length > 2) throw new Error('Unexpected model request')
        return adapter.requests.length === 1
          ? [{ type: 'tool-call', id: ToolCallId('large-result'), name: 'huge_result', arguments: '{}' }]
          : [{ type: 'text', text: 'Continue from pruned results.' }]
      }
      await fixture.run(largeTask)
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.summaryRequests).toHaveLength(0)
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(true)
      expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(3200)
      expect(notices(agent.session)).toHaveLength(1)
      expect(body(notices(agent.session)[0]!.data)).toContain('H=3200')
    } finally { await ctx.fiber.dispose() }
  })
  it('leaves [] and unlisted routes disabled, and diagnoses unknown capacity once without blocking normal requests', async () => {
    for (const pressureRoutes of [[], [{ provider: 'other', model: 'working', nudgeAtTokens: 1000, resetBelowTokens: 200 }]]) {
      const fixture = await reminderFixture(configFor({ pressureRoutes }))
      try {
        await fixture.run(largeTask)
        await fixture.run()
        expect(notices(fixture.agent.session)).toHaveLength(0)
        expect(fixture.adapter.requests).toHaveLength(2)
      } finally { await fixture.ctx.fiber.dispose() }
    }
    const fixture = await reminderFixture()
    const warn = vi.spyOn(fixture.ctx.logger, 'warn')
    try {
      fixture.adapter.capacity = undefined
      await fixture.run(largeTask)
      await fixture.run()
      await fixture.run()
      expect(notices(fixture.agent.session)).toHaveLength(0)
      expect(fixture.adapter.requests).toHaveLength(3)
      expect(warn.mock.calls.filter(([text]) => String(text).startsWith('ACP pressure reminder'))).toHaveLength(1)
    } finally { warn.mockRestore(); await fixture.ctx.fiber.dispose() }
  })

  it('uses adapter output reservation unless request maxTokens wins, and resolves exact Basic model overrides', async () => {
    for (const explicit of [false, true]) {
      const fixture = await reminderFixture(configFor(), {
        modelPolicies: [{ provider: 'reminder', model: 'working', thresholdRatio: 0.7, headroomTokens: 2000 }],
      })
      const warn = vi.spyOn(fixture.ctx.logger, 'warn')
      try {
        fixture.adapter.capacity = 10_000
        fixture.adapter.defaultMaxTokens = 7500
        if (explicit) fixture.ctx.on('agent/request', async (_frame, next) => ({ ...await next(), maxTokens: 100 }))
        await fixture.run(largeTask)
        await fixture.run()
        const committed = notices(fixture.agent.session)
        if (explicit) {
          expect(committed).toHaveLength(1)
          expect(body(committed[0]!.data)).toContain('H=7000')
        } else {
          expect(committed).toHaveLength(0)
          expect(warn.mock.calls.some(([text]) => String(text).includes('H=500 (C=10000, O=7500)'))).toBe(true)
        }
        expect(fixture.adapter.requests).toHaveLength(2)
      } finally { warn.mockRestore(); await fixture.ctx.fiber.dispose() }
    }
  })

  it('bounds the complete user Message including framing, metadata and multibyte previews, then falls back to short notice', async () => {
    for (const budget of [{ reminderMaxTokens: 1200, reminderMaxBytes: 6000 }, { reminderMaxTokens: 60, reminderMaxBytes: 500 }]) {
      const config = configFor({ ...budget, reminderPreviewChars: 10_000 })
      const fixture = await reminderFixture(config)
      try {
        fixture.adapter.reply = () => [{ type: 'text', text: '旧结论😀'.repeat(600) }]
        await fixture.run(largeTask)
        await fixture.run('Continue after a large multibyte conclusion.')
        const message = notices(fixture.agent.session)[0]!.data
        expect(fixture.ctx.tokenMeter.estimateMessage(message)).toBeLessThanOrEqual(config.reminderMaxTokens)
        expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThanOrEqual(config.reminderMaxBytes)
        expect(body(message)).toContain('宿主上下文维护提醒')
        expect(body(message)).toContain('estimated')
        if (budget.reminderMaxBytes === 500) expect(body(message)).not.toContain('snapshot_ref')
        else expect(body(message)).toContain('snapshot_ref')
      } finally { await fixture.ctx.fiber.dispose() }
    }
  })

  it('offers completed old messages after the latest task in a long Turn, without suggesting task or instructions', async () => {
    const fixture = await reminderFixture(configFor({ pressureRoutes: [
      { provider: 'reminder', model: 'working', nudgeAtTokens: 1800, resetBelowTokens: 200 },
    ] }))
    const { ctx, adapter, agent } = fixture
    try {
      adapter.reply = () => {
        if (adapter.requests.length > 2) throw new Error('Unexpected model request')
        if (adapter.requests.length === 1) {
          agent.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: 'Continue the same task.' }], source: { kind: 'user' } }))
          return [{ type: 'text', text: 'Completed old analysis '.repeat(300) }]
        }
        return [{ type: 'text', text: 'Long Turn finished.' }]
      }
      // A standalone completion before the task remains protected as instructions.
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'LIVE INSTRUCTIONS' }],
        source: { kind: 'acp-pressure', form: 'instructions' } }), { surfaceOp: 'append' })
      await fixture.run(largeTask)
      expect(adapter.requests).toHaveLength(2)
      expect(notices(agent.session)).toHaveLength(1)
      const message = notices(agent.session)[0]!.data
      expect(body(message)).toContain('snapshot_ref')
      expect(body(message)).toContain('Completed old analysis')
      expect(body(message)).toContain('session_event_read')
      expect(body(message)).toContain('session_context_map')
      expect(body(message)).not.toContain('LIVE INSTRUCTIONS')
      expect(body(message)).not.toContain('Historical completed work')
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps native prune → remeasure → ordinary summary active after a committed reminder is ignored', async () => {
    const fixture = await reminderFixture(configFor({ reminderMaxRegions: 0 }))
    const { ctx, adapter, agent } = fixture
    const trace: string[] = []
    try {
      adapter.capacity = 4000
      await ctx.plugin(ToolResultPruner, { thresholdChars: 300, headChars: 60, tailChars: 40 })
      const prune = ctx.toolResultPruner.pruneSession.bind(ctx.toolResultPruner)
      vi.spyOn(ctx.toolResultPruner, 'pruneSession').mockImplementation(session => {
        trace.push('prune-pass')
        return prune(session)
      })
      fixture.state.before = () => { trace.push('cleanup') }
      fixture.state.afterNative = () => { trace.push('post-native:' + ctx.tokenMeter.measure(agent.session).totalTokens) }
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'compaction/prune' || event.type === 'compaction/start' || event.type === 'compaction/end') trace.push(event.type)
      })
      await fixture.run(largeTask)
      await fixture.run('Ignore the pressure notice; continue working.')
      expect(notices(agent.session)).toHaveLength(1)
      await fixture.run(largeTask.repeat(4))
      await fixture.run('Trigger the next normal request after the pressure jump.')
      expect(adapter.summaryRequests.length).toBeGreaterThan(0)
      expect(adapter.requests).toHaveLength(4)
      const start = trace.indexOf('compaction/start')
      const end = trace.indexOf('compaction/end')
      expect(start).toBeGreaterThan(trace.lastIndexOf('cleanup', start))
      expect(trace.lastIndexOf('prune-pass', start)).toBeGreaterThan(trace.lastIndexOf('cleanup', start))
      expect(end).toBeGreaterThan(start)
      expect(trace.slice(end + 1).some(value => value.startsWith('post-native:'))).toBe(true)
      expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && typeof event.surfaceOp === 'object')).toBe(true)
      expect(notices(agent.session)).toHaveLength(1)
      // Native retention keeps the giant recent task; a still-high episode must not nudge again.
      expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThan(3200)
      await fixture.run('Still high after native replacement; continue without another notice.')
      expect(notices(agent.session)).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })
})
