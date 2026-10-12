/** ACP protection and exact tool-pair checks over current interpreted Surface nodes. */
import type { Message, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionCaptureReader, SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { AcpConfig } from './types.ts'

/** Immutable values sampled together by Query capture. */
export interface SurfaceCapture {
  readonly seqs: readonly SessionSeq[]
  readonly events: readonly SessionEvent[]
  readonly messages: readonly (Message | null)[]
  readonly log: readonly SessionEvent[]
}

/** Detach one actual live Surface while the Query capture reader is borrowed. */
export function sampleSurface(agent: Agent, reader: SessionCaptureReader, observation: SessionObservation): SurfaceCapture {
  if (reader !== agent.session) throw new Error('ACP: Query did not select the calling live Session')
  const seqs = [...reader.surface.nodes]
  const events = seqs.map(seq => {
    const event = observation.events[seq]
    if (event === undefined) throw new Error(`ACP: Surface node ${seq} is outside the observed Log`)
    return event
  })
  return { seqs, events, messages: events.map(event => structuredClone(reader.deriveEventMessage(event))), log: [...observation.events] }
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
  position: { readonly turn: number; readonly step: number },
  config: AcpConfig,
  phase: 'execution' | 'pre-step' = 'execution',
): ReadonlyMap<SessionSeq, readonly ProtectionReason[]> {
  const step = surface.log.findLast(event => event.type === 'step/start')
  if (phase === 'execution') {
    if (step?.type !== 'step/start' || step.data.turn !== position.turn || step.data.step !== position.step) {
      throw new Error('ACP: the calling Step is no longer current')
    }
  } else {
    const turn = surface.log.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    const boundary = surface.log.findLast(event => event.type === 'step/start' || event.type === 'step/end')
    const previousStep = step?.type === 'step/start' && step.data.turn === position.turn ? step.data.step : 0
    if (turn?.type !== 'turn/start' || turn.data.turn !== position.turn || position.step !== previousStep + 1
      || boundary?.type === 'step/start') throw new Error('ACP: pressure map requires the actual pre-step position')
  }
  const nodes = new Map<SessionSeq, readonly ProtectionReason[]>()
  const latestTaskNodes = latestTaskCarriers(surface.log, config)
  surface.seqs.forEach((seq, index) => {
    const event = surface.events[index]
    const message = surface.messages[index]
    const reasons: ProtectionReason[] = []
    if (event?.type === 'system/message' || event?.type === 'developer/message') reasons.push('system_or_developer')
    if (phase === 'execution' && step !== undefined && seq >= step.seq) reasons.push('current_step')
    if (message != null && 'form' in message.source && message.source.form === 'instructions') reasons.push('live_instructions')
    if (latestTaskNodes.has(seq)) reasons.push(message?.source.kind === 'compact-checkpoint' ? 'latest_task_checkpoint' : 'latest_task_input')
    if (reasons.length > 0) nodes.set(seq, reasons)
  })
  return nodes
}

/** A selection failure can be reported without hiding a host/service failure. */
export class RegionSelectionError extends Error {}

/** Complete all intersecting tool spans, retaining known bounds when a counterpart is missing. */
export function expandToolPairs(messages: readonly (Message | null)[], start: number, end: number): { start: number; end: number; missingCounterpart: boolean } {
  const pending = new Map<ToolCallId, number[]>()
  const pairs: [number, number][] = []
  const missing = new Set<number>()
  messages.forEach((message, index) => {
    if (message?.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') pending.set(block.id, [...pending.get(block.id) ?? [], index])
      }
    } else if (message?.role === 'tool') {
      const call = pending.get(message.toolCallId)?.shift()
      if (call === undefined) missing.add(index)
      else pairs.push([call, index])
    }
  })
  for (const calls of pending.values()) for (const index of calls) missing.add(index)
  let previousStart: number
  let previousEnd: number
  do {
    previousStart = start
    previousEnd = end
    // A plain-text node between a call and its result also cuts that tool span.
    for (const [call, result] of pairs) {
      if (call > end || result < start) continue
      start = Math.min(start, call)
      end = Math.max(end, result)
    }
  } while (start !== previousStart || end !== previousEnd)
  return { start, end, missingCounterpart: [...missing].some(index => index >= start && index <= end) }
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
