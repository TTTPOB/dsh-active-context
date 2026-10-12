/** Shared provider/region fixture using real services and a real production Agent. */
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AcpConfigSchema } from '../src/config.ts'
import { ActiveCompactionEngine } from '../src/provider.ts'
import { submitRegions } from '../src/regions.ts'
import type { AcpState, CompressInput, ExecutionIdentity, RegionInput } from '../src/types.ts'

class SummaryAdapter extends LlmAdapter {
  calls = 0
  override async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'text-delta', index: 0, text: 'native summary' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class LiveQuery extends SessionQuery {
  override searchSessions(): never { throw new Error('This fixture only captures the live Session') }
  override searchEvents(): never { throw new Error('This fixture only captures the live Session') }
}

export async function providerFixture() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(LiveQuery, {})
  const adapter = new SummaryAdapter()
  ctx.llm.registerAdapter(['author'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('acp-provider-fixture'), { provider: 'author', model: 'working' })
  const session = agent.session
  const old: SessionSeq[] = []
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `task ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    if (turn === 1) session.append('request/header', { header: { config: { provider: 'author', model: 'working' } }, reason: 'initial' })
    old.push(session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: `completed ${turn} ` + 'details '.repeat(700) }], source: { kind: 'model', provider: 'author', model: 'working' } }),
    }, { surfaceOp: 'append' }).seq)
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })
  const latestTask = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'current task' }], source: { kind: 'user' } }), { surfaceOp: 'append' }).seq
  session.append('step/start', { turn: 4, step: 1 })
  const callId = ToolCallId('acp-fixture-call')
  const assistant = session.append('assistant/message', { turn: 4, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'context_compress', arguments: '{}' }], source: { kind: 'model', provider: 'author', model: 'working' } }) }, { surfaceOp: 'append' })
  const identity: ExecutionIdentity = { sessionId: agent.id, turn: 4, step: 1, assistantSeq: assistant.seq, callId, provider: 'author', model: 'working' }
  const config = AcpConfigSchema({})
  const engine = new ActiveCompactionEngine(ctx, { auto: false })
  const state: AcpState = { identities: new WeakMap(), facts: new WeakMap(), hideCandidates: new WeakMap() }
  function input(regions?: readonly RegionInput[]): CompressInput {
    return { regions: regions ?? [
      { range: [{ text: 'completed 1 ' }, { text: 'completed 1 ' }], summary: 'completed head' },
      { range: [{ text: 'completed 3 ' }, { text: 'completed 3 ' }], summary: 'completed tail' },
    ] }
  }
  let submittedBatch = input()
  let submittedIdentity = identity
  let rendered = ''
  ctx.tools.register(defineTool({ name: 'fixture-submit', description: 'Submit a test-only active batch', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, async execute(_args, exec) {
    rendered = await submitRegions(ctx, engine, exec, submittedIdentity, submittedBatch, config, state)
    return rendered
  } }))
  async function submit(batch = input(), executionIdentity = identity) {
    submittedBatch = batch
    submittedIdentity = executionIdentity
    rendered = ''
    const result = await ctx.tools.execute({ name: 'fixture-submit', callId, arguments: {}, signal: new AbortController().signal, agent })
    return { result, rendered, facts: rendered ? JSON.parse(rendered) : undefined }
  }
  return { ctx, agent, session, adapter, engine, identity, config, state, old, latestTask, input, submit, dispose: () => ctx.fiber.dispose() }
}
