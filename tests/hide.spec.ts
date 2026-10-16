import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
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
    const content = replacement.data.content.find(block => block.type === 'text')!
    if (content.type !== 'text') throw new Error('missing status text')
    const record = JSON.parse(content.text.slice(content.text.indexOf('{')))
    expect(record.status).toBe('compressed')
    expect(record.regions[0]).toMatchObject({ source_session_id: f.agent.id, source_start_seq: 1, source_end_seq: 1 })
    expect(record.regions[1]).toMatchObject({ source_session_id: f.agent.id, source_start_seq: 2, source_end_seq: 2 })
    expect(record).not.toHaveProperty('retry')
    expect(record).not.toHaveProperty('cleanup')
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

  it('cleans a confirmed partial result with complete ranges/status/errors but retains assistant task text', async () => {
    const partial = await create({ body(exec, state) { const value = facts('partial'); value.regions[1]!.error = 'Stopped before retry'; state.facts.set(exec, value) } })
    const pair = await partial.manual()
    expect(pair.result.isError).toBe(false)
    expect(partial.state.hideCandidates.has(partial.agent)).toBe(true)
    await partial.hide.cleanupBeforeNative(frame(partial.agent))
    const replacement = partial.agent.session.snapshotEvents().at(-1)!
    if (replacement.type !== 'user/message') throw new Error('missing partial status record')
    const block = replacement.data.content[0]!
    if (block.type !== 'text') throw new Error('missing partial status text')
    const record = JSON.parse(block.text.slice(block.text.indexOf('{')))
    expect(record.regions.map((region: { status: string }) => region.status)).toEqual(['committed', 'not_attempted'])
    expect(record.regions.map((region: { range: unknown }) => region.range)).toEqual(facts('partial').regions.map(region => region.range))
    expect(record.log).toEqual({ assistant_seq: pair.assistant.seq, tool_call_seq: pair.toolCall.seq, result_seq: pair.resultEvent.seq })
    expect(record.retry.instruction).toContain('only failed/not_attempted')
    expect(record.retry.regions).toEqual([1])
    expect(record.regions[1].error).toBe('Stopped before retry')
    expect(record.regions[0]).toMatchObject({ source_session_id: partial.agent.id, source_start_seq: 1, source_end_seq: 1 })
    expect(record.regions[1]).not.toHaveProperty('source_session_id')
    expect(record.regions[1]).not.toHaveProperty('source_start_seq')
    expect(record.regions[1]).not.toHaveProperty('source_end_seq')
    expect(record).not.toHaveProperty('summary')
    expect(partial.agent.session.eventAt(pair.assistant.seq)).toEqual(pair.assistant)
    expect(partial.agent.session.eventAt(pair.resultEvent.seq)).toEqual(pair.resultEvent)
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

  it('retains the original pair without either append when the complete confirmation cannot fit', async () => {
    const f = await create({ config: { confirmationMaxBytes: 1 } })
    const pair = await f.manual()
    expect(() => f.hide.cleanupBeforeNative(frame(f.agent))).not.toThrow()
    expect(f.agent.session.surface.nodes).toEqual([pair.assistant.seq, pair.resultEvent.seq])
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
  })
})

it('keeps complete long endpoints in the original pair when the status record exceeds a byte or token budget', async () => {
  for (const budget of [{ confirmationMaxBytes: 1000 }, { confirmationMaxTokens: 100 }]) {
    const endpoint = '长原文 '.repeat(1000)
    const f = await create({ config: budget, body(exec, state) {
      const value = facts()
      value.regions[0] = { ...value.regions[0]!, range: [{ text: endpoint, role: 'assistant' }, { text: endpoint }] }
      state.facts.set(exec, value)
    } })
    const originalCall = { ...call(), arguments: JSON.stringify({ regions: [{ range: [{ text: endpoint }, { text: endpoint }], summary: 'Do not repeat this authored summary.' }] }) }
    const pair = await f.manual([originalCall])
    await f.hide.cleanupBeforeNative(frame(f.agent))
    expect(f.agent.session.surface.nodes).toEqual([pair.assistant.seq, pair.resultEvent.seq])
    expect(f.agent.session.eventAt(pair.assistant.seq)).toEqual(pair.assistant)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
  }
})

