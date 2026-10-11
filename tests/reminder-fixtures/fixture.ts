import { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { AcpConfigSchema } from '../../src/config.ts'
import { installReminder } from '../../src/reminder.ts'
import type { AcpConfig, PreStepFrame, ReminderHooks } from '../../src/types.ts'

export class ReminderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []
  capacity: number | undefined = 100_000
  defaultMaxTokens: number | undefined
  summary = 'Native checkpoint preserving the task.'
  reply: (request: GenerateOptions) => readonly ContentBlock[] = () => [{ type: 'text', text: 'done' }]
  failNext = false
  beforeResolve: (() => Promise<void>) | undefined

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.beforeResolve?.()
    return { provider, id: model, name: model,
      ...this.capacity === undefined ? {} : { context: { contextWindow: this.capacity } },
      ...this.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: this.defaultMaxTokens },
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const summary = JSON.stringify(options.messages.at(-1)).includes('acting as a compaction engine')
    ;(summary ? this.summaryRequests : this.requests).push(structuredClone(options))
    if (!summary && this.failNext) {
      this.failNext = false
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'temporary fixture failure' } } }
      return
    }
    const blocks = summary ? [{ type: 'text' as const, text: this.summary }] : this.reply(options)
    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      yield { type: 'block-end', index, block }
    }
    yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
  }
}

export const largeTask = 'Historical completed work; preserve alpha. ' + 'detail '.repeat(1000)
export const configFor = (override: Partial<AcpConfig> = {}): AcpConfig => ({
  ...AcpConfigSchema({}),
  pressureRoutes: [{ provider: 'reminder', model: 'working', nudgeAtTokens: 1000, resetBelowTokens: 200 }],
  ...override,
})

export async function reminderFixture(config = configFor(), basic: BasicCompactionConfig = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  const adapter = new ReminderAdapter()
  ctx.llm.registerAdapter(['reminder'], adapter)
  await ctx.plugin(BasicCompactionEngine, { headroomTokens: 0, maxTokens: 64, retainTokens: 50, thresholdRatio: 0.8, ...basic })
  const native = ctx.compaction as BasicCompactionEngine
  const state: {
    hooks?: ReminderHooks
    before?: (frame: PreStepFrame) => Promise<void> | void
    afterNative?: () => void
    after?: (frame: PreStepFrame, decision: PreStepDecision) => Promise<PreStepDecision> | PreStepDecision
    candidate?: PreStepDecision
  } = {}
  const install = async () => ctx.plugin(Object.assign((scope: Context) => {
    const hooks = installReminder(scope, config, native.config)
    state.hooks = hooks
    scope.on('agent/pre-step', async (frame, next) => {
      await state.before?.(frame)
      const nativeDecision = await next()
      state.afterNative?.()
      const decision = await hooks.noticeAfterNative(frame, nativeDecision)
      state.candidate = decision
      return state.after === undefined ? decision : state.after(frame, decision)
    }, { prepend: true })
  }, { inject: ['tokenMeter', 'llm', 'sessionProjections'] }))
  let fiber = await install()
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('reminder-lifecycle'), { provider: 'reminder', model: 'working' }, { cwd: '/reminder-fixture' })
  const reload = async () => { await fiber.dispose(); fiber = await install() }
  return { ctx, adapter, native, agent, state, reload,
    disposeReminder: () => fiber.dispose(),
    async run(text = 'Continue the task.') {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
  }
}

export function notices(session: Session) {
  return session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'acp-pressure' && event.data.source.form === 'notice')
}

/** Real surface replacement: the original pressure notice remains available in Log. */
export function replaceHistory(session: Session, text: string): void {
  const nodes = session.surface.nodes.filter(seq => session.deriveEventMessage(session.eventAt(seq)!)?.role !== 'system')
  if (nodes.length === 0) throw new Error('No history to replace')
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), {
    surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes.at(-1)! }, sourceEventSeqs: nodes,
  })
}
