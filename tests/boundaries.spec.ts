import { expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { createAgentMessage } from '../../deepseek-harness/packages/subagent/subagent/src/continuation-messages.ts'
import { literalClue, protectionGroups, safeSplitRanges } from '../src/boundaries.ts'
import { protectedNodes, type SurfaceCapture } from '../src/protection.ts'
import { preflightRegions } from '../src/regions.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AcpConfigSchema } from '../src/config.ts'
import { endpointMatches, isEndpointCandidate } from '../src/endpoints.ts'
import { providerFixture } from './provider-fixture.ts'
import { createLoopFixture, runTurn } from './loop-fixtures/agent-loop.ts'
import { loadActiveContext } from './loop-fixtures/loader.ts'
import { configFor, largeTask, notices, reminderFixture } from './reminder-fixtures/fixture.ts'
import type { TextEndpoint } from '../src/types.ts'

function capture(session: Session): SurfaceCapture {
  const log = session.snapshotEvents()
  const seqs = [...session.surface.nodes]
  const events = seqs.map(seq => log[seq]!)
  return { seqs, events, messages: events.map(event => session.deriveEventMessage(event)), log }
}

const body = (message: { content: readonly { type: string; text?: string }[] }) => message.content.map(block => block.text ?? '').join('\n')

it('real Loader/Loop maps the latest relay body, rejects a crossing range and commits independent history', async () => {
  const task = 'Parent relay task: retain the exact ACP boundary policy. ' + 'relay details '.repeat(3000)
  const crossed = { range: [{ text: 'Before relay phase', role: 'assistant' as const }, { text: 'After relay phase', role: 'assistant' as const }], summary: 'Crossing summary must never commit.' }
  const independent = { range: [{ text: 'Independent phase', role: 'assistant' as const }, { text: 'Independent phase', role: 'assistant' as const }], summary: 'Independent conclusion retained.' }
  const input = { regions: [crossed, independent] }
  const f = await createLoopFixture([
    [{ type: 'text', text: 'Independent phase ' + 'old details '.repeat(700) }],
    [{ type: 'text', text: 'Before relay phase ' + 'old details '.repeat(700) }],
    [{ type: 'text', text: 'After relay phase ' + 'old details '.repeat(700) }],
    [{ type: 'tool-call', id: ToolCallId('map-compress'), name: 'context_compress', arguments: JSON.stringify(input) }],
    [{ type: 'text', text: 'Finished with protected relay intact.' }],
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false }, acp: { pressureRoutes: [
      { provider: 'acceptance', model: 'scripted', nudgeAtTokens: 10_000, resetBelowTokens: 200 },
    ] } })
  })
  try {
    for (const text of ['Keep instruction alpha.', 'Keep instruction beta.']) f.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user', form: 'instructions' },
    }), { surfaceOp: 'append' })
    await runTurn(f.agent, 'Independent historical input.')
    await runTurn(f.agent, 'Historical input before the relay.')
    f.agent.followup(createAgentMessage(f.agent, [{ type: 'text', text: task }]))
    await f.agent.whenIdle()
    expect(notices(f.agent.session)).toHaveLength(0)
    f.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compress completed history now.' }], source: { kind: 'user', form: 'notice', summary: 'Maintenance' } }))
    await f.agent.whenIdle()
    const notice = notices(f.agent.session)[0]!
    expect(body(notice.data)).toContain('latest_task_input (1 node): user "Parent relay task:')
    expect(body(notice.data)).not.toContain('sent a message:')
    expect(body(notice.data)).toContain('B1 instructions (3 nodes)')
    expect(body(notice.data)).toContain('New input/current entering Step is not in this pre-step Surface map and cannot be selected.')
    expect(body(notice.data)).not.toContain(task)
    const result = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'map-compress')!
    if (result.type !== 'tool/result') throw new Error('Missing compression result')
    const facts = JSON.parse(body(result.data.message))
    expect(facts.status).toBe('partial')
    expect(facts.regions.map((item: { status: string }) => item.status)).toEqual(['failed', 'committed'])
    const error: string = facts.regions[0].error
    expect(error).toContain('Parent relay task:')
    expect(error).not.toContain('sent a message:')
    expect(error).toContain('latest_task_input')
    const suggestions = JSON.parse(error.match(/Safe split ranges .*?: (\{.*\})\. Each range/)![1]!)
    expect(suggestions.ranges).toHaveLength(2)
    expect(JSON.stringify(suggestions)).not.toContain('summary')
    const author = f.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')!
    if (author.type !== 'assistant/message') throw new Error('Missing final assistant')
    const identity = { sessionId: f.agent.id, turn: author.data.turn, step: author.data.step, assistantSeq: author.seq, callId: ToolCallId('reselect'), provider: 'acceptance', model: 'scripted' }
    const ranges: TextEndpoint[][] = suggestions.ranges
    const reselection = await preflightRegions(f.ctx, f.agent, identity, { regions: ranges.map(range => ({ range, summary: 'Separately authored conclusion.' })) }, AcpConfigSchema({}))
    expect(reselection.regions).toHaveLength(2)
    expect(reselection.facts.every(item => item.status === 'not_attempted')).toBe(true)
    const finer = await preflightRegions(f.ctx, f.agent, identity, { regions: [{ range: [ranges[0]![0]!, ranges[0]![0]!], summary: 'Finer selection.' }] }, AcpConfigSchema({}))
    expect(finer.regions).toHaveLength(1)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    expect(f.adapter.requests).toHaveLength(5)
  } finally { await f.ctx.fiber.dispose() }
})

