import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { configFor, largeTask, notices, reminderFixture, replaceHistory } from './reminder-fixtures/fixture.ts'

const textOf = (value: unknown) => JSON.stringify(value)

describe('pressure episode through production Loop, Session and token meter', () => {
  it('commits one notice across turns/routes, preserves decision metadata, rearms only below R and replays', async () => {
    const fixture = await reminderFixture(configFor({ pressureRoutes: [
      { provider: 'reminder', model: 'working', nudgeAtTokens: 1000, resetBelowTokens: 200 },
      { provider: 'reminder', model: 'alternate', nudgeAtTokens: 900, resetBelowTokens: 150 },
    ] }))
    const { ctx, agent, adapter, state } = fixture
    try {
      ctx.on('agent/pre-step', async (_frame, next) => {
        const decision = await next()
        return decision.kind === 'reject' ? decision : { ...decision, startsRequestSeries: true }
      })
      await fixture.run(largeTask)
      expect(notices(agent.session)).toHaveLength(0)
      expect(fixture.state.hooks!.hasPendingReminder(agent.session)).toBe(false)
      expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThan(1000)
      await fixture.run()
      expect(fixture.state.hooks!.hasPendingReminder(agent.session)).toBe(true)
      expect(state.candidate).toMatchObject({ kind: 'enter', startsRequestSeries: true })
      expect(notices(agent.session)).toHaveLength(1)
      const notice = notices(agent.session)[0]!.data
      expect(notice).toMatchObject({ role: 'user', source: { kind: 'acp-pressure', form: 'notice', summary: expect.any(String) } })
      expect(textOf(adapter.requests.at(-1)?.messages)).toContain('Host context maintenance notice')
      if (!('form' in notice.source) || notice.source.form !== 'notice') throw new Error('Missing notice summary')
      expect(notice.source.summary.length).toBeLessThanOrEqual(120)
      await fixture.run('The prior compression failed; continue anyway.')
      ctx.on('agent/request', async (_frame, next) => ({ ...await next(), model: 'alternate' }))
      await fixture.run('Switch route and continue.')
      await fixture.run('Still high; no repeated prompting.')
      expect(notices(agent.session)).toHaveLength(1)
      expect(adapter.summaryRequests).toHaveLength(0)

      replaceHistory(agent.session, 'Small checkpoint.')
      expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(150)
      await fixture.run('Short task.')
      expect(fixture.state.hooks!.hasPendingReminder(agent.session)).toBe(false)
      await fixture.run(largeTask)
      await fixture.run('High pressure again.')
      expect(notices(agent.session)).toHaveLength(2)
      const replay = Session.create(SessionId('reminder-replay'), JSON.parse(JSON.stringify(agent.session.snapshotEvents())) as SessionEvent[])
      expect(replay.deriveMessages()).toEqual(agent.session.deriveMessages())
      expect(ctx.tokenMeter.measure(replay).totalTokens).toBe(ctx.tokenMeter.measure(agent.session).totalTokens)
    } finally { await ctx.fiber.dispose() }
  })

  it('retains the opportunity when a candidate is rejected or cancelled before user/message commit', async () => {
    const fixture = await reminderFixture()
    const { ctx, agent, state, adapter } = fixture
    try {
      await fixture.run(largeTask)
      state.after = (_frame, decision) => {
        expect(decision.kind === 'enter' && decision.messages.some(message => message.source.kind === 'acp-pressure')).toBe(true)
        return { kind: 'reject' }
      }
      await fixture.run('Rejected candidate')
      expect(adapter.requests).toHaveLength(1)
      expect(fixture.state.hooks!.hasPendingReminder(agent.session)).toBe(false)
      expect(notices(agent.session)).toHaveLength(0)
      state.after = (frame, decision) => { frame.agent.cancel({ kind: 'user' }); return decision }
      await fixture.run('Cancelled candidate')
      expect(adapter.requests).toHaveLength(1)
      expect(fixture.state.hooks!.hasPendingReminder(agent.session)).toBe(false)
      expect(notices(agent.session)).toHaveLength(0)
      delete state.after
      await fixture.run('Try normally now')
      expect(notices(agent.session)).toHaveLength(1)
      await fixture.run('Already committed')
      expect(notices(agent.session)).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not consume a cancelled request preparation and commits the retry candidate only once', async () => {
    const fixture = await reminderFixture()
    const { ctx, agent, adapter } = fixture
    try {
      await fixture.run(largeTask)
      const disposeCancel = ctx.on('agent/request', async ({ agent: current }, next) => {
        current.cancel({ kind: 'user' })
        return next()
      }, { prepend: true })
      await fixture.run('Cancel after pre-step, before prepare commit')
      disposeCancel()
      expect(notices(agent.session)).toHaveLength(0)
      adapter.failNext = true
      ctx.on('agent/request-error', async (_frame, next) => await next() ?? { kind: 'retry' })
      await fixture.run('Retry a real request')
      expect(adapter.requests).toHaveLength(3)
      expect(notices(agent.session)).toHaveLength(1)
      const id = notices(agent.session)[0]!.data.id
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === id)).toHaveLength(1)
      expect(textOf(adapter.requests[1]!.messages)).toContain('Host context maintenance notice')
      expect(textOf(adapter.requests[2]!.messages)).toContain('Host context maintenance notice')
    } finally { await ctx.fiber.dispose() }
  })

  it('does not manufacture a request from an empty first step or an emptied offered continuation', async () => {
    const fixture = await reminderFixture()
    const { ctx, agent, adapter } = fixture
    try {
      await fixture.run(largeTask)
      let emptyFirst = true
      const remove = ctx.on('agent/pre-step', async (frame, next) => {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        if (emptyFirst || frame.step > 1) return { ...decision, messages: [] }
        return decision
      })
      await fixture.run('Removed waking input')
      expect(adapter.requests).toHaveLength(1)
      expect(fixture.state.hooks!.hasPendingReminder(agent.session)).toBe(false)
      expect(notices(agent.session)).toHaveLength(0)
      emptyFirst = false
      adapter.reply = () => {
        if (adapter.requests.length !== 2) throw new Error('Unexpected continuation request')
        agent.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: 'offered continuation' }], source: { kind: 'user' } }))
        return [{ type: 'text', text: 'Task finished; the offered continuation may be skipped.' }]
      }
      await fixture.run('Complete this task, then remove the offered continuation')
      expect(adapter.requests).toHaveLength(2)
      expect(notices(agent.session)).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(2)
      remove()
    } finally { await ctx.fiber.dispose() }
  })

  it('reloads from raw Log even when Surface has hidden the notice; low measurement rearms without scanning', async () => {
    const fixture = await reminderFixture()
    const { ctx, agent } = fixture
    try {
      await fixture.run(largeTask)
      await fixture.reload()
      await fixture.run('Reload high, no prior notice')
      expect(notices(agent.session)).toHaveLength(1)
      replaceHistory(agent.session, largeTask)
      expect(textOf(agent.session.deriveMessages())).not.toContain('Host context maintenance notice')
      await fixture.reload()
      expect(fixture.state.hooks!.hasPendingReminder(agent.session)).toBe(true)
      const reads = vi.spyOn(agent.session, 'eventAt')
      await fixture.run('Reload high, hidden original notice')
      expect(notices(agent.session)).toHaveLength(1)
      const cut = agent.session.seq
      // Basic itself inspects old lifecycle events; isolate reads after it returns.
      const hookReads: number[] = []
      fixture.state.afterNative = () => reads.mockClear()
      fixture.state.after = (_frame, decision) => {
        hookReads.push(...reads.mock.calls.map(([seq]) => seq))
        return decision
      }
      await fixture.run('Ordinary high-pressure step')
      expect(hookReads.every(seq => seq >= cut)).toBe(true)
      delete fixture.state.afterNative
      delete fixture.state.after
      reads.mockRestore()
      replaceHistory(agent.session, 'Low checkpoint')
      await fixture.reload()
      await fixture.run(largeTask)
      await fixture.run('New high episode after low reload')
      expect(notices(agent.session)).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })
})
