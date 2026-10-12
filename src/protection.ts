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

function isTaskInput(message: Message, config: AcpConfig): boolean {
  if (message.role !== 'user') return false
  const source = message.source
  if ('form' in source && source.form === 'notice') return false
  const kind: string = source.kind
  return config.taskSourceKinds.includes(kind)
    && (kind !== 'agent-message' || ('form' in source && source.form === 'relay'))
}

/**
 * Track only the latest task and native checkpoints carrying it, in forward Log order.
 * @param events - Original committed Log events in ascending seq order.
 * @param config - Enabled task source kinds; notices never establish a task.
 * @returns Task/carrier seqs to intersect with the current Surface.
 */
export function latestTaskCarriers(events: Iterable<SessionEvent>, config: AcpConfig): ReadonlySet<SessionSeq> {
  const carriers = new Set<SessionSeq>()
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (isTaskInput(event.data, config)) {
      carriers.clear()
      carriers.add(event.seq)
    } else if (event.data.source.kind === 'compact-checkpoint' && event.surfaceOp !== 'append'
      && event.sourceEventSeqs?.some(seq => carriers.has(seq))) {
      carriers.add(event.seq)
    }
  }
  return carriers
}

/** Reasons attached to each protected current Surface node. */
export type ProtectionReason = 'system_or_developer' | 'live_instructions' | 'current_step' | 'latest_task_input' | 'latest_task_checkpoint'

/** Identify protected nodes and all applicable reasons for actionable rejection diagnostics. */
export function protectedNodes(
  surface: SurfaceCapture,
  identity: ExecutionIdentity,
  config: AcpConfig,
): ReadonlyMap<SessionSeq, readonly ProtectionReason[]> {
  const step = surface.log.findLast(event => event.type === 'step/start')
  if (step?.type !== 'step/start' || step.data.turn !== identity.turn || step.data.step !== identity.step) {
    throw new Error('ACP: the calling Step is no longer current')
  }
  const nodes = new Map<SessionSeq, readonly ProtectionReason[]>()
  const latestTaskNodes = latestTaskCarriers(surface.log, config)
  surface.seqs.forEach((seq, index) => {
    const event = surface.events[index]
    const message = surface.messages[index]
    const reasons: ProtectionReason[] = []
    if (event?.type === 'system/message' || event?.type === 'developer/message') reasons.push('system_or_developer')
    if (seq >= step.seq) reasons.push('current_step')
    if (message != null && 'form' in message.source && message.source.form === 'instructions') reasons.push('live_instructions')
    if (latestTaskNodes.has(seq)) reasons.push(message?.source.kind === 'compact-checkpoint' ? 'latest_task_checkpoint' : 'latest_task_input')
    if (reasons.length > 0) nodes.set(seq, reasons)
  })
  return nodes
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
