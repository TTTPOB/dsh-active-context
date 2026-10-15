/** Final-result observation and next-step archival of a confirmed full/partial tool pair. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AcpConfig, AcpState, HideCandidate, HideHooks } from './types.ts'
import { isBatchOutcomeError, RETRY_INSTRUCTION } from './regions.ts'

interface ObservedStep {
  readonly turn: number
  readonly step: number
  assistant?: SessionEvent<'assistant/message'> | undefined
  call?: SessionEvent<'tool/call'>
  callCount: number
  ended: boolean
  final?: { readonly exec: Readonly<ToolExecution>; readonly facts: HideCandidate['facts'] } | undefined
}

interface ObservedPair {
  readonly candidate: HideCandidate
  readonly step: ObservedStep
  readonly assistant: SessionEvent<'assistant/message'>
  readonly result: SessionEvent<'tool/result'>
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Model-free confirmation replacing one successful ACP tool pair. */
    'acp-maintenance': { readonly kind: 'acp-maintenance'; readonly form: 'notice'; readonly summary: string }
  }
}

function confirmation(ctx: Context, config: AcpConfig, candidate: HideCandidate, session: Session): UserMessage | undefined {
  const retryable = candidate.facts.regions.filter(fact => fact.status === 'failed' || fact.status === 'not_attempted').map(fact => fact.inputIndex)
  const record = {
    status: candidate.facts.status === 'batch_success' ? 'compressed' : 'partial',
    regions: candidate.facts.regions.map(fact => ({
      input_index: fact.inputIndex, status: fact.status, range: fact.range, expanded: fact.expanded || undefined,
      error: fact.error,
    })),
    stop_reason: candidate.facts.stopReason,
    log: { assistant_seq: candidate.assistantSeq, tool_call_seq: candidate.toolCallSeq, result_seq: candidate.resultSeq },
    retry: retryable.length === 0 ? undefined : { regions: retryable, instruction: RETRY_INSTRUCTION },
  }
  let message = createUserMessage({
    content: [{ type: 'text', text: 'Context compression committed; original call/result archived. ' + JSON.stringify(record) }],
    source: { kind: 'acp-maintenance', form: 'notice', summary: boundContextSummary('Context compression status; original call and result archived.') },
  })
  const header = session.requestHeader()
  const route = config.pressureRoutes.find(route => route.provider === header?.config.provider && route.model === header.config.model)
  if (route !== undefined) {
    const measurement = ctx.tokenMeter.measure(session)
    const removedTokens = measurement.nodes.filter(node => node.seq === candidate.assistantSeq || node.seq === candidate.resultSeq)
      .reduce((sum, node) => sum + node.tokens, 0)
    // Price the short replacement, not the duplicated summary arguments and full tool result.
    const afterReplacement = Math.max(0, measurement.totalTokens - removedTokens + ctx.tokenMeter.estimateMessage(message))
    if (afterReplacement >= route.resetBelowTokens) message = {
      ...message,
      content: [...message.content, { type: 'text', text: `Context remains at or above the reset threshold R=${route.resetBelowTokens} tokens after this tool-pair replacement. Continue context_compress on other completed work until below R to rearm pressure reminders; do not resubmit committed regions.` }],
    }
  }
  // Never truncate real endpoints or omit retry facts to fit the cleanup budget.
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > config.confirmationMaxBytes
    || ctx.tokenMeter.estimateMessage(message) > config.confirmationMaxTokens) return undefined
  return message
}

/**
 * Record final results with confirmed commits and prepare exact two-node maintenance.
 * @param ctx - effect-owning context with token-meter and session observers.
 * @param config - complete short-confirmation budgets.
 * @param state - composition-owned identities, execution facts, and candidates.
 * @returns cleanup hook; the composition owner alone registers pre-step.
 */
