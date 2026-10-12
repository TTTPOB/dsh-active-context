import type { Session } from '@deepseek-ai/dsh-session'
import type { CompressInput, TextEndpoint } from '../../src/types.ts'

export const summaries = ['A: alpha and its failing assertion are preserved; verify alpha next.', 'B: beta remains to verify; no dependency installation or public command changes.']

/** Select known synthetic historical turns by their current derived text, not persisted locators. */
export function selection(session: Session): CompressInput {
  return {
    regions: [1, 3].map((turn, index) => {
      let currentTurn = 0
      const messages = session.snapshotEvents().flatMap(event => {
        if (event.type === 'turn/start') currentTurn = event.data.turn
        if (currentTurn !== turn || !session.surface.nodes.includes(event.seq)) return []
        const message = session.deriveEventMessage(event)
        return message !== null && message.role !== 'system' ? [message] : []
      })
      const endpoint = (message: typeof messages[number] | undefined): TextEndpoint => {
        const text = message?.content.find(block => block.type === 'text')
        if (message === undefined || text?.type !== 'text') throw new Error('Historical turn has no text endpoint: ' + turn)
        return { text: text.text.slice(0, 80), role: message.role }
      }
      return { range: [endpoint(messages[0]), endpoint(messages.at(-1))], summary: summaries[index]! }
    }),
  }
}