it('real Loop submits tool-role split suggestions unchanged after their own returned diagnostic', async () => {
  const input = { regions: [{ range: [{ text: 'Historical tool input A', role: 'user' as const }, { text: 'Historical result B boundary', role: 'tool' as const }], summary: 'Crossed instruction must not commit.' }] }
  let suggested: { range: TextEndpoint[]; summary: string }[] = []
  const f = await createLoopFixture([
    [{ type: 'tool-call', id: ToolCallId('split-tool-a'), name: 'historical_split_tool', arguments: '{"label":"A"}' }],
    [{ type: 'reasoning', text: 'Historical A phase finished.' }],
    [{ type: 'tool-call', id: ToolCallId('split-tool-b'), name: 'historical_split_tool', arguments: '{"label":"B"}' }],
    [{ type: 'text', text: 'Historical B phase finished.' }],
    [{ type: 'tool-call', id: ToolCallId('split-crossing'), name: 'context_compress', arguments: JSON.stringify(input) }],
    request => {
      const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'split-crossing')
      if (result === undefined) throw new Error('Missing returned diagnostic')
      const facts = JSON.parse(body(result))
      expect(facts.status).toBe('all_failed')
      const help = JSON.parse(facts.regions[0].error.match(/Safe split ranges .*?: (\{.*\})\. Each range/)[1])
      expect(help.ranges).toHaveLength(2)
      expect(help.ranges.every((range: TextEndpoint[]) => range.at(-1)?.role === 'tool')).toBe(true)
      expect(JSON.stringify(help)).not.toContain('summary')
      suggested = help.ranges.map((range: TextEndpoint[], index: number) => ({ range, summary: 'Separately authored fragment ' + index }))
      for (const region of suggested) expect(body(result)).toContain(region.range.at(-1)!.text)
      return [{ type: 'tool-call', id: ToolCallId('split-retry'), name: 'context_compress', arguments: JSON.stringify({ regions: suggested }) }]
    },
    [{ type: 'text', text: 'Retried the suggested ranges successfully.' }],
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
    ctx.tools.register(defineTool({ name: 'historical_split_tool', description: 'Historical split fixture', parameters: { label: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => 'Historical result ' + args.label + ' boundary; ' + 'complete tool details '.repeat(700),
    }))

  })
  try {
    await runTurn(f.agent, 'Historical tool input A')
    f.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Persistent instruction between completed tools.' }], source: { kind: 'user', form: 'instructions' },
    }), { surfaceOp: 'append' })
    await runTurn(f.agent, 'Historical tool input B')
    await runTurn(f.agent, 'Current task: split around the persistent instruction.')
    expect(f.agent.session.snapshotEvents().at(-1), JSON.stringify(f.agent.session.snapshotEvents().at(-1))).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const result = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'split-retry')!
    if (result.type !== 'tool/result') throw new Error('Missing retry result')
    const facts = JSON.parse(body(result.data.message))
    expect(facts.status).toBe('batch_success')
    expect(facts.regions.map((item: { range: TextEndpoint[] }) => item.range)).toEqual(suggested.map(item => item.range))
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(2)
    expect(f.adapter.requests).toHaveLength(7)
    expect(body(f.agent.session.deriveMessages().find(message => body(message).includes('Persistent instruction between completed tools.'))!)).toContain('Persistent instruction')
  } finally { await f.ctx.fiber.dispose() }
})

