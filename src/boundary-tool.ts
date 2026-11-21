import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderProtectionMap, selectableRanges } from './boundaries.ts'
import { protectedNodes, sampleSurface } from './protection.ts'
import type { AcpConfig } from './types.ts'

/** Register the optional read-only Surface map for the calling Session. */
export function installBoundaryTool(ctx: Context, config: AcpConfig): void {
  ctx.tools.register(defineTool({
    name: 'context_boundaries',
    description: 'Read the current Session’s protected boundaries and candidate ranges in completed history. Optional before context_compress; may be used alongside ordinary tools.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new HarnessError('ACP: an active Session is required for a boundary map.', 'ACP_BOUNDARIES_NO_STEP')
      return ctx.sessionQuery.captureSession(agent.id, (reader, observation) => {
        exec.signal.throwIfAborted()
        const surface = sampleSurface(agent, reader, observation)
        const boundary = surface.log.findLast(event => event.type === 'step/start' || event.type === 'step/end')
        if (boundary?.type !== 'step/start') throw new HarnessError('ACP: a boundary map requires an executing Step.', 'ACP_BOUNDARIES_NO_STEP')
        const protection = protectedNodes(surface, boundary.data, config)
        const { ranges, omitted_ranges, unavailable } = selectableRanges(surface, protection, agent.session, 0, surface.seqs.length - 1)
        const intro = 'Current Surface boundaries (reference only). New inputs, instructions and replacements after this capture are not shown. Current Step content is not shown. '
          + 'context_compress rechecks live protection, endpoint uniqueness and tool spans at submission. B labels and map text are not endpoints. '
          + 'If you use a suggested range, use its endpoint values as clues to the original messages, and write your own summary.'
        const fits = (text: string) => ctx.tokenMeter.estimateMessage(createToolResultMessage({ callId: exec.callId, isError: false, content: [{ type: 'text', text }] })) <= config.reminderMaxTokens
          && Buffer.byteLength(text, 'utf8') <= config.reminderMaxBytes
        const map = renderProtectionMap(intro, surface, protection, fits, true)
        if (map === undefined) throw new HarnessError('ACP: the boundary map exceeds the configured reminder budget.', 'ACP_BOUNDARIES_BUDGET')
        for (let count = ranges.length; count >= 0; count--) {
          const omitted = omitted_ranges + ranges.length - count
          const result = map + '\nSelectable historical ranges: ' + JSON.stringify(ranges.slice(0, count))
            + (omitted > 0 ? '\nOmitted selectable ranges: ' + omitted + '.' : '')
            + (unavailable === undefined ? '' : '\n' + unavailable + '.')
          if (fits(result)) return result
        }
        return map + (fits(map + '\nSelectable ranges omitted to fit the map budget.') ? '\nSelectable ranges omitted to fit the map budget.' : '')
      }, { projectionMode: 'none' })
    },
  }))
}
