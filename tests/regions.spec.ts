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
      await expect(preflightRegions(fixture.ctx, fixture.agent, fixture.identity, fixture.input(regions), fixture.config)).rejects.toThrow('submit 1-16 non-adjacent regions')
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
    expect(output.cleanup).toBe('retained')
    expect(output.final_error).toEqual({ name: 'AbortError', code: 'ABORTED', message: 'cancelled after replacement', content: 'request cancelled\noriginal native details' })
    expect(output.regions[0]).toMatchObject({ status: 'committed_with_error', compaction_id: 'native-id', replacement_seq: 10, route_token_reduction: 150, route_reduction_ratio: 0.75 })
  })

  it('commits two non-adjacent regions tail to head and retains intervening content', async () => {
    const fixture = await providerFixture()
    try {
      const { result, facts } = await fixture.submit()
      expect(result.isError).toBe(false)
      expect(facts.status).toBe('batch_success')
      expect(facts.execution_order).toEqual([1, 0])
      expect(facts.regions.map((item: { input_index: number }) => item.input_index)).toEqual([0, 1])
      expect(facts.regions.every((item: { route_token_reduction: number }) => item.route_token_reduction > 0)).toBe(true)
      expect(fixture.session.surface.nodes).toContain(fixture.old[1])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[0])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[2])
      expect(fixture.adapter.calls).toBe(0)
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
      expect(fixture.session.surface.nodes).toContain(fixture.old[0])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[2])
    } finally { await fixture.dispose() }
  })
})