it('uses one-block literal semantics, body-first relay clues, strict classes, and truthful nonunique/no-text clues', () => {
  const session = Session.create(SessionId('literal-clues'))
  session.append('turn/start', { turn: 1 })
  const append = (text: string | null, instructions = false) => session.append('user/message', createUserMessage({
    content: text === null ? [] : [{ type: 'text', text }], source: instructions ? { kind: 'user', form: 'instructions' } : { kind: 'user', form: 'notice', summary: 'Historical context' },
  }), { surfaceOp: 'append' })
  append('Repeated prefix '.repeat(20) + 'unique middle body\nend', true)
  append('Repeated prefix '.repeat(20) + 'other middle body\nend')
  append('Identical repeated body', true)
  append('Identical repeated body')
  append(null, true)
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Agent sender sent a message:\n\nActual single-block relay body.' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('sender') } }), { surfaceOp: 'append' })
  const task = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Task and instruction body.' }], source: { kind: 'user', form: 'instructions' } }), { surfaceOp: 'append' })
  const surface = capture(session)
  const protection = protectedNodes(surface, { turn: 1, step: 1 }, AcpConfigSchema({}), 'pre-step')
  const clue = literalClue(surface, 0)
  expect(clue.unique).toBe(true)
  expect(surface.messages[0]!.content.some(block => block.type === 'text' && block.text.includes(clue.text_excerpt!))).toBe(true)
  expect(clue.text_excerpt).toContain('unique middle')
  expect(literalClue(surface, 2)).toMatchObject({ text_excerpt: 'Identical repeated body', unique: false })
  expect(literalClue(surface, 4)).toMatchObject({ text_excerpt: null, unique: false })
  expect(literalClue(surface, 5)).toMatchObject({ text_excerpt: 'Actual single-block relay body.', unique: true })
  expect(protection.get(task.seq)).toEqual(['live_instructions', 'latest_task_input'])
  const groups = protectionGroups(surface, protection)
  expect(groups.at(-1)?.classification).toBe('instructions')
  expect(groups.map(group => group.text).join('\n')).toContain('[no unique short literal]')
  expect(groups.map(group => group.text).join('\n')).toContain('[no text block]')
  expect(() => protectedNodes(surface, { turn: 1, step: 2 }, AcpConfigSchema({}), 'pre-step')).toThrow(/actual pre-step position/)
  session.append('step/start', { turn: 1, step: 1 })
  append('Current-step instruction.', true)
  const current = capture(session)
  expect(protectionGroups(current, protectedNodes(current, { turn: 1, step: 1 }, AcpConfigSchema({}))).at(-1)?.classification).toBe('current_step')
  expect(() => protectedNodes(current, { turn: 1, step: 2 }, AcpConfigSchema({}), 'pre-step')).toThrow(/actual pre-step position/)
})

it('excludes only ACP displays by source and exact call attribution, not ordinary notices or reused call IDs', () => {
  const session = Session.create(SessionId('endpoint-display-filter'))
  const literal = 'Real user task body: exact preserved endpoint.'
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: literal }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  for (const kind of ['acp-pressure', 'acp-maintenance'] as const) session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: literal }], source: { kind, form: 'notice', summary: 'ACP display' },
  }), { surfaceOp: 'append' })
  expect(endpointMatches(capture(session), { text: literal, role: 'user' })).toHaveLength(1)
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: literal }], source: { kind: 'user', form: 'notice', summary: 'Ordinary notice' } }), { surfaceOp: 'append' })
  expect(endpointMatches(capture(session), { text: literal, role: 'user' })).toHaveLength(2)
  const id = ToolCallId('reused-call')
  for (const [step, name] of [[1, 'context_compress'], [2, 'ordinary_tool']] as const) {
    session.append('tool/call', { turn: 1, step, callId: id, name, arguments: '{}' })
    session.append('tool/result', { turn: 1, step, message: createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: 'Exact ordinary tool result body' }] }) }, { surfaceOp: 'append' })
  }
  const surface = capture(session)
  expect(isEndpointCandidate(surface, 1)).toBe(false)
  expect(isEndpointCandidate(surface, 2)).toBe(false)
  expect(isEndpointCandidate(surface, 3)).toBe(true)
  expect(isEndpointCandidate(surface, 4)).toBe(false)
  expect(isEndpointCandidate(surface, 5)).toBe(true)
  expect(endpointMatches(surface, { text: 'Exact ordinary tool result body', role: 'tool' }).map(match => match.index)).toEqual([5])
  expect(literalClue(surface, 0)).toMatchObject({ unique: false })
  expect(literalClue(surface, 4)).toMatchObject({ unique: false })
})

