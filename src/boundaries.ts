/** Bounded literal clues and safe reselection help over the same protected Surface. */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { expandToolPairs, type ProtectionReason, type SurfaceCapture } from './protection.ts'
import type { TextEndpoint } from './types.ts'
import { endpointMatches } from './endpoints.ts'

type Protection = ReadonlyMap<SessionSeq, readonly ProtectionReason[]>
type ProtectionClass = 'current_step' | 'instructions' | 'latest_task_input' | 'latest_task_checkpoint'

/** A clue is literal even when no bounded unique endpoint exists. */
export interface LiteralClue {
  readonly role: Message['role'] | null
  readonly text_excerpt: string | null
  readonly unique: boolean
}

function bodyBlocks(message: Message): string[] {
  const blocks = message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
  const kind: string = message.source.kind
  if (kind === 'compact-checkpoint' && blocks.length > 2
    && blocks[0]!.endsWith('<compacted-summary>') && blocks.at(-1) === '</compacted-summary>') return blocks.slice(1, -1)
  if (kind !== 'agent-message') return blocks
  // Relays carry the sender wrapper separately from the actual task body.
  const bodies = blocks.map(text => {
    const wrapper = /^Agent [^\n]* sent a message:\s*/.exec(text)
    return wrapper === null ? text : text.slice(wrapper[0].length)
  }).filter(text => text.length > 0)
  return bodies.length > 0 ? bodies : blocks
}

/** Prefer a real body block and search short unmodified substrings with endpoint semantics. */
export function literalClue(surface: SurfaceCapture, index: number, maxChars = 160): LiteralClue {
  const message = surface.messages[index]
  if (message == null) return { role: null, text_excerpt: null, unique: false }
  const blocks = bodyBlocks(message)
  const unique = (text: string) => {
    const matches = endpointMatches(surface, { text, role: message.role })
    return text.length > 0 && matches.length === 1 && matches[0]!.index === index
  }
  for (const block of blocks) {
    const chars = Array.from(block)
    const lengths = [...new Set([48, 80, maxChars].filter(length => length <= maxChars))]
    for (const length of lengths) {
      const prefix = chars.slice(0, length).join('')
      if (unique(prefix)) return { role: message.role, text_excerpt: prefix, unique: true }
    }
    for (const length of lengths) {
      // Line starts, middle and end stay inside one original block.
      const offsets = [...chars.flatMap((char, offset) => char === '\n' ? [offset + 1] : []), Math.floor(chars.length / 2), Math.max(0, chars.length - length)]
      for (const offset of offsets) {
        const text = chars.slice(offset, offset + length).join('')
        if (unique(text)) return { role: message.role, text_excerpt: text, unique: true }
      }
    }
  }
  return { role: message.role, text_excerpt: blocks.length === 0 ? null : Array.from(blocks[0]!).slice(0, maxChars).join(''), unique: false }
}

function protectionClass(reasons: readonly ProtectionReason[]): ProtectionClass {
  if (reasons.includes('current_step')) return 'current_step'
  if (reasons.includes('system_or_developer') || reasons.includes('live_instructions')) return 'instructions'
  return reasons.includes('latest_task_checkpoint') ? 'latest_task_checkpoint' : 'latest_task_input'
}

/** Labels are local to this map; first/last clues delimit consecutive same-class nodes. */
export function protectionGroups(surface: SurfaceCapture, protection: Protection) {
  const groups: { label: string; classification: ProtectionClass; start: number; end: number; count: number; hasLatestTask: boolean }[] = []
  surface.seqs.forEach((seq, index) => {
    const reasons = protection.get(seq)
    if (reasons === undefined) return
    const classification = protectionClass(reasons)
    const previous = groups.at(-1)
    if (previous?.classification === classification && previous.end === index - 1) {
      previous.end = index
      previous.count++
      previous.hasLatestTask ||= reasons.includes('latest_task_input') || reasons.includes('latest_task_checkpoint')
    } else groups.push({ label: `B${groups.length + 1}`, classification, start: index, end: index, count: 1, hasLatestTask: reasons.includes('latest_task_input') || reasons.includes('latest_task_checkpoint') })
  })
  return groups.map(group => ({
    ...group,
    text: `${group.label} ${group.classification} (${group.count} node${group.count === 1 ? '' : 's'}): `
      + [group.start, ...(group.end === group.start ? [] : [group.end])].map(index => {
        const clue = literalClue(surface, index, 80)
        return `${clue.role ?? 'no role'} ${clue.text_excerpt === null ? '[no text block]' : JSON.stringify(clue.text_excerpt)}${clue.unique ? '' : ' [no unique short literal]'}`
      }).join(' → '),
  }))
}

/** Return bounded selectable fragments, never summaries, inside the original submitted range. */
export function safeSplitRanges(surface: SurfaceCapture, protection: Protection, session: Session, start: number, end: number) {
  if (surface.seqs.slice(start, end + 1).some(seq => protection.get(seq)?.includes('current_step'))) {
    return { ranges: [], unavailable: 'current_step is a hard rejection; no split suggestions' }
  }
  const safe = (left: number, right: number) => {
    const expanded = expandToolPairs(surface.messages, left, right)
    return !expanded.missingCounterpart && expanded.start >= start && expanded.end <= end
      && !surface.seqs.slice(expanded.start, expanded.end + 1).some(seq => protection.has(seq))
      && toolPairingBalancedBefore(session, surface.seqs[expanded.start]!)
      && toolPairingBalancedAfter(session, surface.seqs[expanded.end]!) ? expanded : undefined
  }
  const ranges: [TextEndpoint, TextEndpoint][] = []
  let unavailable = 0
  for (let index = start; index <= end;) {
    if (safe(index, index) === undefined) { index++; continue }
    const first = index
    while (index <= end && safe(index, index) !== undefined) index++
    const last = index - 1
    const endpoints = Array.from({ length: last - first + 1 }, (_, offset) => ({ index: first + offset, clue: literalClue(surface, first + offset) }))
      .filter(item => item.clue.unique && item.clue.role !== null && item.clue.text_excerpt !== null)
    const left = endpoints[0]
    const right = endpoints.at(-1)
    const expanded = left === undefined || right === undefined ? undefined : safe(left.index, right.index)
    if (expanded === undefined || expanded.start < first || expanded.end > last) { unavailable++; continue }
    ranges.push([left!, right!].map(item => ({ role: item.clue.role!, text: item.clue.text_excerpt! })) as [TextEndpoint, TextEndpoint])
  }
  return { ranges: ranges.slice(0, 4), omitted_ranges: Math.max(0, ranges.length - 4),
    unavailable: unavailable > 0 ? `${unavailable} fragment(s) have no unique selectable endpoints` : ranges.length === 0 ? 'no fragment fits original range, protection and complete balanced tool spans' : undefined }
}
