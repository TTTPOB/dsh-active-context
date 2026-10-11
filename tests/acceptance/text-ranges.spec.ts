import { expect, it, vi } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { preflightRegions } from '../../src/regions.ts'
import type { TextEndpoint } from '../../src/types.ts'
import { providerFixture } from '../provider-fixture.ts'

const region = (start: TextEndpoint, end = start) => ({ range: [start, end], summary: 'Preserve the completed conclusion.' })

it('counts repeated hits and multiple blocks in one node once, and includes both full endpoint nodes', async () => {
  const f = await providerFixture()
  try {
    const derive = f.session.deriveEventMessage.bind(f.session)
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      const message = derive(event)
      return event.seq === f.old[0] && message !== null ? { ...message, content: [
        { type: 'text', text: '  Exact α Exact α  ' }, { type: 'text', text: 'Exact α tail' },
      ] } : message
    })
    const same = await preflightRegions(f.ctx, f.agent, f.identity, f.input([region({ text: 'Exact α' }, { text: 'α tail' })]), f.config)
    expect(same[0]!.seqs).toEqual([f.old[0]])
    expect(same[0]!.messages[0]!.content).toHaveLength(2)
    const whitespace = await preflightRegions(f.ctx, f.agent, f.identity, f.input([region({ text: '  ' })]), f.config)
    expect(whitespace[0]!.seqs).toEqual([f.old[0]])
    const across = await preflightRegions(f.ctx, f.agent, f.identity, f.input([region({ text: 'Exact α' }, { text: 'completed 3 ' })]), f.config)
    const nodes = f.session.surface.nodes
    expect(across[0]!.seqs).toEqual(nodes.slice(nodes.indexOf(f.old[0]!), nodes.indexOf(f.old[2]!) + 1))
  } finally { await f.dispose() }
})

it('rejects a missing or ambiguous endpoint in the whole batch without effects and bounds original clues', async () => {
  const f = await providerFixture()
  try {
    const before = f.session.snapshotEvents()
    for (const endpoint of [{ text: 'not present anywhere' }, { text: 'details' }, { text: 'Completed 1 ' }, { text: '' }]) {
      const result = await f.submit(f.input([f.input().regions[0]!, region(endpoint)]))
      expect(result.result.isError).toBe(true)
      expect(f.session.snapshotEvents()).toEqual(before)
      const diagnostic = result.result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      expect(diagnostic).toMatch(/no match|ambiguous|must not be empty/)
      expect(diagnostic).not.toMatch(/"seq"|"ref"|"id"|occurrence/)
      expect(Buffer.byteLength(diagnostic)).toBeLessThan(3000)
      if (endpoint.text === 'details') expect(diagnostic).toContain('assistant')
    }
    expect(f.adapter.calls).toBe(0)
  } finally { await f.dispose() }
})

it('checks end uniqueness globally, role only limits its own endpoint, and preserves literal whitespace', async () => {
  const f = await providerFixture()
  try {
    const derive = f.session.deriveEventMessage.bind(f.session)
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      const message = derive(event)
      if (message === null) return null
      if (event.seq === f.old[0]) return { ...message, content: [{ type: 'text', text: 'shared ending; unique first  ' }] }
      if (event.seq === f.old[2]) return { ...message, content: [{ type: 'text', text: 'shared ending; unique last' }] }
      if (message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === 'task 1')) {
        return { ...message, content: [{ type: 'text', text: 'unique last' }] }
      }
      return message
    })
    const check = (start: TextEndpoint, end: TextEndpoint) => preflightRegions(f.ctx, f.agent, f.identity, f.input([region(start, end)]), f.config)
    await expect(check({ text: 'unique last', role: 'assistant' }, { text: 'shared ending' })).rejects.toThrow(/endpoint 1 is ambiguous/)
    await expect(check({ text: 'unique last' }, { text: 'unique last' })).rejects.toThrow(/endpoint 0 is ambiguous/)
    const resolved = await check({ text: 'first  ', role: 'assistant' }, { text: 'unique last', role: 'assistant' })
    expect(resolved[0]!.seqs).toContain(f.old[1])
    expect(resolved[0]!.messages.some(message => message?.role === 'user')).toBe(true)
    await expect(check({ text: ' first   ' }, { text: 'unique last', role: 'assistant' })).rejects.toThrow(/no match/)
    await expect(check({ text: 'unique last', role: 'assistant' }, { text: 'unique first' })).rejects.toThrow(/reversed/)
  } finally { await f.dispose() }
})

