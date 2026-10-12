import { describe, expect, it } from 'vitest'
import { preflightRegions } from '../src/regions.ts'
import { providerFixture } from './provider-fixture.ts'

describe('prewritten native provider', () => {
  it('uses the logged working author and creates no auxiliary model call or usage', async () => {
    const fixture = await providerFixture()
    try {
      const { regions: regions } = await preflightRegions(fixture.ctx, fixture.agent, fixture.identity, fixture.input(), fixture.config)
      const result = await fixture.engine.compactPrewritten(regions[0]!, fixture.agent, fixture.identity, new AbortController().signal)
      expect(fixture.adapter.calls).toBe(0)
      const summary = fixture.session.eventAt(result.summarySeq)
      expect(summary?.type).toBe('compaction/summary')
      if (summary?.type === 'compaction/summary') {
        expect(summary.data).toMatchObject({ provider: 'author', model: 'working' })
        expect(summary.data.usage).toBeUndefined()
        expect(summary.data.llmStreamCall).toBeUndefined()
      }
    } finally { await fixture.dispose() }
  })

  it('clears the supplied-summary slot after rejection and delegates a normal native call', async () => {
    const fixture = await providerFixture()
    try {
      const { regions: regions } = await preflightRegions(fixture.ctx, fixture.agent, fixture.identity, fixture.input(), fixture.config)
      const region = regions[0]!
      await expect(fixture.engine.compactPrewritten({ ...region, input: { ...region.input, summary: 'oversized '.repeat(10000) } }, fixture.agent, fixture.identity, new AbortController().signal)).rejects.toThrow()
      expect(fixture.adapter.calls).toBe(0)
      await fixture.engine.compactRegion(region.start, region.end, fixture.agent)
      expect(fixture.adapter.calls).toBe(1)
    } finally { await fixture.dispose() }
  })
})
