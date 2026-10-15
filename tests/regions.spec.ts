import { describe, expect, it, vi } from 'vitest'
import { preflightRegions, renderBatchFacts } from '../src/regions.ts'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { AcpConfigSchema } from '../src/config.ts'
import { providerFixture } from './provider-fixture.ts'

describe('active region batches', () => {
  it('defaults to sixteen regions and rejects seventeen before writing', async () => {
    const fixture = await providerFixture()
    try {
      expect(fixture.config.maxRegions).toBe(16)
      const before = fixture.session.seq
      const regions = Array.from({ length: 17 }, () => fixture.input().regions[0]!)
      await expect(preflightRegions(fixture.ctx, fixture.agent, fixture.identity, fixture.input(regions), fixture.config)).rejects.toThrow('submit 1-16 non-overlapping regions')
      expect(fixture.session.seq).toBe(before)
    } finally { await fixture.dispose() }
  })

  it('preserves final cancellation details and committed metering facts in one bounded result', () => {
    const rendered = renderBatchFacts({ status: 'partial', executionOrder: [0], regions: [{
      inputIndex: 0, range: [{ text: 'original' }, { text: 'original' }], expanded: false, status: 'committed_with_error', compactionId: CompactionId('native-id'),
      replacementSeq: SessionSeq(10), shadowedSeqs: [SessionSeq(2)],
      shadowedRouteTokens: 200, shadowedHeuristicTokens: 180,
      replacementRouteTokens: 50, replacementHeuristicTokens: 45,
    }] }, AcpConfigSchema({}), {
      isError: true, error: { message: 'cancelled after replacement', info: { name: 'AbortError', code: 'ABORTED' } },
      content: [{ type: 'text', text: 'request cancelled' }, { type: 'text', text: 'original native details' }],
    })
    const output = JSON.parse(rendered)
    expect(output.call_error).toBe('aborted')
    expect(output.final_error).toEqual({ name: 'AbortError', code: 'ABORTED', message: 'cancelled after replacement', content: 'request cancelled\noriginal native details' })
    expect(output.regions[0]).toMatchObject({ status: 'committed_with_error', nodes: 1, shadowed_tokens: 200, replacement_tokens: 50 })
    // No readback without an observed native transaction, and no retry offer when nothing needs another attempt.
    expect(output.regions[0]).not.toHaveProperty('readback')
    expect(output).not.toHaveProperty('retry')
  })

  it('commits two non-adjacent regions tail to head and retains intervening content', async () => {
    const fixture = await providerFixture()
    try {
      const { result, facts } = await fixture.submit()
      expect(result.isError).toBe(false)
      expect(facts.status).toBe('compressed')
      expect(Object.keys(facts).sort()).toEqual(['execution_order', 'regions', 'status'])
      expect(Object.keys(facts.regions[0]).sort()).toEqual(['input_index', 'nodes', 'range', 'readback', 'replacement_tokens', 'shadowed_tokens', 'source_end_seq', 'source_session_id', 'source_start_seq', 'status'])
      expect(facts.regions[0]).toMatchObject({ source_session_id: fixture.agent.id, source_start_seq: fixture.old[0], source_end_seq: fixture.old[0] })
      expect(facts.regions[1]).toMatchObject({ source_session_id: fixture.agent.id, source_start_seq: fixture.old[2], source_end_seq: fixture.old[2] })
      expect(facts.execution_order).toEqual([1, 0])
      expect(facts.regions.map((item: { input_index: number }) => item.input_index)).toEqual([0, 1])
      expect(facts.regions.every((item: { shadowed_tokens: number; replacement_tokens: number }) => item.shadowed_tokens > item.replacement_tokens)).toBe(true)
      expect(fixture.session.surface.nodes).toContain(fixture.old[1])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[0])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[2])
      expect(fixture.adapter.calls).toBe(0)
    } finally { await fixture.dispose() }
  })

  it('returns ACP_ALL_FAILED with retry indices and no writes when every endpoint is missing', async () => {
    const fixture = await providerFixture()
    try {
      const before = fixture.session.seq
      const { result, facts } = await fixture.submit(fixture.input([
        { range: [{ text: 'absent one' }, { text: 'absent one' }], summary: 'Unused.' },
        { range: [{ text: 'absent two' }, { text: 'absent two' }], summary: 'Unused.' },
      ]))
      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe('ACP_ALL_FAILED')
      expect(facts.status).toBe('failed')
      expect(facts.retry.regions).toEqual([0, 1])
      expect(facts.regions.every((region: { error: string }) => region.error.includes('has no match'))).toBe(true)
      expect(facts).not.toHaveProperty('final_error')
      for (const region of facts.regions) {
        expect(region).not.toHaveProperty('source_session_id')
        expect(region).not.toHaveProperty('source_start_seq')
        expect(region).not.toHaveProperty('source_end_seq')
      }
      expect(fixture.session.seq).toBe(before)
    } finally { await fixture.dispose() }
  })

  it('reports protected regions independently while global summary budgets reject before writing', async () => {
    const fixture = await providerFixture()
    try {
      const before = fixture.session.seq
      const protectedBatch = fixture.input([{ ...fixture.input().regions[0]!, range: [{ text: 'current task' }, { text: 'current task' }] }])
      const protectedResult = await preflightRegions(fixture.ctx, fixture.agent, fixture.identity, protectedBatch, fixture.config)
      expect(protectedResult.facts[0]).toMatchObject({ inputIndex: 0, status: 'failed', error: expect.stringMatching(/latest_task_input.*current task/) })
      await expect(preflightRegions(fixture.ctx, fixture.agent, fixture.identity, fixture.input(), { ...fixture.config, summaryMaxBytes: 20 })).rejects.toThrow(/total budget/)
      expect(fixture.session.seq).toBe(before)
    } finally { await fixture.dispose() }
  })

  it('does not swallow an unknown native fault after a committed tail', async () => {
    const fixture = await providerFixture()
    try {
      const original = fixture.engine.compactPrewritten.bind(fixture.engine)
      vi.spyOn(fixture.engine, 'compactPrewritten').mockImplementation(async (region, ...args) => {
        if (region.inputIndex === 0) throw new Error('head native failure')
        return original(region, ...args)
      })
      const { result } = await fixture.submit()
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('head native failure')
      expect(fixture.session.surface.nodes).toContain(fixture.old[0])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[2])
    } finally { await fixture.dispose() }
  })

  it('rejects a region when its target projection changes after preflight even at the same token length', async () => {
    const fixture = await providerFixture()
    try {
      let changed = false
      const derive = fixture.session.deriveEventMessage.bind(fixture.session)
      vi.spyOn(fixture.session, 'deriveEventMessage').mockImplementation(event => {
        const message = derive(event)
        if (changed && event.seq === fixture.old[0] && message !== null) {
          return { ...message, content: message.content.map(block => block.type === 'text' ? { ...block, text: block.text.replace('completed', 'rewritten') } : block) }
        }
        return message
      })
      const original = fixture.engine.compactPrewritten.bind(fixture.engine)
      vi.spyOn(fixture.engine, 'compactPrewritten').mockImplementation(async (region, ...args) => {
        const result = await original(region, ...args)
        changed = true
        return result
      })
      const { facts } = await fixture.submit()
      expect(facts.status).toBe('partial')
      expect(facts.execution_order).toEqual([1])
      expect(facts.regions[0].error).toMatch(/changed since preflight/)
      expect(fixture.session.surface.nodes).toContain(fixture.old[0])
    } finally { await fixture.dispose() }
  })

  it('reports replacement evidence when native closing throws and leaves earlier regions unattempted', async () => {
    const fixture = await providerFixture()
    try {
      const original = fixture.engine.compactPrewritten.bind(fixture.engine)
      vi.spyOn(fixture.engine, 'compactPrewritten').mockImplementation(async (region, ...args) => {
        await original(region, ...args)
        throw new Error('after durable replacement')
      })
      const { result } = await fixture.submit()
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('after durable replacement')
      const content = result.content[0]!
      if (content.type !== 'text') throw new Error('missing committed source receipt')
      expect(JSON.parse(content.text).regions[1]).toMatchObject({ source_session_id: fixture.agent.id, source_start_seq: fixture.old[2], source_end_seq: fixture.old[2] })
      expect(fixture.session.surface.nodes).toContain(fixture.old[0])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[2])
    } finally { await fixture.dispose() }
  })
})
