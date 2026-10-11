import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { call, facts, fixture, frame } from './guard-fixtures/fixture.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const create = async (options: Parameters<typeof fixture>[0] = {}) => {
  const value = await fixture({ cleanup: false, ...options }); contexts.push(value.ctx); return value
}
const notice = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

describe('successful compression tool-pair maintenance', () => {
  it('runs at the next pre-step, replaces exactly two Surface nodes, and replays with the same metering', async () => {
    const f = await create()
    const pair = await f.manual([{ type: 'reasoning', text: 'select old history' }, call()])
    const session = f.agent.session
    expect(f.state.hideCandidates.has(f.agent)).toBe(true)
    expect(session.surface.nodes).toEqual([pair.assistant.seq, pair.resultEvent.seq])
    const before = f.ctx.tokenMeter.measure(session).surfaceTokens
    const originalTokens = f.ctx.tokenMeter.estimateMessage(pair.assistant.data.message) + f.ctx.tokenMeter.estimateMessage(pair.resultEvent.data.message)
    await f.hide.cleanupBeforeNative(frame(f.agent))
    const events = session.snapshotEvents()
    const prune = events.at(-2)!
    const replacement = events.at(-1)!
    expect(prune.type).toBe('compaction/prune')
    if (prune.type !== 'compaction/prune' || replacement.type !== 'user/message') throw new Error('missing maintenance records')
    expect(prune.data).toEqual({ shadowedRange: { start: pair.assistant.seq, end: pair.resultEvent.seq }, shadowedSeqs: [pair.assistant.seq, pair.resultEvent.seq], shadowedTokenCount: originalTokens })
    expect(replacement.surfaceOp).toEqual({ op: 'replace', startSeq: pair.assistant.seq, endSeq: pair.resultEvent.seq })
    expect(replacement.sourceEventSeqs).toEqual([pair.assistant.seq, pair.toolCall.seq, pair.resultEvent.seq])
    expect(replacement.data).toMatchObject({ role: 'user', source: { kind: 'acp-maintenance', form: 'notice' } })
    expect(replacement.data.source.kind === 'acp-maintenance' && replacement.data.source.summary.length).toBeLessThanOrEqual(120)
    expect(Buffer.byteLength(JSON.stringify(replacement.data))).toBeLessThanOrEqual(f.config.confirmationMaxBytes)
    expect(f.ctx.tokenMeter.estimateMessage(replacement.data)).toBeLessThanOrEqual(f.config.confirmationMaxTokens)
    expect(session.surface.nodes).toEqual([replacement.seq])
    expect(f.state.hideCandidates.has(f.agent)).toBe(false)
    expect(f.ctx.tokenMeter.measure(session).surfaceTokens).toBe(before - originalTokens + f.ctx.tokenMeter.estimateMessage(replacement.data))
    const replay = Session.create(session.id, events)
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    expect(f.ctx.tokenMeter.measure(replay).surfaceTokens).toBe(f.ctx.tokenMeter.measure(session).surfaceTokens)
    await f.hide.cleanupBeforeNative(frame(f.agent))
    expect(session.snapshotEvents()).toHaveLength(events.length)
    expect(f.adapter.requests).toHaveLength(0)
    expect(events.some(event => event.type === 'assistant/message' && event.data.usage !== undefined)).toBe(false)
  })

  it('does not register pre-step itself; the owner can compose it before the next real request', async () => {
    const f = await create({ cleanup: true, replies: [[call()], [{ type: 'text', text: 'done' }]] })
    await f.run()
    expect(f.adapter.requests).toHaveLength(2)
    const next = f.adapter.requests[1]!
    expect(next.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('Context compression committed')))).toBe(true)
    expect(next.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call' && block.name === 'context_compress'))).toBe(false)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(1)
  })

  it('leaves a pair nonadjacent in Surface untouched', async () => {
    const f = await create({ body(exec) { exec.agent!.session.append('user/message', notice('intervening task'), { surfaceOp: 'append' }) } })
    const pair = await f.manual()
    expect(pair.result.isError).toBe(false)
    expect(f.state.hideCandidates.has(f.agent)).toBe(false)
    await f.hide.cleanupBeforeNative(frame(f.agent))
    expect(f.agent.session.surface.nodes).toContain(pair.assistant.seq)
    expect(f.agent.session.surface.nodes).toContain(pair.resultEvent.seq)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
  })

  it.each(['assistant', 'result'] as const)('does not clean up after the original %s node was replaced', async target => {
    const f = await create()
    const pair = await f.manual()
    const seq = target === 'assistant' ? pair.assistant.seq : pair.resultEvent.seq
    f.agent.session.append('user/message', notice('replacement already owns this node'), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    const nodes = [...f.agent.session.surface.nodes]
    await f.hide.cleanupBeforeNative(frame(f.agent))
    expect(f.agent.session.surface.nodes).toEqual(nodes)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
    expect(f.state.hideCandidates.has(f.agent)).toBe(false)
  })

  it('keeps partial results and assistant task text rather than creating cleanup candidates', async () => {
    const partial = await create({ body(exec, state) { state.facts.set(exec, facts('partial')) } })
    const pair = await partial.manual()
    expect(pair.result.isError).toBe(false)
    expect(partial.state.hideCandidates.has(partial.agent)).toBe(false)
    const text = await create()
    expect((await text.manual([{ type: 'text', text: 'task conclusion' }, call()])).result.isError).toBe(true)
    expect(text.state.hideCandidates.has(text.agent)).toBe(false)
  })

  it('drops the volatile candidate on cleanup cancellation and plugin disposal', async () => {
    const cancelled = await create()
    const pair = await cancelled.manual()
    const controller = new AbortController(); controller.abort()
    await cancelled.hide.cleanupBeforeNative(frame(cancelled.agent, controller.signal))
    await cancelled.hide.cleanupBeforeNative(frame(cancelled.agent))
    expect(cancelled.agent.session.surface.nodes).toEqual([pair.assistant.seq, pair.resultEvent.seq])
    expect(cancelled.state.hideCandidates.has(cancelled.agent)).toBe(false)
    const disposed = await create()
    await disposed.manual()
    expect(disposed.state.hideCandidates.has(disposed.agent)).toBe(true)
    await disposed.fiber.dispose()
    expect(disposed.state.hideCandidates.has(disposed.agent)).toBe(false)
  })

  it('leaves an orphan prune uncharged when the second append fails; replay retains the originals', async () => {
    const f = await create()
    const pair = await f.manual()
    const session = f.agent.session
    const before = f.ctx.tokenMeter.measure(session).surfaceTokens
    const original = session.append.bind(session)
    const spy = vi.spyOn(session, 'append').mockImplementation((type, data, ...opts) => {
      if (type === 'user/message') throw new Error('replacement append rejected')
      return Reflect.apply(original, session, [type, data, ...opts])
    })
    expect(() => f.hide.cleanupBeforeNative(frame(f.agent))).toThrow('replacement append rejected')
    spy.mockRestore()
    expect(session.snapshotEvents().at(-1)?.type).toBe('compaction/prune')
    expect(session.surface.nodes).toEqual([pair.assistant.seq, pair.resultEvent.seq])
    expect(f.ctx.tokenMeter.measure(session).surfaceTokens).toBe(before)
    const replay = Session.create(session.id, session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    expect(f.ctx.tokenMeter.measure(replay).surfaceTokens).toBe(before)
    session.append('user/message', notice('next ordinary task expires the orphan claim'), { surfaceOp: 'append' })
    expect(f.ctx.tokenMeter.measure(session).surfaceTokens).toBe(before + f.ctx.tokenMeter.estimateMessage(notice('next ordinary task expires the orphan claim')))
    await f.hide.cleanupBeforeNative(frame(f.agent))
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(1)
  })

  it('fails before either append if the complete confirmation cannot fit its budget', async () => {
    const f = await create({ config: { confirmationMaxBytes: 1 } })
    const pair = await f.manual()
    expect(() => f.hide.cleanupBeforeNative(frame(f.agent))).toThrow('confirmation budget')
    expect(f.agent.session.surface.nodes).toEqual([pair.assistant.seq, pair.resultEvent.seq])
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
  })
})
