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

const endpoint = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'Non-empty, case-sensitive literal substring within one current derived text block; no trimming or normalization.' },
    role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant', 'tool'] },
  },
} as const

/** Working-model guidance: summaries are authored here, not by an auxiliary model. */
export const ACP_INSTRUCTIONS = 'When earlier context is no longer needed verbatim, recall exact source events as needed. Submit model-written summaries with context_compress in one standalone assistant response: exactly one native/both context_compress call, no other tools, no task prose, never run_code/PTC. Reasoning is allowed. Choose non-adjacent regions using exactly two literal text endpoints per range, optionally qualified by role. Each endpoint must uniquely match one node in the current derived text blocks; both complete nodes are included and may be the same node. Matching is case-sensitive without trimming; reasoning and tool arguments are not searched. Preserve conclusions, exact names and paths, modifications, verification evidence, failures, open questions, constraints and uncertainty, and readback references. Protected current instructions, current Step and latest task input cannot be selected. On partial or failed submission, select only failed or unattempted work again using current text; committed regions are not rolled back.'

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
    description: 'Replace old non-adjacent Surface regions with your own summaries. Standalone native/both call only: no other calls or task prose, never run_code/PTC. Each range has exactly two literal text endpoints with optional role, independently unique across current derived text-block nodes; both complete endpoint nodes are included. No reasoning, tool arguments or Log search. Full preflight precedes tail-to-head native transactions; first failure stops, with no rollback. A successful result is committed, with call/result cleanup pending final settlement.',
    parameters: {
      regions: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            range: { type: 'array', required: true, items: endpoint, description: 'Exactly two endpoints: start then end in current Surface order, inclusive of whole nodes.' },
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
