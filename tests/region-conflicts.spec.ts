import { expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { preflightRegions } from '../src/regions.ts'
import { providerFixture } from './provider-fixture.ts'

const select = (start: string, end = start) => ({ range: [{ text: start }, { text: end }], summary: 'Retained conclusion.' })

it.each([
  { regions: [select('completed 1', 'completed 2'), select('task 2')], relation: 'region 1 is fully contained in region 0', shared: 1 },
  { regions: [select('task 2'), select('completed 1', 'completed 2')], relation: 'region 0 is fully contained in region 1', shared: 1 },
  { regions: [select('completed 1'), select('completed 1')], relation: 'regions 0 and 1 have identical ranges', shared: 1 },
  { regions: [select('task 1', 'task 2'), select('completed 1', 'completed 2')], relation: 'regions 0 and 1 partially overlap', shared: 2 },
])('reports $relation with the actual shared node count and commits an independent region', async ({ regions, relation, shared }) => {
  const f = await providerFixture()
  try {
    const input = f.input([...regions, select('completed 3')])
    const { facts } = await f.submit(input)
    expect(facts.regions.map((fact: { status: string }) => fact.status)).toEqual(['failed', 'failed', 'committed'])
    for (const [index, fact] of facts.regions.slice(0, 2).entries()) {
      expect(fact).toMatchObject({ input_index: index, range: input.regions[index]!.range, expanded: false })
      expect(fact.error).toBe(`ACP: ${relation} after tool-pair expansion (shared node_count: ${shared}); select them again`)
      expect(fact.error).not.toContain('adjacent')
      expect(fact.error).not.toContain('Retained conclusion.')
    }
    expect(facts.execution_order).toEqual([2])
  } finally { await f.dispose() }
})

it('keeps a protected enclosing range in the conflict check and appends accurate containment evidence', async () => {
  const f = await providerFixture()
  try {
    const input = f.input([select('completed 1', 'current task'), select('completed 2')])
    const { facts, regions } = await preflightRegions(f.ctx, f.agent, f.identity, input, f.config)
    expect(regions).toEqual([])
    expect(facts.map(fact => fact.status)).toEqual(['failed', 'failed'])
    expect(facts[0]).toMatchObject({ expanded: false, range: input.regions[0]!.range })
    expect(facts[0]!.error).toContain('protected context')
    expect(facts[0]!.error).toContain('latest_task_input')
    for (const fact of facts) expect(fact.error).toContain('region 1 is fully contained in region 0 after tool-pair expansion (shared node_count: 1)')
  } finally { await f.dispose() }
})

it('reports containment of three real nodes even when the enclosing region contains instructions and a developer message', async () => {
  const f = await providerFixture()
  try {
    const s = f.session
    s.append('tool/result', { turn: 4, step: 1, message: createToolResultMessage({ callId: f.identity.callId, isError: false, content: [] }) },
      { surfaceOp: 'append', sourceEventSeqs: [f.identity.assistantSeq] })
    s.append('step/end', { turn: 4, step: 1 })
    s.append('step/start', { turn: 4, step: 2 })
    const text = (body: string) => s.append('assistant/message', { turn: 4, step: 2, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'text', text: body }], source: { kind: 'model', provider: 'author', model: 'working' },
    }) }, { surfaceOp: 'append' })
    text('Outer history begins')
    s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Live historical instructions' }], source: { kind: 'user', form: 'instructions' } }), { surfaceOp: 'append' })
    text('Inner history begins')
    text('Inner history middle')
    text('Inner history ends')
    s.append('developer/message', { turn: 4, step: 2, message: createMessage({ role: 'developer', content: [{ type: 'text', text: 'Live developer rule' }], source: { kind: 'user' } }) }, { surfaceOp: 'append' })
    text('Outer history ends')
    s.append('step/end', { turn: 4, step: 2 })
    s.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'New task' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    s.append('step/start', { turn: 4, step: 3 })
    const input = f.input([select('Outer history begins', 'Outer history ends'), select('Inner history begins', 'Inner history ends'), select('completed 3')])
    const { facts } = await f.submit(input, { ...f.identity, step: 3 })
    expect(facts.regions.map((fact: { status: string }) => fact.status)).toEqual(['failed', 'failed', 'committed'])
    expect(facts.regions[0]).toMatchObject({ expanded: false, node_count: 7, range: input.regions[0]!.range })
    expect(facts.regions[1]).toMatchObject({ expanded: false, node_count: 3, range: input.regions[1]!.range })
    expect(facts.regions[0].error).toContain('live_instructions')
    expect(facts.regions[0].error).toContain('system_or_developer')
    for (const fact of facts.regions.slice(0, 2)) expect(fact.error).toContain('region 1 is fully contained in region 0 after tool-pair expansion (shared node_count: 3)')
    expect(facts.execution_order).toEqual([2])
  } finally { await f.dispose() }
})
