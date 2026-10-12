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
    text: { type: 'string', required: true, description: 'Non-empty, case-sensitive literal substring within one eligible current derived text block; no trimming or normalization. ACP pressure/status displays and context_compress results are not endpoint candidates.' },
    role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant', 'tool'] },
  },
} as const

/** Working-model guidance: summaries are authored here, not by an auxiliary model. */
export const ACP_INSTRUCTIONS = `When earlier context is no longer needed verbatim, recall exact source events as needed. Submit model-written summaries with context_compress in one standalone assistant response: exactly one native/both context_compress call, no other tools, no task prose, never run_code/PTC. Reasoning is allowed. Choose non-adjacent regions using exactly two literal text endpoints per range, optionally qualified by role. Each endpoint must uniquely match one eligible node in the current derived text blocks. range[0] identifies the start node and range[1] identifies the end node. The start must be at or before the end in current context order. Both endpoint nodes and all nodes between them are selected in full. If both endpoints identify the same node, only that node is selected. A short distinctive phrase is enough; you need not copy a whole message. Matching is case-sensitive within each eligible derived text block, without trimming or whitespace/Unicode normalization. ACP pressure notices/maps, ACP maintenance status records and context_compress tool results are excluded as endpoint candidates by source/call attribution. Ordinary notices/tools and real compact-checkpoint summaries remain eligible. Excluded displays still belong to ranges and participate in tool-span completion, protection and conflicts. Text does not select character cuts or act as regex; reasoning, tool arguments and the Log are not searched. Repeated hits within one node count as one match; only matches in different nodes cause ambiguity.

Preserve conclusions, exact names and paths, modifications, verification evidence, failures, open questions, constraints and uncertainty, and readback references. Prefer a completed multi-message work phase over isolated reports when its details are no longer needed verbatim.

Protection applies to every node inside a selected region, not just its endpoints. Do not select:
- Any live system/developer message or any live message marked form:instructions, even if it appears old.
- Any node from the current Step. A Step is one model request and its tool execution, not the whole Turn; completed earlier Steps in the same Turn may be compressed.
- The latest request driving the current Turn. Earlier requests may be compressed unless another protection rule applies. Requests may come from the user, a subagent assignment, an agent relay, a goal or a schedule, as enabled by configuration. Maintenance notices do not count as new requests.

Pressure notices show current Surface protection groups with local B labels, roles and short literal clues. Keep each range within one section between protected boundaries; any finer selection inside a section is allowed. B labels and protected clues identify boundaries, not selectable endpoints; choose endpoints from actual messages inside a section. Maps may explicitly omit groups to fit the reminder budget; new input/current entering Step is not yet in a pre-step map and cannot be selected. The tool validates the entire expanded range. If protection rejects a range, use the reported body excerpts and safe split ranges to reselect; write a separate summary for each chosen fragment. Suggestions stay inside the original range and preserve balanced tool spans. Current Step rejection has no split suggestions. Do not automatically fall back to compressing single messages. The tool automatically expands ranges outward to complete tool-call/result pairs, including every call in the same assistant node and tool spans crossing the selected boundaries (even through plain-text nodes), then checks protection and cross-region conflicts. Missing counterparts fail that region. Endpoint, protection, overlap or adjacency failures reject the affected regions; other independent valid regions may commit. Global input/budget errors reject the batch. Execution is tail to head; attributable region failures continue, cancellation or unrecoverable faults stop remaining work. Committed regions are not rolled back. Results preserve input_index, status, original range and expanded. Reselect only failed/not_attempted regions using current text; committed original endpoints may no longer match. After the result is logged and the Step ends, a confirmed successful or partially successful call/result pair may be replaced with a bounded status record retaining original ranges and errors, never summaries. If the full record does not fit, the original pair is retained. Cancellation, final errors and uncertain commits retain the pair.

These examples use completed old history; the current task has a separate newer input. Runtime protection and automatic tool-pair completion still apply.

Example 1 — short phrases inside the first and third messages:
\`\`\`json
[
  { "role": "user", "text": "Old check: input source verified; keep the original filename." },
  { "role": "assistant", "text": "The checksum matched; the original file stays unchanged." },
  { "role": "assistant", "text": "Wrap-up: review finished; no open checks remain." }
]
\`\`\`
Submit:
\`\`\`json
{"regions":[{"range":[{"text":"source verified","role":"user"},{"text":"review finished","role":"assistant"}],"summary":"Source and checksum verified; preserve the original file and filename. No checks remain."}]}
\`\`\`
This selects all three complete messages, including the text before and after both matching phrases. It does not cut from the middle of the first message to the middle of the third.

Example 2 — the same phrase in two assistant nodes:
\`\`\`json
[
  { "role": "assistant", "text": "Alpha check passed; retain the red file." },
  { "role": "assistant", "text": "Beta check passed; retain the blue file." }
]
\`\`\`
This submission is ambiguous:
\`\`\`json
{"regions":[{"range":[{"text":"check passed","role":"assistant"},{"text":"blue file","role":"assistant"}],"summary":"Beta passed; keep the blue file."}]}
\`\`\`
The start text matches both nodes. Both have role assistant, so that role cannot distinguish them. Choose a more distinctive phrase:
\`\`\`json
{"regions":[{"range":[{"text":"Beta check passed","role":"assistant"},{"text":"blue file","role":"assistant"}],"summary":"Beta passed; keep the blue file."}]}
\`\`\`
Both endpoints now match only the second node, selecting that whole message. In other history, adding role can resolve repeated text only when the roles distinguish its matching nodes.`

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
  ctx.systemPrompt.section({ name: 'active-context', order: 80, text: `Submit 1-${config.acp.maxRegions} non-adjacent regions per context_compress call.\n\n${ACP_INSTRUCTIONS}` })
  ctx.tools.register(defineTool({
    name: 'context_compress',
    description: 'Replace old non-adjacent Surface regions with your own summaries. Standalone native/both call only: no other calls or task prose, never run_code/PTC. Each range has exactly two literal text endpoints with optional role, independently unique across current derived text-block nodes; both complete endpoint nodes are included. No reasoning, tool arguments or Log text search. ACP pressure/status displays and context_compress results are not endpoints; they still participate inside ranges and tool spans. Stay between protected boundaries; notice B labels are not endpoints. Protected failures show body clues and safe split ranges when available; author summaries separately. Ranges expand outward to complete intersecting tool-call/result spans, including plain-text nodes inside them, before protection/conflict checks. Invalid regions fail independently; every overlap/adjacency participant fails. Valid regions execute tail to head; attributable region failures continue, global faults/cancellation stop, no rollback. Reports retain input_index/status/original range/expanded. Confirmed partial successes also permit bounded call/result cleanup after final settlement; full ranges and errors remain, summaries do not repeat. Over-budget records retain the original pair.',
    parameters: {
      regions: {
        type: 'array', required: true, description: `Submit 1-${config.acp.maxRegions} non-adjacent regions per call.`,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            range: { type: 'array', required: true, items: endpoint, description: 'Exactly two endpoints. range[0] identifies the start node and range[1] identifies the end node. The start must be at or before the end in current context order. Both endpoint nodes and all nodes between them are selected in full. If both endpoints identify the same node, only that node is selected. Intersecting tool-call/result spans are automatically completed outward, including plain-text nodes between them, before protection and cross-region conflict checks. Stay within one section between protected boundaries; local notice B labels are not endpoints.' },
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
