import { afterEach, describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { call, facts, fixture } from './guard-fixtures/fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const create = async (options: Parameters<typeof fixture>[0] = {}) => {
  const value = await fixture(options); contexts.push(value.ctx); return value
}
const results = (f: Awaited<ReturnType<typeof fixture>>) => f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')

describe('independent compression admission', () => {
  for (const mode of ['native', 'both'] as const) it(`accepts one ${mode} call and records the appended author route`, async () => {
    const f = await create({ mode, cleanup: false })
    const pair = await f.manual([{ type: 'reasoning', text: 'select old context' }, call()])
    expect(pair.result.isError).toBe(false)
    expect(f.executions).toHaveLength(1)
    expect(f.state.identities.get(f.executions[0]!)).toBeUndefined()
    expect(JSON.parse(pair.result.content[0]!.type === 'text' ? pair.result.content[0]!.text : '')).toMatchObject({ status: 'compressed', execution_order: [1, 0] })
    expect(JSON.parse(pair.result.content[0]!.type === 'text' ? pair.result.content[0]!.text : '')).not.toHaveProperty('retry')
    // Inspect the captured identity while the real body runs, not a made-up provider default.
    let route: unknown
    const second = await create({ body(exec, state) { route = state.identities.get(exec) }, cleanup: false })
    await second.manual()
    expect(route).toMatchObject({ provider: 'real-author', model: 'real-model', assistantSeq: 2 })
  })

  it.each([
    ['mixed siblings', [call(), call('ordinary-1', 'ordinary')]],
    ['two compressions', [call(), call('compress-2')]],
    ['repeated call id', [call(), call()]],
    ['task text', [{ type: 'text' as const, text: 'important task answer' }, call()]],
  ])('rejects %s before the body and leaves ordinary siblings scheduled', async (_label, blocks) => {
    const f = await create({ replies: [blocks, [{ type: 'text', text: 'done' }]] })
    await f.run()
    expect(f.executions).toHaveLength(0)
    const compressed = results(f).filter(event => event.data.message.toolCallId === ToolCallId('compress-1'))
    expect(compressed.length).toBeGreaterThan(0)
    expect(compressed.every(event => event.data.message.isError)).toBe(true)
    expect(f.siblingRuns()).toBe(blocks.some(block => block.type === 'tool-call' && block.name === 'ordinary') ? 1 : 0)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
  })

  it('rejects absent, interrupted, replacement, and closed-step authors', async () => {
    const f = await create({ cleanup: false })
    const invoke = () => f.ctx.tools.execute({ callId: call().id, name: 'context_compress', arguments: {}, agent: f.agent, signal: new AbortController().signal })
    expect((await invoke()).isError).toBe(true)
    expect((await f.manual([call()], true)).result.isError).toBe(true)
    expect((await invoke()).isError).toBe(true)
    f.agent.session.append('step/start', { turn: 1, step: 2 })
    const author = f.agent.session.append('assistant/message', {
      turn: 1, step: 2, stream: [], message: createAssistantMessage({ content: [call()], source: { provider: 'p', model: 'm' } }),
    }, { surfaceOp: 'append' })
    f.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'already replaced author' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: author.seq, endSeq: author.seq }, sourceEventSeqs: [author.seq] })
    expect((await invoke()).isError).toBe(true)
    expect(f.executions).toHaveLength(0)
  })

  it('rejects a transport child even when its call id names the current assistant call', async () => {
    const f = await create({ replies: [[call('outer-1', 'outer')], [{ type: 'text', text: 'done' }]] })
    let nestedError = false
    f.ctx.tools.register({
      name: 'outer', description: 'nested transport fixture', parameters: {},
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'transport completed' }] },
      async execute(_args, exec) {
        const result = await f.ctx.tools.execute({ callId: exec.callId, rootCallId: exec.rootCallId, parent: exec.token, name: 'context_compress', arguments: {}, agent: f.agent, signal: exec.signal })
        nestedError = result.isError
        return true
      },
    })
    await f.run()
    expect(nestedError).toBe(true)
    expect(f.executions).toHaveLength(0)
  })

  it('unregisters the guard and clears author identities on effect disposal', async () => {
    const f = await create({ cleanup: false })
    f.agent.session.append('step/start', { turn: 1, step: 1 })
    f.agent.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [call()], source: { provider: 'p', model: 'm' } }) }, { surfaceOp: 'append' })
    await f.ctx.tools.execute({ callId: call().id, name: 'context_compress', arguments: {}, agent: f.agent, signal: new AbortController().signal })
    const execution = f.executions[0]!
    expect(f.state.identities.has(execution)).toBe(true)
    await f.fiber.dispose()
    expect(f.state.identities.has(execution)).toBe(false)
    let runs = 0
    f.ctx.tools.register({ name: 'context_compress', description: 'unguarded', parameters: {}, output: { schema: { type: 'number' }, render: () => [] }, async execute() { runs += 1; return 1 } })
    const result = await f.ctx.tools.execute({ callId: ToolCallId('no-author'), name: 'context_compress', arguments: {}, agent: f.agent, signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(runs).toBe(1)
  })
})

