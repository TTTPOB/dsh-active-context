/** Shared literal matching excludes ACP display nodes, not their Surface membership. */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SurfaceCapture } from './protection.ts'
import type { TextEndpoint } from './types.ts'

/** Classify owned displays by source or the exact logged tool call, never by body text. */
export function isEndpointCandidate(surface: SurfaceCapture, index: number): boolean {
  const message = surface.messages[index]
  if (message == null) return false
  if ((message.source.kind === 'acp-pressure' || message.source.kind === 'acp-maintenance')
    && 'form' in message.source && message.source.form === 'notice') return false
  const event = surface.events[index]
  if (message.role !== 'tool' || event?.type !== 'tool/result') return true
  const call = surface.log.findLast(candidate => candidate.seq < event.seq && candidate.type === 'tool/call'
    && candidate.data.turn === event.data.turn && candidate.data.step === event.data.step && candidate.data.callId === message.toolCallId)
  return call?.type !== 'tool/call' || call.data.name !== 'context_compress'
}

/** Literal substring within one eligible derived text block; repeated hits in a node count once. */
export function endpointMatches(surface: SurfaceCapture, endpoint: TextEndpoint): { index: number; role: Message['role']; text: string }[] {
  const matches: { index: number; role: Message['role']; text: string }[] = []
  surface.messages.forEach((message, index) => {
    if (message == null || !isEndpointCandidate(surface, index) || (endpoint.role !== undefined && message.role !== endpoint.role)) return
    const block = message.content.find(block => block.type === 'text' && block.text.includes(endpoint.text))
    if (block?.type === 'text') matches.push({ index, role: message.role, text: block.text })
  })
  return matches
}
