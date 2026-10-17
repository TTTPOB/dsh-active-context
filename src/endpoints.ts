/** Shared literal matching excludes ACP display nodes, not their Surface membership. */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SurfaceCapture } from './protection.ts'
import type { TextEndpoint } from './types.ts'
import { compressionProgram } from './ptc.ts'

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
  if (call?.type !== 'tool/call') return true
  if (call.data.name === 'context_compress') return false
  if (call.data.name !== 'run_code') return true
  try {
    const args = JSON.parse(call.data.arguments)
    return typeof args?.code !== 'string' || compressionProgram(args.code) === undefined
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return true
  }
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

/** Bounded body context and allowlisted metadata from each candidate's own logged call. */
export function endpointClues(surface: SurfaceCapture, endpoint: TextEndpoint, matches: ReturnType<typeof endpointMatches>) {
  return matches.slice(0, 4).map(match => {
    const start = match.text.indexOf(endpoint.text)
    const before = Array.from(match.text.slice(0, start)).slice(-64).join('')
    const after = Array.from(match.text.slice(start)).slice(0, 160 - Array.from(before).length).join('')
    const text = before + after
    const message = surface.messages[match.index]
    const event = surface.events[match.index]
    const call = message?.role === 'tool' && event?.type === 'tool/result'
      && event.data.message.toolCallId === message.toolCallId
      ? surface.log.findLast((candidate): candidate is SessionEvent<'tool/call'> => candidate.type === 'tool/call'
        && candidate.seq < event.seq && candidate.data.turn === event.data.turn && candidate.data.step === event.data.step
        && candidate.data.callId === message.toolCallId)
      : undefined
    if (call === undefined || typeof call.data.name !== 'string') return { role: match.role, text }
    let read: { offset?: number; limit?: number } | undefined
    if (call.data.name === 'read') {
      try {
        const args = JSON.parse(call.data.arguments)
        if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
          read = {}
          for (const key of ['offset', 'limit'] as const) {
            if (Number.isSafeInteger(args[key]) && args[key] > 0) read[key] = args[key]
          }
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        // Malformed historical arguments cannot supply read metadata.
      }
    }
    return { role: match.role, tool: call.data.name, read, text }
  })
}
