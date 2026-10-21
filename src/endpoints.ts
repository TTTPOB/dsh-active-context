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

interface EndpointMatch {
  index: number
  role: Message['role']
  text: string
  argument?: { tool: string; path: readonly (string | number)[] }
}

/** Yield decoded string values, never JSON keys or scalar source representations. */
function* stringLeaves(value: unknown, path: readonly (string | number)[] = []): Generator<{ text: string; path: readonly (string | number)[] }> {
  if (typeof value === 'string') yield { text: value, path }
  else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* stringLeaves(item, [...path, index])
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* stringLeaves(item, [...path, key])
  }
}

/** Prefer eligible text blocks; only zero text hits allow decoded assistant argument values. */
export function endpointMatches(surface: SurfaceCapture, endpoint: TextEndpoint): EndpointMatch[] {
  const matches: EndpointMatch[] = []
  surface.messages.forEach((message, index) => {
    if (message == null || !isEndpointCandidate(surface, index) || (endpoint.role !== undefined && message.role !== endpoint.role)) return
    const block = message.content.find(block => block.type === 'text' && block.text.includes(endpoint.text))
    if (block?.type === 'text') matches.push({ index, role: message.role, text: block.text })
  })
  if (matches.length > 0 || (endpoint.role !== undefined && endpoint.role !== 'assistant')) return matches
  surface.messages.forEach((message, index) => {
    if (message?.role !== 'assistant' || !isEndpointCandidate(surface, index)) return
    for (const block of message.content) {
      if (block.type !== 'tool-call' || block.name === 'context_compress') continue
      let args: unknown
      try {
        args = JSON.parse(block.arguments)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        continue
      }
      const canonical = block.name === 'run_code' && args !== null && typeof args === 'object'
        && 'code' in args && typeof args.code === 'string' && compressionProgram(args.code) !== undefined
      for (const leaf of stringLeaves(args)) {
        if (canonical && leaf.path.length === 1 && leaf.path[0] === 'code') continue
        if (!leaf.text.includes(endpoint.text)) continue
        matches.push({ index, role: message.role, text: leaf.text, argument: { tool: block.name, path: leaf.path } })
        return
      }
    }
  })
  return matches
}

/** Bounded text with argument paths or allowlisted metadata from the candidate's logged call. */
export function endpointClues(surface: SurfaceCapture, endpoint: TextEndpoint, matches: ReturnType<typeof endpointMatches>) {
  return matches.slice(0, 4).map(match => {
    const start = match.text.indexOf(endpoint.text)
    const before = Array.from(match.text.slice(0, start)).slice(-64).join('')
    const after = Array.from(match.text.slice(start)).slice(0, 160 - Array.from(before).length).join('')
    const text = before + after
    if (match.argument !== undefined) return { role: match.role, tool: match.argument.tool, argument_path: match.argument.path, text }
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
