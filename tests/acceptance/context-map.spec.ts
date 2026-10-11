import { expect, it } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { getContextMap } from '../../../dsh-session-tools/src/context-map.ts'
import type { ContextMapInput, ContextMapOutput } from '../../../dsh-session-tools/src/context-map-types.ts'
import { createLoopFixture, HISTORY, seedHistory } from './fixtures.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'acceptance-maintenance': { kind: 'acceptance-maintenance'; form: 'notice'; summary: string }
  }
}

const options = { mapPageSize: 20, mapMaxPageSize: 100, mapMaxSpans: 12, previewChars: 240, outputBytes: 24576 }

it('queries current windows through the real executor and rejects a replaced anchor instead of returning a cached map', async () => {
  const { ctx, agent } = await createLoopFixture([
    [{ type: 'text', text: 'Historical A complete.' }],
    [{ type: 'text', text: 'Middle unchanged.' }],
    [{ type: 'text', text: 'Historical B complete.' }],
  ], async context => {
    await context.plugin(TokenMeter)
    await context.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
  })
  try {
    ctx.tools.register(defineContentToolFixture({
      name: 'acceptance_map', description: 'Execute the public map library with a real tool caller',
      parameters: { request: { type: 'object', additionalProperties: true } },
      async execute(args, exec) {
        const map = await getContextMap(ctx, exec, args.request as ContextMapInput, options)
        return [{ type: 'text', text: JSON.stringify(map) }]
      },
    }))
    let call = 0
    const execute = (input: ContextMapInput) => ctx.tools.execute({
      name: 'acceptance_map', arguments: { request: input }, agent,
      signal: new AbortController().signal, callId: ToolCallId('map-' + ++call),
    })
    const query = async (input: ContextMapInput): Promise<ContextMapOutput> => {
      const result = await execute(input)
      expect(result.isError, JSON.stringify(result)).toBe(false)
      const text = result.content.find(block => block.type === 'text')
      if (text?.type !== 'text') throw new Error('Map executor returned no JSON text')
      return JSON.parse(text.text) as ContextMapOutput
    }
    await seedHistory(agent)
    const first = await query({ view: 'messages', limit: 100, metering: 'require' })
    const original = structuredClone(first)
    expect(first.nodes.map(node => node.seq)).toEqual(agent.session.surface.nodes)
    const measured = ctx.tokenMeter.measure(agent.session)
    expect(first.nodes.map(node => node.estimated_tokens)).toEqual(measured.nodes.map(node => node.tokens))
    const target = first.nodes.find(node => node.preview.startsWith('Completed analysis A:'))
    if (target === undefined) throw new Error('Seed history region A missing')
    const replacement = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Checkpoint A preserves alpha and its failing assertion.' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: SessionSeq(target.seq), endSeq: SessionSeq(target.seq) }, sourceEventSeqs: [SessionSeq(target.seq)] })

    const stale = await execute({ view: 'messages', window: { anchor: target.locator.start, side: 'after' }, limit: 2 })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale)).toMatch(/anchor|refresh|replaced|current Surface/i)
    expect(first).toEqual(original)
    const current = await query({ view: 'messages', limit: 100, metering: 'require' })
    expect(current.snapshot_ref.map_id).not.toBe(first.snapshot_ref.map_id)
    expect(current.snapshot_ref.read_seq).toBeGreaterThan(first.snapshot_ref.read_seq)
    expect(current.nodes.some(node => node.seq === target.seq)).toBe(false)
    expect(current.nodes.find(node => node.seq === replacement.seq)?.surface_index).toBe(target.surface_index)
    expect(current.nodes.find(node => node.preview === HISTORY[1].text)).toBeDefined()
    // The new high-seq checkpoint stays at the old Surface position, not at the log tail.
    expect(current.nodes.findIndex(node => node.seq === replacement.seq)).toBeLessThan(current.nodes.length - 1)
    const window = await query({ view: 'messages', window: { anchor: { seq: replacement.seq, edge: 'before' }, side: 'after' }, limit: 2 })
    expect(window.nodes.map(node => node.seq)).toEqual(current.nodes.slice(target.surface_index, target.surface_index + 2).map(node => node.seq))
    expect(window.window.total).toBe(current.window.total)
    expect(window.nodes[0]?.read_seq).toBe(replacement.seq)
    const notice = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Host maintenance notice, not a new task.' }],
      source: { kind: 'acceptance-maintenance', form: 'notice', summary: 'Fixture maintenance' },
    }), { surfaceOp: 'append' })
    const withNotice = await query({ view: 'messages', limit: 1 })
    expect(withNotice.nodes[0]).toMatchObject({ seq: notice.seq, source: 'acceptance-maintenance', form: 'notice' })
  } finally {
    await ctx.fiber.dispose()
  }
})
