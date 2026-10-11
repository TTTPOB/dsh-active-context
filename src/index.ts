/** Sole Cordis composition entry for active compaction and its pre-step lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config, validateAcpConfig } from './config.ts'
import { ActiveCompactionEngine } from './provider.ts'
import { submitRegions } from './regions.ts'
import { installGuard } from './guard.ts'
import { installHide } from './hide.ts'
import { installReminder } from './reminder.ts'
import type { AcpState, PluginConfig } from './types.ts'

export { Config } from './config.ts'
export { ActiveCompactionEngine } from './provider.ts'
export type * from './types.ts'
export const name = 'active-context'
// The provider is created here: injecting compaction would deadlock its own activation.
export const inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'llm', 'tokenMeter', 'sessionQuery', 'sessionProjections']

const anchor = {
  type: 'object', additionalProperties: false,
  properties: {
    seq: { type: 'integer', required: true },
    edge: { type: 'string', enum: ['before', 'after'], required: true },
  },
} as const

/** Working-model guidance: summaries are authored here, not by an auxiliary model. */
export const ACP_INSTRUCTIONS = 'When earlier context is no longer needed verbatim, inspect session_context_map and recall exact source events as needed. Submit model-written summaries with context_compress in one standalone assistant response: exactly one native/both context_compress call, no other tools, no task prose, never run_code/PTC. Reasoning is allowed. Choose non-adjacent regions from one snapshot_ref. Preserve conclusions, exact names and paths, modifications, verification evidence, failures, open questions, constraints and uncertainty, and readback references. Protected current instructions, current Step and latest task input cannot be selected. On partial or failed submission, refresh the map and select only failed or unattempted work; committed regions are not rolled back.'

/** Mount the unique provider, real worker hooks, and one awaited outer wrapper. */
export function apply(ctx: Context, config: PluginConfig = Config({})): void {
  validateAcpConfig(config.acp)
  if (typeof ctx.sessionQuery.captureSession !== 'function') throw new Error('ACP requires SessionQuery.captureSession (fork4 or later verified API)')
  if (ctx.get('compaction') !== undefined) throw new Error('ACP replaces the sole compaction provider; disable the original Basic provider first')
  const state: AcpState = {
    identities: new WeakMap(), facts: new WeakMap(), hideCandidates: new WeakMap(),
  }
  // Service registration and native Basic listeners belong to this plugin fiber.
  const engine = new ActiveCompactionEngine(ctx, config.basic)
  const guard = installGuard(ctx, config.acp, state)
  const hide = installHide(ctx, config.acp, state)
  const reminder = installReminder(ctx, config.acp, engine.config)
  ctx.systemPrompt.section({ name: 'active-context', order: 80, text: ACP_INSTRUCTIONS })
  ctx.tools.register(defineTool({
    name: 'context_compress',
    description: 'Replace old non-adjacent Surface regions with your own summaries. Standalone native/both call only: no other calls or task prose, never run_code/PTC. Use one session_context_map snapshot_ref and its seq+before/after anchors. Full preflight precedes tail-to-head native transactions; first failure stops, with no rollback. A successful result is committed, with call/result cleanup pending final settlement.',
    parameters: {
      snapshot_ref: {
        type: 'object', additionalProperties: false, required: true,
        properties: {
          session_id: { type: 'string', required: true },
          read_seq: { type: 'integer', required: true },
          map_id: { type: 'string', required: true },
        },
      },
      regions: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            start: { ...anchor, required: true },
            end: { ...anchor, required: true },
            summary: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    finalizeContent: guard.finalizeContent,
    execute: (input, exec) => submitRegions(ctx, engine, exec, guard.requireIdentity(exec), input, config.acp, state),
  }))
  ctx.on('agent/pre-step', async (frame, next) => {
    if (!frame.signal.aborted) await hide.cleanupBeforeNative(frame)
    const decision = await next()
    return reminder.noticeAfterNative(frame, decision)
  }, { prepend: true })
}
