import { expect, it, vi } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createLoopFixture, runTurn } from './loop-fixtures/agent-loop.ts'
import { loadActiveContext } from './loop-fixtures/loader.ts'
import { preflightRegions, renderBatchFacts } from '../src/regions.ts'
import { providerFixture } from './provider-fixture.ts'

const literal = '550: fig\n551: \n552: # %% [markdown] id="anchored-case-guide"'
const select = (text: string, role?: 'tool') => ({ range: [0, 1].map(() => role === undefined ? { text } : { text, role }), summary: 'PRIVATE_SUMMARY_NOT_IN_DIAGNOSTICS' })
const diagnostics = (error: string) => JSON.parse(error.slice(error.indexOf('{')))

it('distinguishes actual same-file read candidates by their own call ranges and literal body context', async () => {
  const bodies = [
    '<path>/same/file.py</path>\n<content>\n' + 'earlier file lines\n'.repeat(200) + '549: earlier plot setup\n' + literal + '\n553: older trailing body\n</content>',
    '<path>/same/file.py</path>\n<content>\n' + literal + '\n553: later guide body\n</content>',
  ]
  const input = { regions: [select(literal, 'tool')] }
  const calls = [{ offset: 415, limit: 145 }, { offset: 550, limit: 107 }].map(args => ({ type: 'tool-call' as const,
    id: ToolCallId('reused-read-id'), name: 'read', arguments: JSON.stringify({ file_path: '/same/file.py', ...args, headers: 'PRIVATE_HEADERS', password: 'PRIVATE_PASSWORD' }),
  }))
  const f = await createLoopFixture([
    [calls[0]!], [calls[1]!], [{ type: 'text', text: 'Read work complete.' }],
    [{ type: 'tool-call', id: ToolCallId('ambiguous-read-compress'), name: 'context_compress', arguments: JSON.stringify(input) }],
    request => {
      const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'ambiguous-read-compress')
      if (result?.content[0]?.type !== 'text') throw new Error('Missing ambiguous result')
      const facts = JSON.parse(result.content[0].text)
      expect(facts.status).toBe('failed')
      expect(facts.regions[0]).toMatchObject({ input_index: 0, status: 'failed', range: input.regions[0]!.range })
      const error = facts.regions[0].error
      expect(error).toContain('endpoint 0 is ambiguous')
      const detail = diagnostics(error)
      expect(detail).toMatchObject({ text: literal, role: 'tool', candidate_count: 2, shown: 2 })
      expect(detail.clues.map((clue: { role: string; tool: string; read: object }) => ({ role: clue.role, tool: clue.tool, read: clue.read }))).toEqual([
        { role: 'tool', tool: 'read', read: { offset: 415, limit: 145 } },
        { role: 'tool', tool: 'read', read: { offset: 550, limit: 107 } },
      ])
      expect(detail.clues[0].text).toContain('549: earlier plot setup')
      expect(detail.clues[1].text).toContain('553: later guide body')
      for (const [index, clue] of detail.clues.entries()) {
        expect(clue.text).toContain(literal)
        expect(bodies[index]!).toContain(clue.text)
        expect(Array.from(clue.text).length).toBeLessThanOrEqual(160)
        expect(clue).not.toHaveProperty('seq')
        expect(clue).not.toHaveProperty('call_id')
      }
      for (const secret of ['PRIVATE_HEADERS', 'PRIVATE_PASSWORD', 'PRIVATE_SUMMARY_NOT_IN_DIAGNOSTICS', 'file_path', 'arguments']) expect(error).not.toContain(secret)
      expect(error.length).toBeLessThan(1500)
      return [{ type: 'text', text: 'Need a more distinctive literal endpoint.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
  })
  try {
    f.ctx.tools.register(defineTool({ name: 'read', description: 'Read diagnostic fixture', parameters: {
      file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' }, headers: { type: 'string' }, password: { type: 'string' },
    }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => bodies[args.offset === 415 ? 0 : 1]!,
    }))
    await runTurn(f.agent, 'Read the file twice')
    await runTurn(f.agent, 'Compress the completed reads')
    expect(f.adapter.requests).toHaveLength(5)
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
  } finally { await f.ctx.fiber.dispose() }
})

it('bounds candidate count and body clues, falls back to actual role without an attributable tool, and keeps render facts', async () => {
  const f = await providerFixture()
  try {
    const derive = f.session.deriveEventMessage.bind(f.session)
    const nodes = new Set(f.session.surface.nodes.slice(0, 6))
    vi.spyOn(f.session, 'deriveEventMessage').mockImplementation(event => nodes.has(event.seq)
      ? createToolResultMessage({ callId: ToolCallId('unattributed'), isError: false, content: [{ type: 'text', text: 'wrapper '.repeat(1000) + 'shared literal ' + event.seq + ' tail '.repeat(1000) }] })
      : derive(event))
    const input = f.input([select('shared literal')])
    const { facts } = await preflightRegions(f.ctx, f.agent, f.identity, input, f.config)
    const detail = diagnostics(facts[0]!.error!)
    expect(detail).toMatchObject({ text: 'shared literal', candidate_count: 6, shown: 4 })
    expect(detail.clues).toHaveLength(4)
    for (const clue of detail.clues) {
      expect(clue.role).toBe('tool')
      expect(clue).not.toHaveProperty('tool')
      expect(clue).not.toHaveProperty('read')
      expect(Array.from(clue.text).length).toBeLessThanOrEqual(160)
    }
    const rendered = renderBatchFacts({ status: 'all_failed', executionOrder: [], regions: facts.map(fact => ({ ...fact, error: fact.error!.repeat(20) })) }, { ...f.config, resultMaxBytes: 2000 })
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(2000)
    expect(JSON.parse(rendered).regions[0]).toMatchObject({ input_index: 0, status: 'failed', range: input.regions[0]!.range, nodes: 0 })
    expect(rendered).not.toContain('PRIVATE_SUMMARY_NOT_IN_DIAGNOSTICS')
  } finally { await f.dispose() }
})
