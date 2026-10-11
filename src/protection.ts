/** ACP protection and exact tool-pair checks over current interpreted Surface nodes. */
import type { Message, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { AcpConfig, ExecutionIdentity } from './types.ts'

/** Immutable values sampled together by Query capture. */
export interface SurfaceCapture {
  readonly seqs: readonly SessionSeq[]
  readonly events: readonly SessionEvent[]
  readonly messages: readonly (Message | null)[]
  readonly log: readonly SessionEvent[]
}

/** Protect current instructions, the active Step, and the most recent live task input. */
export function protectedSeqs(
  surface: SurfaceCapture,
  identity: ExecutionIdentity,
  config: AcpConfig,
): ReadonlySet<SessionSeq> {
  const step = surface.log.findLast(event => event.type === 'step/start')
  if (step?.type !== 'step/start' || step.data.turn !== identity.turn || step.data.step !== identity.step) {
    throw new Error('ACP: the calling Step is no longer current')
  }
  const protectedNodes = new Set<SessionSeq>()
  let latestTask: SessionSeq | undefined
  surface.seqs.forEach((seq, index) => {
    const event = surface.events[index]
    const message = surface.messages[index]
    if (event?.type === 'system/message' || event?.type === 'developer/message'
      || seq >= step.seq || (message !== null && message !== undefined
        && 'form' in message.source && message.source.form === 'instructions')) {
      protectedNodes.add(seq)
    }
    if (message?.role !== 'user') return
    const source = message.source
    if ('form' in source && source.form === 'notice') return
    const kind: string = source.kind
    if (!config.taskSourceKinds.includes(kind)) return
    if (kind === 'agent-message' && (!('form' in source) || source.form !== 'relay')) return
    if (latestTask === undefined || seq > latestTask) latestTask = seq
  })
  if (latestTask !== undefined) protectedNodes.add(latestTask)
  return protectedNodes
}

/** Each selected call occurrence must have exactly one selected matching result. */
export function assertCompleteToolPairs(messages: readonly (Message | null)[]): void {
  const pending = new Map<ToolCallId, number>()
  for (const message of messages) {
    if (message?.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        pending.set(block.id, (pending.get(block.id) ?? 0) + 1)
      }
    }
    if (message?.role === 'tool') {
      const count = pending.get(message.toolCallId) ?? 0
      if (count === 0) throw new Error(`ACP: selected result ${message.toolCallId} has no selected call`)
      if (count === 1) pending.delete(message.toolCallId)
      else pending.set(message.toolCallId, count - 1)
    }
  }
  if (pending.size > 0) throw new Error('ACP: selection splits a tool call/result pair')
}
