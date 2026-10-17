import { expect, it } from 'vitest'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { providerFixture } from './provider-fixture.ts'
import { createLoopFixture, runTurn, seedHistory } from './loop-fixtures/agent-loop.ts'
import { loadActiveContext } from './loop-fixtures/loader.ts'

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:acp-test/state': { text: string }
  }
}

it('keeps plugin records in the capture log without turning their payload into selectable text', async () => {
  const f = await providerFixture()
  try {
    const seq = appendPluginRecord(f.session, 'plugin:acp-test/state', { text: 'Record payload is not a message endpoint' })
    expect(f.session.surface.nodes).not.toContain(seq)
    const result = await f.submit({ regions: [{ range: [{ text: 'Record payload is not a message endpoint' }, { text: 'Record payload is not a message endpoint' }], summary: 'Not selectable' }] })
    expect(result.facts.status).toBe('failed')
    expect(result.facts.regions[0].error).toContain('has no match')
    expect(f.session.eventAt(seq)?.type).toBe('plugin:acp-test/state')
  } finally { await f.dispose() }
})

it('reintroduces required runtime context after ACP replaces its older snapshot', async () => {
  const rule = 'Required operational context must remain available. ' + 'operational detail '.repeat(400)
  const input = { regions: [{ range: [{ text: 'Required operational context must remain available.' }, { text: 'Required operational context must remain available.' }], summary: 'Operational context remains owned by its live provider.' }] }
  const f = await createLoopFixture([
    [{ type: 'text', text: 'Completed A.' }], [{ type: 'text', text: 'Completed middle.' }], [{ type: 'text', text: 'Completed B.' }],
    [{ type: 'tool-call', name: 'context_compress', id: ToolCallId('runtime-compress'), arguments: JSON.stringify(input) }],
    request => {
      expect(JSON.stringify(request.messages)).toContain(rule)
      return [{ type: 'text', text: 'Required context retained.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    ctx.systemPrompt.context({ name: 'required-test-context', order: 10, required: true, text: rule })
    await loadActiveContext(ctx, { basic: { auto: false } })
  })
  try {
    await seedHistory(f.agent)
    await runTurn(f.agent, 'Compress only the historical runtime snapshot.')
    const log = f.agent.session.snapshotEvents()
    expect(log.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    expect(log.filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')).toHaveLength(2)
    expect(f.adapter.requests).toHaveLength(5)
  } finally { await f.ctx.fiber.dispose() }
})