describe('last-mile committed-fact diagnostics', () => {
  it('keeps ABORTED after a successful body is cancelled', async () => {
    const f = await create({ replies: [[call()]], body(exec) { exec.agent!.cancel({ kind: 'user' }) } })
    await f.run()
    const result = results(f)[0]!
    expect(result.data.message.isError).toBe(true)
    expect(result.data.error?.code).toBe('ABORTED')
    const content = result.data.message.content[0]!
    expect(content.type).toBe('text')
    // Cancellation cannot render as complete success; all committed evidence remains.
    expect(JSON.parse(content.type === 'text' ? content.text : '')).toMatchObject({ status: 'partial', call_error: 'aborted', final_error: { code: 'ABORTED' }, regions: [expect.objectContaining({ status: 'committed', readback: expect.objectContaining({ start_seq: 1 }) }), expect.objectContaining({ status: 'committed', readback: expect.objectContaining({ start_seq: 2 }) })] })
    expect(f.state.hideCandidates.has(f.agent)).toBe(false)
  })

  it('keeps post-policy errors and committed facts when the body succeeded', async () => {
    const f = await create({ replies: [[call()], [{ type: 'text', text: 'done' }]] })
    f.ctx.on('tools/post-execute', async (_exec, _result, _next) => ({ kind: 'block', feedback: [{ type: 'text', text: 'post policy rejected' }, { type: 'text', text: 'specific corrective detail from post hook' }] }))
    await f.run()
    const result = results(f)[0]!
    expect(result.data.message.isError).toBe(true)
    const facts = JSON.parse(result.data.message.content[0]!.type === 'text' ? result.data.message.content[0]!.text : '')
    // Preserve every commit while reporting the policy failure.
    expect(facts).toMatchObject({ status: 'partial', call_error: 'error', regions: [expect.objectContaining({ status: 'committed', readback: expect.objectContaining({ start_seq: 1 }) }), expect.objectContaining({ status: 'committed', readback: expect.objectContaining({ start_seq: 2 }) })] })
    const block = result.data.message.content[0]!
    expect(JSON.parse(block.type === 'text' ? block.text : '').final_error.content).toContain('specific corrective detail from post hook')
    expect(f.state.hideCandidates.has(f.agent)).toBe(false)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/prune')).toBe(false)
  })

  it('keeps committed facts when an around-dispatch failure bypasses post-execute', async () => {
    const f = await create()
    let postCalls = 0
    f.ctx.on('tools/execute', async (_exec, next) => {
      await next()
      throw new Error('around-dispatch close failed')
    })
    f.ctx.on('tools/post-execute', async (_exec, _result, next) => { postCalls += 1; return next() })
    const pair = await f.manual()
    expect(pair.result.isError).toBe(true)
    const block = pair.result.content[0]!
    expect(JSON.parse(block.type === 'text' ? block.text : '')).toMatchObject({
      status: 'partial', call_error: 'error', final_error: { message: 'around-dispatch close failed' },
      regions: [expect.objectContaining({ status: 'committed', readback: expect.objectContaining({ start_seq: 1 }) }), expect.objectContaining({ status: 'committed', readback: expect.objectContaining({ start_seq: 2 }) })],
    })
    expect(postCalls).toBe(0)
    expect(f.state.hideCandidates.has(f.agent)).toBe(false)
  })

  it('diagnoses actual partial commits when the body throws after a replacement', async () => {
    const f = await create({ body(exec, state) { const value = facts('partial'); value.regions[0]!.status = 'committed_with_error'; value.stopReason = 'native close failed'; state.facts.set(exec, value); throw new Error('native close failed') }, cleanup: false })
    const pair = await f.manual()
    expect(pair.result.isError).toBe(true)
    expect(pair.result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('committed_with_error') })])
    expect(f.state.hideCandidates.has(f.agent)).toBe(false)
  })

  it('bounds verbose UTF-8 errors while preserving every committed region', async () => {
    const f = await create({ config: { resultMaxBytes: 2048 }, body(exec, state) { const value = facts('partial'); value.stopReason = '长错误'.repeat(500); value.regions[0]!.error = value.stopReason; state.facts.set(exec, value); throw new Error(value.stopReason) }, cleanup: false })
    const pair = await f.manual()
    const block = pair.result.content[0]!
    expect(block.type).toBe('text')
    const text = block.type === 'text' ? block.text : ''
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048)
    expect(() => JSON.parse(text)).not.toThrow()
    expect(JSON.parse(text)).toMatchObject({ status: 'partial', regions: [expect.objectContaining({ status: 'committed' }), expect.objectContaining({ status: 'not_attempted' })] })
  })
})