it.each([false, true])('reports three pressure bands with pending reminder=%s', async pressurePending => {
  for (const mode of ['success', 'partial']) for (const band of ['low', 'middle', 'high']) {
    const resetBelowTokens = band === 'low' ? 10000 : 1
    const nudgeAtTokens = band === 'high' ? 2 : 11000
    const f = await create({ pressurePending,
      config: { pressureRoutes: [{ provider: 'guard-test', model: 'scripted', nudgeAtTokens, resetBelowTokens }] },
      body(exec, state) {
        if (mode === 'partial') {
          state.facts.set(exec, facts('partial'))
          throw new HarnessError('One region failed.', 'ACP_PARTIAL')
        }
      },
    })
    f.agent.session.append('request/header', { header: { config: { provider: 'guard-test', model: 'scripted' } }, reason: 'initial' })
    const pair = await f.manual()
    expect(pair.result.isError).toBe(mode === 'partial')
    await f.hide.cleanupBeforeNative(frame(f.agent))
    const records = f.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'acp-maintenance')
    expect(records).toHaveLength(1)
    const text = JSON.stringify(records[0])
    expect(text.includes('Compression target reached:')).toBe(pressurePending && band === 'low')
    expect(text.includes('No further pressure-driven compression is needed.')).toBe(band === 'low')
    expect(text.includes('no further pressure-driven compression is needed.')).toBe(!pressurePending && band === 'middle')
    expect(text.includes('Continue context_compress on other completed work until below R to rearm pressure reminders')).toBe(pressurePending && band !== 'low')
    expect(text.includes('Further pressure reduction is recommended:')).toBe(!pressurePending && band === 'high')
    expect(text.includes('No pressure reminder is awaiting reset;')).toBe(!pressurePending && band === 'middle')
    expect(text.includes('rearm pressure reminders')).toBe(pressurePending && band !== 'low')
    const total = f.ctx.tokenMeter.measure(f.agent.session).totalTokens
    expect(total < resetBelowTokens).toBe(band === 'low')
    expect(total >= nudgeAtTokens).toBe(band === 'high')
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'acp-pressure')).toBe(false)
    const replay = Session.create(f.agent.session.id, f.agent.session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(f.agent.session.deriveMessages())
    await f.hide.cleanupBeforeNative(frame(f.agent))
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'acp-maintenance')).toHaveLength(1)
  }
})

it('compares R with pressure after removing the full tool pair, including the short replacement', async () => {
  const header = { header: { config: { provider: 'guard-test', model: 'scripted' } }, reason: 'initial' as const }
  const blocks = [{ ...call(), arguments: JSON.stringify({ summary: 'Already committed summary. '.repeat(500) }) }]
  const baseline = await create()
  baseline.agent.session.append('request/header', header)
  await baseline.manual(blocks)
  await baseline.hide.cleanupBeforeNative(frame(baseline.agent))
  const shortTokens = baseline.ctx.tokenMeter.measure(baseline.agent.session).totalTokens
  for (const threshold of [shortTokens, shortTokens + 1, shortTokens + 1000]) {
    const f = await create({ pressurePending: true, config: { pressureRoutes: [{ provider: 'guard-test', model: 'scripted', nudgeAtTokens: threshold + 1000, resetBelowTokens: threshold }] } })
    f.agent.session.append('request/header', header)
    await f.manual(blocks)
    expect(f.ctx.tokenMeter.measure(f.agent.session).totalTokens).toBeGreaterThan(threshold)
    await f.hide.cleanupBeforeNative(frame(f.agent))
    const text = JSON.stringify(f.agent.session.deriveMessages())
    const reached = threshold === shortTokens + 1000
    expect(text.includes('Continue context_compress on other completed work until below R to rearm pressure reminders')).toBe(!reached)
    expect(text.includes('No further pressure-driven compression is needed.')).toBe(reached)
    expect(f.ctx.tokenMeter.measure(f.agent.session).totalTokens < threshold).toBe(reached)
  }
})

it('does not clean a batch containing an unconfirmed commit even alongside a confirmed one', async () => {
  const f = await create({ body(exec, state) {
    const value = facts('partial'); value.regions[1]!.status = 'unconfirmed'; state.facts.set(exec, value)
  } })
  const pair = await f.manual()
  expect(f.state.hideCandidates.has(f.agent)).toBe(false)
  await f.hide.cleanupBeforeNative(frame(f.agent))
  expect(f.agent.session.surface.nodes).toEqual([pair.assistant.seq, pair.resultEvent.seq])
})
