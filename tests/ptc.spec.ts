import { expect, it } from 'vitest'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { createLoopFixture, runTurn, seedHistory } from './loop-fixtures/agent-loop.ts'
import { loadActiveContext } from './loop-fixtures/loader.ts'
import { selection } from './loop-fixtures/compression-input.ts'
import { compressionProgram } from '../src/ptc.ts'
import { isEndpointCandidate } from '../src/endpoints.ts'
import type { SurfaceCapture } from '../src/protection.ts'
import type { CompressInput } from '../src/types.ts'

/** Executes the actual program against the production PTC bridge without spawning processes. */
class InProcessRuntime extends PtcRuntime {
  readonly language = 'typescript'
  override get programFormat() { return 'function-body' as const }
  readonly isolation = 'test'
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: 15_000 }
  }
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    try {
      const value = await new AsyncFunction('tools', spec.program)(spec.bindings[0]!.functions)
      return { logs: [], value }
    } catch (error) {
      return { logs: [], error: { kind: 'exception', message: String(error) } }
    }
  }
}

it('only parses the complete canonical JSON-literal program', () => {
  expect(compressionProgram(' \nreturn await tools.context_compress({"regions":[]});\n')).toEqual({ regions: [] })
  for (const code of ['return await tools.context_compress(input);', 'await tools.context_compress({});',
    'return await tools.context_compress({}); await tools.read({});', 'return await tools.context_compress(/*x*/{});']) {
    expect(compressionProgram(code)).toBeUndefined()
  }
})

async function ptcFixture(outcome: 'success' | 'partial' | 'cancel' | 'late-cancel' | 'post-block' | 'post-throw' | 'partial-root-error' | 'post-replace' | 'invalid' | 'mention') {
  let input: CompressInput
  let ordinaryRuns = 0
  const f = await createLoopFixture([
    [{ type: 'text', text: 'Completed historical A.' }],
    [{ type: 'text', text: 'Retain middle constraint.' }],
    [{ type: 'text', text: 'Completed historical B.' }],
    () => {
      let code = `return await tools.context_compress(${JSON.stringify(input)});`
      if (outcome === 'invalid') code = `const input = ${JSON.stringify(input)}; return await tools.context_compress(input);`
      if (outcome === 'mention') code = `const name = 'context_compress'; return await tools.ordinary({});`
      return [{ type: 'tool-call', name: 'run_code', id: ToolCallId('ptc-compress'), arguments: JSON.stringify({ code, description: 'Compress completed history' }) }]
    },
    [{ type: 'text', text: 'Continue after compression.' }],
  ], async ctx => {
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(InProcessRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
    ctx.tools.register({ name: 'ordinary', description: 'ordinary', parameters: {},
      output: { schema: { type: 'boolean' }, render: () => [] }, async execute() { ordinaryRuns++; return true } })
    if (outcome === 'cancel') ctx.on('tools/execute', async (exec, next) => {
      const result = await next()
      if (exec.name === 'context_compress') f.agent.cancel({ kind: 'user' })
      return result
    })
    if (outcome === 'late-cancel') ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.name === 'run_code') f.agent.cancel({ kind: 'user' })
      return decision
    })
    if (outcome === 'post-throw' || outcome === 'partial-root-error') ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name === 'run_code') throw new Error('Root post policy threw')
      return next()
    })
    if (outcome === 'post-replace') ctx.on('tools/post-execute', async (exec, _result, next) =>
      exec.name === 'run_code' ? { kind: 'accept', content: [{ type: 'text', text: 'Policy amended the successful root result' }] } : next())
    if (outcome === 'post-block') ctx.on('tools/post-execute', async (exec, _result, next) =>
      exec.name === 'run_code' ? { kind: 'block', feedback: [{ type: 'text', text: 'Root rejected after dispatch' }] } : next())
  }, 'ptc')
  await seedHistory(f.agent)
  input = selection(f.agent.session)
  if (outcome === 'partial' || outcome === 'partial-root-error') input = { regions: [
    ...(outcome === 'partial' ? input.regions : input.regions.slice(0, 1)),
    { range: [{ text: 'missing endpoint' }, { text: 'missing endpoint' }], summary: 'Missing' },
  ] }
  await runTurn(f.agent, 'Compress completed history then continue the task.')
  return { ...f, input, ordinaryRuns: () => ordinaryRuns }
}