it('matches only derived individual text blocks, including results, and still enforces complete tool pairs', async () => {
  const f = await providerFixture()
  try {
    const derive = f.session.deriveEventMessage.bind(f.session)
    const callId = ToolCallId('historical-tool')
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'left boundary' }, { type: 'text', text: 'right boundary' },
      { type: 'reasoning', text: 'reasoning-only endpoint' },
      { type: 'tool-call', id: callId, name: 'historical', arguments: '{"value":"arguments-only endpoint"}' },
    ]
    const call = createMessage({ role: 'assistant', content: blocks, source: { kind: 'model', provider: 'synthetic', model: 'variable' } })
    const result = createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'result boundary' }] })
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => {
      if (event.seq === f.old[0]) return call
      if (event.seq === f.old[1]) return result
      return derive(event)
    })
    for (const text of ['boundaryright', 'boundary\nright', 'reasoning-only endpoint', 'arguments-only endpoint', 'completed 1 ']) {
      await expect(preflightRegions(f.ctx, f.agent, f.identity, f.input([region({ text })]), f.config)).rejects.toThrow(/no match/)
    }
    await expect(preflightRegions(f.ctx, f.agent, f.identity, f.input([region({ text: 'result boundary' })]), f.config)).rejects.toThrow(/no selected call/)
    await expect(preflightRegions(f.ctx, f.agent, f.identity, f.input([region({ text: 'left boundary' })]), f.config)).rejects.toThrow(/splits/)
    const resolved = await preflightRegions(f.ctx, f.agent, f.identity, f.input([region({ text: 'left boundary', role: 'assistant' }, { text: 'result boundary', role: 'tool' })]), f.config)
    expect(resolved[0]!.seqs).toContain(f.old[0])
    expect(resolved[0]!.seqs).toContain(f.old[1])
  } finally { await f.dispose() }
})

it('resolves current replacement text at its Surface position, never the shadowed Log or numeric seq order', async () => {
  const f = await providerFixture()
  try {
    const replacement = f.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Current checkpoint retains completed 1 and unique constraint.' }],
      source: { kind: 'user', form: 'notice', summary: 'Synthetic replacement' },
    }), { surfaceOp: { op: 'replace', startSeq: f.old[0]!, endSeq: f.old[0]! }, sourceEventSeqs: [f.old[0]!] })
    f.session.append('step/end', { turn: 4, step: 1 })
    f.session.append('step/start', { turn: 4, step: 2 })
    const identity = { ...f.identity, step: 2 }
    const resolved = await preflightRegions(f.ctx, f.agent, identity, f.input([region({ text: 'completed 1' }, { text: 'completed 3' })]), f.config)
    expect(resolved[0]!.start).toBe(replacement.seq)
    expect(resolved[0]!.end).toBe(f.old[2])
    expect(resolved[0]!.start).toBeGreaterThan(resolved[0]!.end)
    expect(resolved[0]!.seqs).not.toContain(f.old[0])
    await expect(preflightRegions(f.ctx, f.agent, identity, f.input([region({ text: 'completed 1 details' })]), f.config)).rejects.toThrow(/no match/)
  } finally { await f.dispose() }
})

it('rejects wrong endpoint counts, overlap and adjacency before native writes', async () => {
  const f = await providerFixture()
  try {
    const before = f.session.snapshotEvents()
    const first = region({ text: 'completed 1' })
    for (const regions of [
      [{ ...first, range: [{ text: 'completed 1' }] }],
      [first, first],
      [region({ text: 'task 1' }), first],
      [region({ text: 'completed 1' }, { text: 'completed 2' }), region({ text: 'completed 2' }, { text: 'completed 3' })],
    ]) {
      const result = await f.submit(f.input(regions))
      expect(result.result.isError).toBe(true)
      expect(f.session.snapshotEvents()).toEqual(before)
    }
  } finally { await f.dispose() }
})