it('keeps excluded ACP display nodes inside a selected range and in protection checks', async () => {
  const f = await providerFixture()
  try {
    const display = f.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ACP display-only text; not an endpoint.' }], source: { kind: 'acp-maintenance', form: 'notice', summary: 'ACP status' },
    }), { surfaceOp: { op: 'replace', startSeq: f.old[1]!, endSeq: f.old[1]! }, sourceEventSeqs: [f.old[1]!] })
    f.session.append('step/end', { turn: 4, step: 1 })
    f.session.append('step/start', { turn: 4, step: 2 })
    const identity = { ...f.identity, step: 2 }
    const range = [{ text: 'completed 1', role: 'assistant' as const }, { text: 'completed 3', role: 'assistant' as const }]
    const selected = await preflightRegions(f.ctx, f.agent, identity, { regions: [{ range, summary: 'Retained conclusions.' }] }, f.config)
    expect(selected.regions[0]!.seqs).toContain(display.seq)
    const endpoint = { text: 'ACP display-only text', role: 'user' as const }
    const rejected = await preflightRegions(f.ctx, f.agent, identity, { regions: [{ range: [endpoint, endpoint], summary: 'Display selection.' }] }, f.config)
    expect(rejected.facts[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('has no match') })
    const currentNotice = f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'ACP current-step map text' }], source: { kind: 'acp-pressure', form: 'notice', summary: 'Pressure' } }), { surfaceOp: 'append' })
    const surface = capture(f.session)
    expect(isEndpointCandidate(surface, surface.seqs.indexOf(currentNotice.seq))).toBe(false)
    expect(protectedNodes(surface, identity, f.config).get(currentNotice.seq)).toEqual(['current_step'])
  } finally { await f.dispose() }
})

it('does not suggest fragments of a tool span that encloses protection, lacks a pair, or leaves the original range', () => {
  const session = Session.create(SessionId('split-spans'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const id = ToolCallId('enclosing-pair')
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [
    { type: 'text', text: 'Historical call' }, { type: 'tool-call', id, name: 'old-tool', arguments: '{}' },
  ] }) }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Protected intervening instruction' }], source: { kind: 'user', form: 'instructions' } }), { surfaceOp: 'append' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: 'Historical result' }] }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  const surface = capture(session)
  const protection = protectedNodes(surface, { turn: 1, step: 2 }, AcpConfigSchema({}))
  expect(safeSplitRanges(surface, protection, session, 0, 2)).toMatchObject({ ranges: [], unavailable: expect.stringContaining('complete balanced tool spans') })
  expect(safeSplitRanges(surface, new Map(), session, 2, 2).ranges).toEqual([])
  const missing: SurfaceCapture = { ...surface, messages: [surface.messages[0]!, surface.messages[1]!, null] }
  expect(safeSplitRanges(missing, protection, session, 0, 2).ranges).toEqual([])
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Current Step input' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const current = capture(session)
  expect(safeSplitRanges(current, protectedNodes(current, { turn: 1, step: 2 }, AcpConfigSchema({})), session, 0, 3)).toMatchObject({ ranges: [], unavailable: expect.stringContaining('hard rejection') })
})

it('bounds the entire notice, prioritizes latest task, and names omitted protection groups', async () => {
  const config = configFor({ reminderMaxBytes: 2300 })
  const f = await reminderFixture(config)
  try {
    await f.run(largeTask)
    for (let i = 0; i < 30; i++) {
      f.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Persistent instruction ${i}: preserve this exact rule.` }], source: { kind: 'user', form: 'instructions' } }), { surfaceOp: 'append' })
      f.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Unprotected historical notice ${i}.` }], source: { kind: 'user', form: 'notice', summary: 'Maintenance' } }), { surfaceOp: 'append' })
    }
    f.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Latest actual task body: preserve boundary rules.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await f.run('Entering input is not in the map.')
    const message = notices(f.agent.session)[0]!.data
    expect(body(message)).toContain('latest_task')
    expect(body(message)).toMatch(/Omitted \d+ protection groups \(\d+ nodes\); there are unlisted boundaries/)
    expect(body(message)).not.toContain('All current Surface protection groups listed.')
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(config.reminderMaxBytes)
    expect(f.ctx.tokenMeter.estimateMessage(message)).toBeLessThanOrEqual(config.reminderMaxTokens)
    await f.run('Same pressure episode')
    expect(notices(f.agent.session)).toHaveLength(1)
  } finally { await f.ctx.fiber.dispose() }
})
