import { describe, expect, it, vi } from 'vitest'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createUserMessage, ToolCallId, LlmError, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { configFor, largeTask, notices, reminderFixture, replaceHistory } from './reminder-fixtures/fixture.ts'

const body = (message: { content: readonly { type: string; text?: string }[] }) => message.content.map(block => block.text ?? '').join('\n')

describe('post-native thresholds and complete pressure notice budgets', () => {
  it('maps the protected latest task carried by a real native overflow checkpoint', async () => {
    const route = { provider: 'reminder', model: 'working', nudgeAtTokens: 5000, resetBelowTokens: 100 }
    const fixture = await reminderFixture(configFor({ pressureRoutes: [route] }))
    const { ctx, agent, adapter } = fixture
    try {
      adapter.summary = 'TASK-CARRIER retained latest task and constraints. '.repeat(60)
      ctx.tools.register(defineContentToolFixture({ name: 'after_overflow', description: 'Continue after native overflow recovery', parameters: {},
        async execute() { return [{ type: 'text', text: 'Recovered work result.' }] },
      }))
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'compaction/end') route.nudgeAtTokens = 250
      })
      adapter.reply = () => {
        if (adapter.requests.length === 2) throw new LlmError('Overflow fixture', CONTEXT_WINDOW_EXCEEDED_CODE)
        if (adapter.requests.length === 1 || adapter.requests.length === 3) return [{ type: 'tool-call', id: ToolCallId('after-overflow-' + adapter.requests.length), name: 'after_overflow', arguments: '{}' }]
        if (adapter.requests.length === 4) return [{ type: 'text', text: 'Recovered task complete.' }]
        throw new Error('Unexpected model request')
      }
      await fixture.run(largeTask)
      expect(adapter.requests, JSON.stringify(agent.session.snapshotEvents().at(-1))).toHaveLength(4)
      expect(adapter.summaryRequests).toHaveLength(1)
      const originalTask = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'user')!
      expect(agent.session.surface.nodes).not.toContain(originalTask.seq)
      const carrier = agent.session.snapshotEvents().find(event => event.type === 'user/message'
        && event.data.source.kind === 'compact-checkpoint' && event.sourceEventSeqs?.includes(originalTask.seq))!
      expect(agent.session.surface.nodes).toContain(carrier.seq)
      expect(notices(agent.session)).toHaveLength(1)
      expect(body(notices(agent.session)[0]!.data)).toContain('latest_task_checkpoint')
      expect(body(notices(agent.session)[0]!.data)).toContain('TASK-CARRIER retained latest task')
      expect(body(notices(agent.session)[0]!.data)).toContain('All current Surface protection groups listed.')
    } finally { await ctx.fiber.dispose() }
  })

  it('triggers at exact S, does not rearm at exact R, and rearms strictly below R using real measurements', async () => {
    const route = { provider: 'reminder', model: 'working', nudgeAtTokens: 1000, resetBelowTokens: 200 }
    const fixture = await reminderFixture(configFor({ pressureRoutes: [route] }))
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
    const fixture = await reminderFixture(configFor())
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

  it('emits the complete English notice and summary within the full Message budgets', async () => {
    const config = configFor({ reminderMaxTokens: 1200, reminderMaxBytes: 6000, maxRegions: 3 })
    const fixture = await reminderFixture(config)
    try {
      await fixture.run(largeTask)
      const measurement = fixture.ctx.tokenMeter.measure(fixture.agent.session)
      await fixture.run('Continue after completed work.')
      const message = notices(fixture.agent.session)[0]!.data
      expect(body(message)).toBe(
        'Host context maintenance notice: context pressure is high.\n'
        + `T≈${measurement.totalTokens} tokens; native automatic compaction threshold H=80000.\n`
        + 'Use context_compress to summarize completed work that no longer needs verbatim history. '
        + 'Prefer a complete multi-message work phase over isolated reports. '
        + 'Select 1–3 non-overlapping regions using distinctive literal text endpoints; read back history if needed. '
        + 'Every range must stay in one section between protected boundaries; any finer range within that section is allowed. '
        + 'The map does not prescribe compression ranges. B labels and protected clues identify boundaries, not selectable endpoints; choose actual text + optional role from messages inside a section. '
        + 'Tool-span completion can reach protection and reject a range; this current map does not replace validation. '
        + 'New input/current entering Step is not in this pre-step Surface map and cannot be selected. Current executing Step is always a hard rejection. '
        + 'Submit one standalone native call, or one PTC run_code with code exactly return await tools.context_compress(<JSON literal>);. No other statements, task prose or tools.\n'
        + 'Protected boundaries in Surface order (consecutive same-class nodes grouped):\n'
        + 'B1 instructions (1 node): system "You are an AI agent powered by DeepSeek Harness."\n'
        + 'B2 latest_task_input (1 node): user "Historical completed work; preserve alpha. detai"\n'
        + 'All current Surface protection groups listed.',
      )
      expect(message.source).toMatchObject({ summary: 'High context pressure; summarize completed history.' })
      expect(fixture.ctx.tokenMeter.estimateMessage(message)).toBeLessThanOrEqual(config.reminderMaxTokens)
      expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThanOrEqual(config.reminderMaxBytes)
    } finally { await fixture.ctx.fiber.dispose() }
  })

  it.each([
    { reminderMaxTokens: 1, reminderMaxBytes: 6000 },
    { reminderMaxTokens: 1200, reminderMaxBytes: 1 },
  ])('rejects the full notice at generation, without consuming the episode: %j', async budget => {
    const config = { ...configFor(), ...budget }
    // Installation must not simulate unknown runtime values to enforce a short minimum.
    const fixture = await reminderFixture(config)
    try {
      await fixture.run(largeTask)
      await fixture.run('Trigger a notice with too little room.')
      const end = fixture.agent.session.snapshotEvents().at(-1)
      expect(end).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: expect.stringMatching(
        new RegExp('required estimated tokens=\\d+, actual UTF-8 bytes=\\d+; '
          + `configured reminderMaxTokens=${budget.reminderMaxTokens}, reminderMaxBytes=${budget.reminderMaxBytes}\\. `
          + 'Increase reminderMaxTokens/reminderMaxBytes'),
      ) } } } })
      expect(notices(fixture.agent.session)).toHaveLength(0)
      config.reminderMaxTokens = 1200
      config.reminderMaxBytes = 6000
      await fixture.run('Retry with room for the complete notice.')
      expect(notices(fixture.agent.session)).toHaveLength(1)
      await fixture.run('Already committed; do not repeat.')
      expect(notices(fixture.agent.session)).toHaveLength(1)
    } finally { await fixture.ctx.fiber.dispose() }
  })

  it('offers action advice and only bounded protected clues in a long Turn', async () => {
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
      expect(body(message)).toContain('distinctive literal text endpoints')
      expect(body(message)).toContain('context_compress')
      expect(body(message)).not.toContain('Completed old analysis')
      expect(body(message)).toContain('LIVE INSTRUCTIONS')
      expect(body(message)).toContain('Historical completed work')
      expect(body(message)).not.toContain(largeTask)
      expect(body(message)).toContain('B1 instructions (2 nodes)')
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps native prune → remeasure → ordinary summary active after a committed reminder is ignored', async () => {
    const fixture = await reminderFixture(configFor())
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
