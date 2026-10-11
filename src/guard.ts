/** Independent native-call admission and final, execution-local ACP diagnostics. */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AcpConfig, AcpState, ExecutionIdentity, GuardHooks } from './types.ts'
import { renderBatchFacts } from './regions.ts'

interface StepAuthor {
  readonly turn: number
  readonly step: number
  assistant?: SessionEvent<'assistant/message'> | undefined
  readonly executions: Set<Readonly<ToolExecution>>
}

/**
 * Observe normal appended authors and admit only their one direct compression call.
 * @param ctx - effect-owning plugin context with tools and session events.
 * @param config - complete ACP diagnostic budget.
 * @param state - composition-owned execution facts and accepted identities.
 * @returns identity assertion and the tool definition's final content callback.
 */
export function installGuard(ctx: Context, config: AcpConfig, state: AcpState): GuardHooks {
  let authors = new WeakMap<Session, StepAuthor>()
  const liveExecutions = new Set<Readonly<ToolExecution>>()
  const clear = (author: StepAuthor | undefined) => {
    for (const exec of author?.executions ?? []) {
      state.identities.delete(exec)
      liveExecutions.delete(exec)
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') {
      clear(authors.get(session))
      authors.set(session, { ...event.data, executions: new Set() })
    } else if (event.type === 'step/end' || event.type === 'turn/end') {
      clear(authors.get(session))
      authors.delete(session)
    } else if (event.type === 'assistant/message') {
      const author = authors.get(session)
      if (author === undefined) return
      author.assistant = event.surfaceOp === 'append' && event.data.interrupted !== true
        && event.data.turn === author.turn && event.data.step === author.step ? event : undefined
    }
  })
  ctx.on('session/disposed', session => {
    clear(authors.get(session))
    authors.delete(session)
  })
  ctx.tools.guard(exec => {
    if (exec.name !== 'context_compress') return undefined
    const deny = 'ACP: context_compress requires one independent native/both call, no task text or siblings. Retry directly in a separate assistant response, not through run_code/PTC; select each region with two distinctive literal text endpoints in range (optional role) and a non-empty summary.'
    if (exec.agent === undefined || exec.parent !== undefined || exec.rootCallId !== exec.callId) return deny
    const author = authors.get(exec.agent.session)
    const assistant = author?.assistant
    if (author === undefined || assistant === undefined
      || !exec.agent.session.surface.nodes.includes(assistant.seq)) return deny
    const { message } = assistant.data
    const calls = message.content.filter(block => block.type === 'tool-call')
    // Count the original blocks, not a map keyed by provider-issued call ids.
    if (calls.length !== 1 || calls[0]?.id !== exec.callId || calls[0].name !== exec.name
      || message.content.some(block => block.type !== 'tool-call' && block.type !== 'reasoning'
        && !(block.type === 'text' && block.text.trim() === ''))
      || message.source.provider.trim() === '' || message.source.model.trim() === '') return deny
    if ([...author.executions].some(previous => previous.callId === exec.callId)) return deny
    const identity: ExecutionIdentity = {
      sessionId: exec.agent.session.id,
      turn: author.turn,
      step: author.step,
      assistantSeq: assistant.seq,
      callId: exec.callId,
      provider: message.source.provider,
      model: message.source.model,
    }
    state.identities.set(exec, identity)
    author.executions.add(exec)
    liveExecutions.add(exec)
    return undefined
  })
  ctx.effect(() => () => {
    for (const exec of liveExecutions) state.identities.delete(exec)
    liveExecutions.clear()
    authors = new WeakMap()
  })
  return {
    requireIdentity(exec) {
      const identity = state.identities.get(exec)
      if (identity === undefined) throw new HarnessError('ACP: independent appended assistant identity required', 'ACP_INDEPENDENT_CALL_REQUIRED')
      return identity
    },
    finalizeContent(exec, result) {
      const facts = state.facts.get(exec)
      if (facts === undefined) return undefined
      try {
        return [{ type: 'text', text: renderBatchFacts(facts, config, result.isError ? result : undefined) }]
      } catch (error) {
        // Budget reservation rejects before the first commit; preserve that registry failure.
        return undefined
      }
    },
  }
}