export function installHide(ctx: Context, config: AcpConfig, state: AcpState): HideHooks {
  let steps = new WeakMap<Session, ObservedStep>()
  let pairs = new WeakMap<Agent, ObservedPair>()
  const candidateAgents = new Set<Agent>()
  const forget = (agent: Agent) => {
    state.hideCandidates.delete(agent)
    pairs.delete(agent)
    candidateAgents.delete(agent)
  }

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'context_compress' || exec.agent === undefined) return
    const identity = state.identities.get(exec)
    const facts = state.facts.get(exec)
    const step = steps.get(exec.agent.session)
    if (step === undefined || identity === undefined || (result.isError && !isBatchOutcomeError(result.error.info?.code)) || exec.signal.aborted
      || facts === undefined || facts.regions.some(region => region.status === 'unconfirmed')
      || !facts.regions.some(region => (region.status === 'committed' || region.status === 'committed_with_error') && region.compactionId !== undefined)
      || identity.turn !== step.turn || identity.step !== step.step) return
    step.final = { exec, facts: structuredClone({
      status: facts.status,
      regions: facts.regions.map(({ inputIndex, status, range, expanded, error }) => ({ inputIndex, status, range, expanded, ...error === undefined ? {} : { error } })),
      ...facts.stopReason === undefined ? {} : { stopReason: facts.stopReason },
    }) }
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') {
      steps.set(session, { ...event.data, callCount: 0, ended: false })
      return
    }
    const step = steps.get(session)
    if (step === undefined) return
    if (event.type === 'step/end' && event.data.turn === step.turn && event.data.step === step.step) {
      step.ended = true
      return
    }
    if (event.type === 'assistant/message') {
      step.assistant = event.surfaceOp === 'append' && event.data.interrupted !== true
        && event.data.turn === step.turn && event.data.step === step.step ? event : undefined
    } else if (event.type === 'tool/call' && event.data.turn === step.turn && event.data.step === step.step) {
      step.callCount += 1
      step.call = event
    } else if (event.type === 'tool/result') {
      const final = step.final
      const assistant = step.assistant
      const call = step.call
      if (final === undefined || assistant === undefined || call === undefined || step.callCount !== 1) return
      // Consume once: neither replay nor an unrelated later result can mint another candidate.
      step.final = undefined
      const agent = final.exec.agent
      const identity = state.identities.get(final.exec)
      if (agent === undefined || identity === undefined || identity.sessionId !== session.id
        || event.surfaceOp !== 'append'
        || ((event.data.message.isError === true || event.data.error !== undefined) && !isBatchOutcomeError(event.data.error?.code))
        || event.data.turn !== identity.turn || event.data.step !== identity.step
        || assistant.seq !== identity.assistantSeq || call.data.callId !== identity.callId
        || call.data.name !== 'context_compress'
        || event.data.message.source.callId !== identity.callId || event.data.message.toolCallId !== identity.callId
        || event.sourceEventSeqs?.length !== 1 || event.sourceEventSeqs[0] !== call.seq) return
      const blocks = assistant.data.message.content
      const calls = blocks.filter(block => block.type === 'tool-call')
      if (calls.length !== 1 || calls[0]?.id !== identity.callId || calls[0].name !== call.data.name
        || calls[0].arguments !== call.data.arguments
        || blocks.some(block => block.type !== 'tool-call' && block.type !== 'reasoning'
          && !(block.type === 'text' && block.text.trim() === ''))) return
      const index = session.surface.nodes.indexOf(assistant.seq)
      if (index < 0 || session.surface.nodes[index + 1] !== event.seq) return
      const candidate: HideCandidate = {
        identity, execution: final.exec, assistantSeq: assistant.seq, toolCallSeq: call.seq,
        resultSeq: event.seq, facts: final.facts,
      }
      forget(agent)
      state.hideCandidates.set(agent, candidate)
      pairs.set(agent, { candidate, step, assistant, result: event })
      candidateAgents.add(agent)
    }
  })
  ctx.on('session/disposed', session => {
    steps.delete(session)
    for (const agent of candidateAgents) if (agent.session === session) forget(agent)
  })
  ctx.effect(() => () => {
    for (const agent of candidateAgents) state.hideCandidates.delete(agent)
    candidateAgents.clear()
    steps = new WeakMap()
    pairs = new WeakMap()
  })

  return {
    cleanupBeforeNative(frame) {
      const pair = pairs.get(frame.agent)
      if (pair === undefined) return
      const { candidate, step, assistant, result } = pair
      // A failed or interrupted maintenance attempt leaves the original pair, with no retry queue.
      forget(frame.agent)
      if (frame.signal.aborted || candidate.execution.signal.aborted || !step.ended
        || frame.turn < candidate.identity.turn
        || (frame.turn === candidate.identity.turn && frame.step <= candidate.identity.step)) return
      const session = frame.agent.session
      const nodes = session.surface.nodes
      const index = nodes.indexOf(candidate.assistantSeq)
      if (session.id !== candidate.identity.sessionId || index < 0 || nodes[index + 1] !== candidate.resultSeq) return
      const assistantMessage = session.deriveEventMessage(assistant)
      const resultMessage = session.deriveEventMessage(result)
      if (assistantMessage !== assistant.data.message || resultMessage !== result.data.message) return
      const message = confirmation(ctx, config, candidate, session)
      if (message === undefined) return
      const shadowedSeqs = [candidate.assistantSeq, candidate.resultSeq]
      const shadowedTokenCount = ctx.tokenMeter.estimateMessage(assistantMessage) + ctx.tokenMeter.estimateMessage(resultMessage)
      // No await: a prune claim is consumed only by its immediately adjacent replacement.
      session.append('compaction/prune', {
        shadowedRange: { start: candidate.assistantSeq, end: candidate.resultSeq },
        shadowedSeqs,
        shadowedTokenCount,
      })
      session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: candidate.assistantSeq, endSeq: candidate.resultSeq },
        sourceEventSeqs: [candidate.assistantSeq, candidate.toolCallSeq, candidate.resultSeq],
      })
    },
  }
}
