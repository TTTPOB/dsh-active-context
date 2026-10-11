import { describe, expect, it, vi } from 'vitest'
import { preflightRegions } from '../src/regions.ts'
import { providerFixture } from './provider-fixture.ts'

describe('active region batches', () => {
  it('commits two non-adjacent regions tail to head and retains intervening content', async () => {
    const fixture = await providerFixture()
    try {
      const { result, facts } = await fixture.submit()
      expect(result.isError).toBe(false)
      expect(facts.status).toBe('batch_success')
      expect(facts.execution_order).toEqual(['tail', 'head'])
      expect(facts.regions.map((item: { id: string }) => item.id)).toEqual(['head', 'tail'])
      expect(facts.regions.every((item: { route_token_reduction: number }) => item.route_token_reduction > 0)).toBe(true)
      expect(fixture.session.surface.nodes).toContain(fixture.old[1])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[0])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[2])
      expect(fixture.adapter.calls).toBe(0)
    } finally { await fixture.dispose() }
  })

  it('rejects the full batch before writing when any target is protected or summaries exceed the total budget', async () => {
    const fixture = await providerFixture()
    try {
      const before = fixture.session.seq
      const protectedBatch = fixture.input([{ ...fixture.input().regions[0]!, id: 'task', start: { seq: fixture.latestTask, edge: 'before' }, end: { seq: fixture.latestTask, edge: 'after' } }])
      protectedBatch.snapshot_ref.read_seq = before - 1
      await expect(preflightRegions(fixture.ctx, fixture.agent, fixture.identity, protectedBatch, fixture.config)).rejects.toThrow(/protected/)
      await expect(preflightRegions(fixture.ctx, fixture.agent, fixture.identity, fixture.input(), { ...fixture.config, summaryMaxBytes: 20 })).rejects.toThrow(/total budget/)
      expect(fixture.session.seq).toBe(before)
    } finally { await fixture.dispose() }
  })

  it('retains a committed tail and stops before the head on a later native failure', async () => {
    const fixture = await providerFixture()
    try {
      const original = fixture.engine.compactPrewritten.bind(fixture.engine)
      vi.spyOn(fixture.engine, 'compactPrewritten').mockImplementation(async (region, ...args) => {
        if (region.input.id === 'head') throw new Error('head native failure')
        return original(region, ...args)
      })
      const { facts } = await fixture.submit()
      expect(facts.status).toBe('partial')
      expect(facts.regions.map((item: { status: string }) => item.status)).toEqual(['failed', 'committed'])
      expect(fixture.session.surface.nodes).toContain(fixture.old[0])
      expect(fixture.session.surface.nodes).not.toContain(fixture.old[2])
    } finally { await fixture.dispose() }
  })

  it('stops when a remaining target projection changes after preflight even at the same token length', async () => {
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
      expect(facts.execution_order).toEqual(['tail'])
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
      const { facts } = await fixture.submit()
      expect(facts.status).toBe('partial')
      expect(facts.execution_order).toEqual(['tail'])
      expect(facts.regions.map((item: { status: string }) => item.status)).toEqual(['not_attempted', 'committed_with_error'])
      expect(facts.regions[1].replacement_seq).toBeTypeOf('number')
      expect(facts.regions[1].compaction_id).toBeTypeOf('string')
    } finally { await fixture.dispose() }
  })
})
