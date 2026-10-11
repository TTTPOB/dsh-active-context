import type { ContextMapOutput } from '../../../dsh-session-tools/src/context-map-types.ts'
import type { CompressInput } from '../../src/types.ts'

export const mapOptions = { mapPageSize: 20, mapMaxPageSize: 100, mapMaxSpans: 12, previewChars: 240, outputBytes: 24576 }
export const summaries = ['A: alpha and its failing assertion are preserved; verify alpha next.', 'B: beta remains to verify; no dependency installation or public command changes.']

export function selection(map: ContextMapOutput): CompressInput {
  return {
    snapshot_ref: map.snapshot_ref,
    regions: [1, 3].map((turn, index) => {
      const nodes = map.nodes.filter(node => node.navigation.turn === turn && node.role !== 'system')
      const first = nodes[0], last = nodes.at(-1)
      if (first === undefined || last === undefined) throw new Error('Historical turn missing from map: ' + turn)
      return { id: index === 0 ? 'older-a' : 'older-b', start: first.locator.start, end: last.locator.end, summary: summaries[index]! }
    }),
  }
}