it('executes ordinary scripts that mention context_compress', async () => {
  const f = await ptcFixture('mention')
  try {
    const log = f.agent.session.snapshotEvents()
    const result = log.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'ptc-compress')!
    expect(result).toMatchObject({ data: { message: { isError: false } } })
    expect(f.ordinaryRuns()).toBe(1)
    expect(log.filter(event => event.type === 'compaction/summary')).toHaveLength(0)
  } finally { await f.ctx.fiber.dispose() }
})

it('compresses through the real PTC bridge, then hides only the successful canonical root pair', async () => {
  const f = await ptcFixture('success')
  try {
    const log = f.agent.session.snapshotEvents()
    expect(log.filter(event => event.type === 'compaction/summary'), JSON.stringify(log.filter(event => event.type === 'tool/result' || event.type === 'tool/ptc-dispatch'))).toHaveLength(2)
    expect(log.filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(1)
    const result = log.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'ptc-compress')!
    expect(result).toMatchObject({ data: { message: { isError: false } } })
    expect(f.agent.session.surface.nodes).not.toContain(result.seq)
    const maintenance = log.find(event => event.type === 'user/message' && event.data.source.kind === 'acp-maintenance')!
    expect(JSON.stringify(maintenance)).toContain('original call/result archived')
    for (const region of f.input.regions) {
      expect(JSON.stringify(maintenance)).toContain(region.range[0]!.text)
      expect(JSON.stringify(maintenance)).not.toContain(region.summary)
      expect(JSON.stringify(f.adapter.requests.at(-1)!.messages).split(region.summary)).toHaveLength(2)
    }
    expect(JSON.stringify(maintenance)).toContain('source_start_seq')
    expect(JSON.stringify(maintenance)).toContain('tool_call_seq')
    expect(JSON.stringify(log.find(event => event.type === 'tool/call' && event.data.callId === 'ptc-compress'))).toContain(f.input.regions[0]!.summary)
    expect(f.adapter.requests).toHaveLength(5)
  } finally { await f.ctx.fiber.dispose() }
})

