/** Real registry, session, token-meter, and Loop fixtures for ACP lifecycle tests. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createAssistantMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { installGuard } from '../../src/guard.ts'
import { installHide } from '../../src/hide.ts'
import { AcpConfigSchema } from '../../src/config.ts'
import type { AcpConfig, AcpState, BatchFacts } from '../../src/types.ts'

export function call(id = 'compress-1', name = 'context_compress'): ToolCallBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: '{}' }
}

export function facts(status: BatchFacts['status'] = 'batch_success'): BatchFacts {
  return {
    status, executionOrder: [1, 0],
    regions: [0, 1].map(index => ({
      inputIndex: index, range: [{ text: `original ${index}`, role: 'assistant' as const }, { text: `original ${index}` }], expanded: false,
      status: status === 'batch_success' ? 'committed' : index === 0 ? 'committed' : 'not_attempted',
      compactionId: CompactionId(`compact-${index}`), replacementSeq: SessionSeq(10 + index),
      ...status === 'batch_success' || index === 0 ? { source: { sessionId: SessionId('guard-hide-test'), startSeq: SessionSeq(index + 1), endSeq: SessionSeq(index + 1) } } : {},
      shadowedSeqs: [SessionSeq(index + 1)], shadowedRouteTokens: 100, shadowedHeuristicTokens: 100,
      // Native readback evidence for one observed transaction per region.
      result: {
        compactionId: CompactionId(`compact-${index}`), startSeq: SessionSeq(index + 1), summarySeq: SessionSeq(10 + index),
        endSeq: SessionSeq(index + 1), summary: [], shadowedRange: { start: SessionSeq(index + 1), end: SessionSeq(index + 1) },
        shadowedSeqs: [SessionSeq(index + 1)], shadowedTokenCount: 100,
      },
    })),
  }
}

class Scripted extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly replies: readonly (readonly ContentBlock[])[]) { super() }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 100_000 } }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const blocks = this.replies[this.requests.length]
    this.requests.push(options)
    if (blocks === undefined) throw new Error('Unexpected extra model request')
    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      yield { type: 'block-end', index, block }
    }
    yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
  }
}

export async function fixture(options: {
  replies?: readonly (readonly ContentBlock[])[]
  mode?: 'native' | 'ptc'
  body?: (exec: ToolRunContext, state: AcpState) => void
  config?: Partial<AcpConfig>
  cleanup?: boolean
  pressurePending?: boolean
} = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: options.mode ?? 'native' } })
  await ctx.plugin(TokenMeter)
  const config = { ...AcpConfigSchema({}), ...options.config }
  const state: AcpState = { identities: new WeakMap(), facts: new WeakMap(), hideCandidates: new WeakMap() }
  const executions: Readonly<ToolExecution>[] = []
  let siblingRuns = 0
  let guard!: ReturnType<typeof installGuard>
  let hide!: ReturnType<typeof installHide>
  const fiber = ctx.plugin({
    name: 'guard-hide-fixture',
    inject: ['tools', 'tokenMeter'],
    apply(scope) {
      guard = installGuard(scope, config, state)
      hide = installHide(scope, config, state, { hasPendingReminder: () => options.pressurePending ?? false })
      scope.tools.register({
        name: 'context_compress', description: 'test compression', parameters: {},
        output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'original successful body' }] },
        finalizeContent: guard.finalizeContent,
        async execute(_args, exec) {
          guard.requireIdentity(exec)
          executions.push(exec)
          state.facts.set(exec, facts())
          options.body?.(exec, state)
          return { ok: true }
        },
      })
      scope.tools.register({
        name: 'ordinary', description: 'ordinary sibling', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        async execute() { siblingRuns += 1; return 'ordinary succeeded' },
      })
      if (options.cleanup !== false) scope.on('agent/pre-step', async (frame, next) => {
        await hide.cleanupBeforeNative(frame)
        return next()
      })
    },
  })
  await fiber
  const adapter = new Scripted(options.replies ?? [])
  ctx.llm.registerAdapter(['guard-test'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('guard-hide-test'), { provider: 'guard-test', model: 'scripted' })
  const run = async () => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  const manual = async (blocks: readonly ContentBlock[] = [call()], interrupted = false) => {
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const assistant = session.append('assistant/message', {
      turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: blocks, source: { provider: 'real-author', model: 'real-model' } }),
      ...(interrupted ? { interrupted: true as const } : {}),
    }, { surfaceOp: 'append' })
    const block = blocks.find(item => item.type === 'tool-call') ?? call()
    const toolCall = session.append('tool/call', { turn: 1, step: 1, callId: block.id, name: block.name, arguments: block.arguments })
    const result = await ctx.tools.execute({ callId: block.id, name: block.name, arguments: {}, agent, signal: new AbortController().signal })
    const resultEvent = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: block.id, content: result.content, isError: result.isError }),
      ...(result.error?.info === undefined ? {} : { error: result.error.info }),
    }, { surfaceOp: 'append', sourceEventSeqs: [toolCall.seq] })
    session.append('step/end', { turn: 1, step: 1 })
    return { assistant, toolCall, result, resultEvent }
  }
  return { ctx, config, state, guard, hide, fiber, agent, adapter, executions, run, manual, siblingRuns: () => siblingRuns }
}

export function frame(agent: Agent, signal = new AbortController().signal) {
  return { agent, turn: 1, step: 2, messages: [], signal }
}
