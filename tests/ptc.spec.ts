import { expect, it } from 'vitest'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
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

async function ptcFixture(outcome: 'success' | 'partial' | 'cancel' | 'late-cancel' | 'post-block' | 'post-throw' | 'post-replace' | 'invalid' | 'mixed') {
  let input: CompressInput
  let ordinaryRuns = 0
  const f = await createLoopFixture([
    [{ type: 'text', text: 'Completed historical A.' }],
    [{ type: 'text', text: 'Retain middle constraint.' }],
    [{ type: 'text', text: 'Completed historical B.' }],
    () => {
      let code = `return await tools.context_compress(${JSON.stringify(input)});`
      if (outcome === 'invalid') code = `const input = ${JSON.stringify(input)}; return await tools.context_compress(input);`
      if (outcome === 'mixed') code = `await tools.ordinary({}); ${code}`
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
    if (outcome === 'post-throw') ctx.on('tools/post-execute', async (exec, _result, next) => {
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
  if (outcome === 'partial') input = { regions: [...input.regions, { range: [{ text: 'missing endpoint' }, { text: 'missing endpoint' }], summary: 'Missing' }] }
  await runTurn(f.agent, 'Compress completed history then continue the task.')
  return { ...f, input, ordinaryRuns: () => ordinaryRuns }
}

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

for (const outcome of ['partial', 'cancel', 'late-cancel', 'post-block', 'post-throw', 'post-replace', 'invalid', 'mixed'] as const) it(`preserves the root pair and final accounting for ${outcome}`, async () => {
  const f = await ptcFixture(outcome)
  try {
    const log = f.agent.session.snapshotEvents()
    const result = log.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'ptc-compress')!
    expect(result).toBeDefined()
    expect(f.agent.session.surface.nodes).toContain(result.seq)
    expect(result).toMatchObject({ data: { message: { isError: outcome !== 'post-replace' } } })
    if (outcome === 'post-replace') expect(JSON.stringify(result)).toContain('Policy amended the successful root result')
    if (outcome === 'invalid' || outcome === 'mixed') {
      expect(log.filter(event => event.type === 'compaction/summary')).toHaveLength(0)
      expect(JSON.stringify(result)).toContain('return await tools.context_compress')
      expect(f.ordinaryRuns()).toBe(0)
    } else {
      expect(log.some(event => event.type === 'compaction/summary')).toBe(true)
      const notices = log.filter(event => event.type === 'user/message' && event.data.source.kind === 'acp-maintenance')
      expect(JSON.stringify([result, ...notices])).toContain('source_start_seq')
      if (outcome === 'partial') expect(JSON.stringify(result)).toContain('missing endpoint')
      if (outcome === 'late-cancel' || outcome === 'post-throw') {
        expect(notices).toHaveLength(1)
        expect(JSON.stringify(notices)).toContain('final_error')
        expect(JSON.stringify(notices)).toContain(outcome === 'late-cancel' ? 'ABORTED' : 'Root post policy threw')
      }
    }
    const seqs = [...f.agent.session.surface.nodes]
    const events = seqs.map(seq => log[seq]!)
    const surface: SurfaceCapture = { seqs, events, messages: events.map(event => f.agent.session.deriveEventMessage(event)), log }
    expect(isEndpointCandidate(surface, seqs.indexOf(result.seq))).toBe(outcome === 'invalid' || outcome === 'mixed')
  } finally { await f.ctx.fiber.dispose() }
})