for (const outcome of ['partial', 'cancel', 'late-cancel', 'post-block', 'post-throw', 'partial-root-error', 'post-replace', 'invalid'] as const) it(`preserves the root pair and final accounting for ${outcome}`, async () => {
  const f = await ptcFixture(outcome)
  try {
    const log = f.agent.session.snapshotEvents()
    const result = log.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'ptc-compress')!
    expect(result).toBeDefined()
    expect(f.agent.session.surface.nodes).toContain(result.seq)
    expect(result).toMatchObject({ data: { message: { isError: outcome !== 'post-replace' } } })
    if (outcome === 'post-replace') expect(JSON.stringify(result)).toContain('Policy amended the successful root result')
    if (outcome === 'invalid') {
      expect(log.filter(event => event.type === 'compaction/summary')).toHaveLength(0)
      expect(JSON.stringify(result)).toContain('return await tools.context_compress')
      expect(log.filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(1)
    } else {
      expect(log.some(event => event.type === 'compaction/summary')).toBe(true)
      const notices = log.filter(event => event.type === 'user/message' && event.data.source.kind === 'acp-maintenance')
      expect(JSON.stringify([result, ...notices])).toContain('source_start_seq')
      if (outcome === 'partial') expect(JSON.stringify(result)).toContain('missing endpoint')
      if (outcome === 'late-cancel' || outcome === 'post-throw' || outcome === 'partial-root-error') {
        expect(notices).toHaveLength(1)
        expect(JSON.stringify(notices)).toContain('final_error')
        expect(JSON.stringify(notices)).toContain(outcome === 'late-cancel' ? 'ABORTED' : 'Root post policy threw')
        if (outcome === 'partial-root-error') {
          const committed = log.filter(event => event.type === 'compaction/summary')
          expect(committed).toHaveLength(1)
          expect(committed[0]?.data.summary).toEqual([{ type: 'text', text: f.input.regions[0]!.summary }])
          expect(JSON.stringify(f.agent.session.deriveMessages())).toContain(f.input.regions[0]!.summary)
          expect(JSON.stringify(notices)).toContain('missing endpoint')
        }
      }
    }
    const seqs = [...f.agent.session.surface.nodes]
    const events = seqs.map(seq => log[seq]!)
    const surface: SurfaceCapture = { seqs, events, messages: events.map(event => f.agent.session.deriveEventMessage(event)), log }
    expect(isEndpointCandidate(surface, seqs.indexOf(result.seq))).toBe(outcome === 'invalid')
  } finally { await f.ctx.fiber.dispose() }
})
for (const mode of ['native', 'ptc'] as const) for (const change of ['none', 'instructions'] as const) {
  it(`uses ${mode} boundary maps as reference only (${change})`, async () => {
    const mapId = ToolCallId('history-map')
    const compressId = ToolCallId('use-map')
    const marker = 'Protected boundaries in Surface order'
    const instruction = 'A new live instruction after the map.'
    let range: CompressInput['regions'][number]['range']
    const call = (id: ToolCallId, name: string, args: object) => ({ type: 'tool-call' as const, id, name, arguments: JSON.stringify(args) })
    const runCode = (id: ToolCallId, code: string) => call(id, 'run_code', { code, description: 'Replay bounded context' })
    const f = await createLoopFixture([
      [{ type: 'text', text: 'Completed historical A.' }],
      [{ type: 'text', text: 'Retain middle constraint.' }],
      [{ type: 'text', text: 'Completed historical B.' }],
      mode === 'native' ? [call(mapId, 'context_boundaries', {}), call(ToolCallId('sibling'), 'ordinary', {})]
        : [runCode(mapId, 'const map = await tools.context_boundaries({}); await tools.ordinary({}); return map;')],
      request => {
        expect(JSON.stringify(request.messages)).toContain(marker)
        const session = f.agent.session
        const log = session.snapshotEvents()
        const root = log.find(event => event.type === 'tool/result' && event.data.message.toolCallId === mapId)
        const child = log.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'context_boundaries')
        const map = mode === 'native' ? (root?.type === 'tool/result' ? root.data.message.content : undefined)
          : child?.type === 'tool/ptc-dispatch' ? child.data.content : undefined
        const text = map?.find(block => block.type === 'text')?.text
        expect(text).toMatch(/B\d+ instructions .*system /)
        expect(text).not.toContain('Inspect boundaries and optionally compress completed history.')
        expect(text).not.toContain(instruction)
        const encoded = text?.split('\n').find(line => line.startsWith('Selectable historical ranges: '))?.slice('Selectable historical ranges: '.length)
        expect(encoded).toBeDefined()
        range = JSON.parse(encoded!)[0]
        expect(range[0]).toMatchObject({ role: 'user' })
        expect(range[1]).toMatchObject({ role: 'assistant', text: 'Completed historical B.' })
        if (change === 'instructions') {
          const first = log.find(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes(range[0]!.text)))!
          if (first.type !== 'user/message') throw new Error('Missing historical range start')
          session.append('user/message', createUserMessage({
            content: [...first.data.content, { type: 'text', text: instruction }], source: { kind: 'user', form: 'instructions' },
          }), { surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq }, sourceEventSeqs: [first.seq] })
        }
        const display = { text: marker, role: 'tool' }
        const input = { regions: [{ range: [display, display], summary: 'Map text must not be an endpoint.' },
          { range, summary: 'Completed history retained from the suggested range.' }] }
        return [mode === 'native' ? call(compressId, 'context_compress', input)
          : runCode(compressId, 'return await tools.context_compress(' + JSON.stringify(input) + ');')]
      },
      [{ type: 'text', text: 'Continued the task.' }],
    ], async ctx => {
      if (mode === 'ptc') {
        provideWorkingDirectoryFixture(ctx)
        await ctx.plugin(InProcessRuntime)
      }
      await ctx.plugin(TokenMeter)
      await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
      await loadActiveContext(ctx, { basic: { auto: false } })
      ctx.tools.register({ name: 'ordinary', description: 'Sibling fixture', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        async execute() { return 'Sibling completed.' } })
    }, mode)
    try {
      await seedHistory(f.agent)
      await runTurn(f.agent, 'Inspect boundaries and optionally compress completed history.')
      const events = f.agent.session.snapshotEvents()
      const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === compressId)
      expect(result, JSON.stringify(events.filter(event => event.type === 'tool/result' || event.type === 'turn/end' || event.type === 'assistant/attempt').slice(-5))).toBeDefined()
      expect(JSON.stringify(result)).toContain('has no match')
      expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(change === 'none' ? 1 : 0)
      expect(JSON.stringify(events)).toContain('Sibling completed.')
      if (change === 'instructions') {
        expect(JSON.stringify(result)).toContain('live_instructions')
        expect(JSON.stringify(f.agent.session.deriveMessages())).toContain(instruction)
      }
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally { await f.ctx.fiber.dispose() }
  })
}
