/** Whole-batch preflight and tail-to-head native transactions without rollback. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { resolveSurfaceRange } from 'dsh-session-tools/context-map'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-token-meter'
import { assertCompleteToolPairs, protectedSeqs, type SurfaceCapture } from './protection.ts'
import type { ActiveCompactionEngine } from './provider.ts'
import type { AcpConfig, AcpState, BatchFacts, CompressInput, ExecutionIdentity, RegionFact, ResolvedRegion } from './types.ts'
import type { ToolExecutionFailure, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Sample the exact active Session and detach positional and interpreted values together. */
async function capture(ctx: Context, agent: Agent): Promise<SurfaceCapture> {
  return ctx.sessionQuery.captureSession(agent.id, (reader, observation) => {
    if (reader !== agent.session) throw new Error('ACP: Query did not select the calling live Session')
    const seqs = [...reader.surface.nodes]
    const events = seqs.map(seq => {
      const event = observation.events[seq]
      if (event === undefined) throw new Error(`ACP: Surface node ${seq} is outside the observed Log`)
      return event
    })
    return {
      seqs, events,
      messages: events.map(event => structuredClone(reader.deriveEventMessage(event))),
      log: [...observation.events],
    }
  }, { projectionMode: 'none' })
}

/** Reject malformed author budgets before any native compaction transaction starts. */
function validateInput(ctx: Context, input: CompressInput, config: AcpConfig, agent: Agent): void {
  if (input.snapshot_ref.session_id !== agent.id) throw new Error('ACP: snapshot_ref must name the current Session')
  if (!Number.isSafeInteger(input.snapshot_ref.read_seq) || input.snapshot_ref.read_seq < -1
    || input.snapshot_ref.read_seq >= agent.session.seq) throw new Error('ACP: invalid snapshot read upper bound')
  if (input.snapshot_ref.map_id.trim().length === 0) throw new Error('ACP: map_id must not be empty')
  if (input.regions.length === 0 || input.regions.length > config.maxRegions) {
    throw new Error(`ACP: submit 1-${config.maxRegions} non-adjacent regions`)
  }
  const ids = new Set<string>()
  let bytes = 0
  let tokens = 0
  for (const region of input.regions) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(region.id) || ids.has(region.id)) throw new Error('ACP: region IDs must be unique short identifiers')
    ids.add(region.id)
    if (region.summary.trim().length === 0) throw new Error(`ACP: summary ${region.id} must not be empty`)
    bytes += Buffer.byteLength(region.summary, 'utf8')
    tokens += ctx.tokenMeter.estimateMessage(createUserMessage({ content: [{ type: 'text', text: region.summary }], source: { kind: 'user' } }))
  }
  if (bytes > config.summaryMaxBytes || tokens > config.summaryMaxTokens) {
    throw new Error(`ACP: batch summaries exceed the total budget (${tokens} tokens, ${bytes} bytes)`)
  }
}

/** Resolve all selections before starting any native transaction. */
export async function preflightRegions(
  ctx: Context, agent: Agent, identity: ExecutionIdentity, input: CompressInput, config: AcpConfig,
): Promise<ResolvedRegion[]> {
  validateInput(ctx, input, config, agent)
  const surface = await capture(ctx, agent)
  const protectedNodes = protectedSeqs(surface, identity, config)
  const measurement = ctx.tokenMeter.measure(agent.session)
  if (!isDeepStrictEqual(measurement.nodes.map(node => node.seq), surface.seqs)) throw new Error('ACP: Surface changed during preflight; refresh the map')
  const resolved = input.regions.map((item, inputIndex): ResolvedRegion => {
    const range = resolveSurfaceRange(surface.seqs, item)
    const startIndex = range.start_index
    const endIndex = range.end_index - 1
    const seqs = surface.seqs.slice(startIndex, endIndex + 1)
    const start = seqs[0]
    const end = seqs.at(-1)
    if (start === undefined || end === undefined) throw new Error(`ACP: region ${item.id} is empty`)
    if (seqs.some(seq => seq > input.snapshot_ref.read_seq)) throw new Error(`ACP: region ${item.id} includes nodes created after the map; refresh it`)
    if (seqs.some(seq => protectedNodes.has(seq))) throw new Error(`ACP: region ${item.id} contains protected context`)
    const messages = surface.messages.slice(startIndex, endIndex + 1)
    assertCompleteToolPairs(messages)
    const measured = measurement.nodes.slice(startIndex, endIndex + 1)
    return {
      input: item, inputIndex, start, end, startIndex, endIndex, seqs,
      events: surface.events.slice(startIndex, endIndex + 1), messages, measurement,
      shadowedRouteTokens: measured.reduce((sum, node) => sum + node.tokens, 0),
      shadowedHeuristicTokens: measured.reduce((sum, node) => sum + node.heuristicTokens, 0),
    }
  })
  const ordered = [...resolved].sort((a, b) => a.startIndex - b.startIndex)
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!
    const current = ordered[index]!
    if (current.startIndex <= previous.endIndex + 1) throw new Error('ACP: regions overlap or are adjacent; select them again')
  }
  return resolved
}

/** Re-resolve each original node list after earlier native replacements. */
async function revalidate(ctx: Context, agent: Agent, identity: ExecutionIdentity, region: ResolvedRegion, config: AcpConfig): Promise<void> {
  const surface = await capture(ctx, agent)
  const start = surface.seqs.indexOf(region.start)
  const end = surface.seqs.indexOf(region.end)
  if (start < 0 || end < start || !isDeepStrictEqual(surface.seqs.slice(start, end + 1), region.seqs)
    || !isDeepStrictEqual(surface.events.slice(start, end + 1), region.events)
    || !isDeepStrictEqual(surface.messages.slice(start, end + 1), region.messages)) {
    throw new Error(`ACP: target ${region.input.id} changed since preflight; refresh the map`)
  }
  const protectedNodes = protectedSeqs(surface, identity, config)
  if (region.seqs.some(seq => protectedNodes.has(seq))) throw new Error(`ACP: target ${region.input.id} is now protected`)
  assertCompleteToolPairs(surface.messages.slice(start, end + 1))
}

/** Reconcile native append evidence, including a replacement followed by a closing failure. */
function observeCommit(fact: RegionFact, emitted: readonly SessionEvent[]): boolean {
  const summary = emitted.find(event => event.type === 'compaction/summary'
    && isDeepStrictEqual(event.data.shadowedSeqs, fact.shadowedSeqs))
  if (summary?.type !== 'compaction/summary') return false
  fact.compactionId = summary.data.compactionId
  const replacement = emitted.find(event => event.type === 'user/message'
    && event.surfaceOp !== 'append'
    && event.sourceEventSeqs?.includes(summary.seq))
  if (replacement !== undefined) fact.replacementSeq = replacement.seq
  return replacement !== undefined
}

/** Complete model-facing facts omit duplicated summary bodies and bound diagnostic text. */
export function renderBatchFacts(facts: BatchFacts, config: AcpConfig, finalError?: Readonly<ToolExecutionFailure>): string {
  const output = {
    status: facts.status,
    map_id: facts.mapId,
    cleanup: finalError !== undefined ? 'retained' : facts.status === 'batch_success' ? 'pending_final_settlement' : 'not_eligible',
    final_error: finalError === undefined ? undefined : {
      name: finalError.error.info?.name,
      code: finalError.error.info?.code,
      message: finalError.error.message,
      content: finalError.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
    },
    execution_order: facts.executionOrder,
    stop_reason: facts.stopReason,
    regions: facts.regions.map(fact => ({
      id: fact.id, input_index: fact.inputIndex, status: fact.status,
      compaction_id: fact.compactionId, replacement_seq: fact.replacementSeq,
      node_count: fact.shadowedSeqs.length,
      locator: { start: fact.shadowedSeqs[0], end: fact.shadowedSeqs.at(-1) },
      shadowed_route_tokens: fact.shadowedRouteTokens,
      shadowed_heuristic_tokens: fact.shadowedHeuristicTokens,
      replacement_route_tokens: fact.replacementRouteTokens,
      replacement_heuristic_tokens: fact.replacementHeuristicTokens,
      native_shadowed_heuristic_tokens: fact.result?.shadowedTokenCount,
      route_token_reduction: fact.replacementRouteTokens === undefined ? undefined : fact.shadowedRouteTokens - fact.replacementRouteTokens,
      route_reduction_ratio: fact.replacementRouteTokens === undefined || fact.shadowedRouteTokens === 0 ? undefined : 1 - fact.replacementRouteTokens / fact.shadowedRouteTokens,
      metering_basis: 'token-meter; selected prices at batch preflight; replacement prices after native commit',
      readback: fact.result === undefined ? undefined : {
        start_seq: fact.result.startSeq, summary_seq: fact.result.summarySeq, end_seq: fact.result.endSeq,
      },
      error: fact.error,
    })),
  }
  let rendered = JSON.stringify(output)
  while (Buffer.byteLength(rendered, 'utf8') > config.resultMaxBytes) {
    const diagnostic = output.regions.find(region => region.error !== undefined && region.error.length > 1)
    if (diagnostic?.error !== undefined) diagnostic.error = diagnostic.error.slice(0, Math.floor(diagnostic.error.length / 2))
    else if (output.stop_reason !== undefined && output.stop_reason.length > 1) output.stop_reason = output.stop_reason.slice(0, Math.floor(output.stop_reason.length / 2))
    else if (output.final_error !== undefined && output.final_error.content.length > 1) output.final_error.content = output.final_error.content.slice(0, Math.floor(output.final_error.content.length / 2))
    else if (output.final_error !== undefined && output.final_error.message.length > 1) output.final_error.message = output.final_error.message.slice(0, Math.floor(output.final_error.message.length / 2))
    else throw new Error('ACP: resultMaxBytes cannot contain the batch facts; increase the configured budget')
    rendered = JSON.stringify(output)
  }
  return rendered
}

/** Submit a fully checked batch from tail to head, stopping at the first failure. */
export async function submitRegions(
  ctx: Context, engine: ActiveCompactionEngine, exec: ToolRunContext,
  identity: ExecutionIdentity, input: CompressInput, config: AcpConfig, state: AcpState,
): Promise<string> {
  const agent = exec.agent
  if (agent === undefined || agent.id !== identity.sessionId || identity.callId !== exec.callId) throw new Error('ACP: execution identity does not match the calling Agent')
  exec.signal.throwIfAborted()
  const regions = await preflightRegions(ctx, agent, identity, input, config)
  const facts: BatchFacts = {
    status: 'all_failed', mapId: input.snapshot_ref.map_id, executionOrder: [],
    regions: regions.map(region => ({
      id: region.input.id, inputIndex: region.inputIndex, status: 'not_attempted',
      shadowedSeqs: region.seqs, shadowedRouteTokens: region.shadowedRouteTokens,
      shadowedHeuristicTokens: region.shadowedHeuristicTokens,
    })),
  }
  state.facts.set(exec, facts)
  // Reserve enough output space for the bounded native identifiers before the first write.
  const reservedSeq = SessionSeq(Number.MAX_SAFE_INTEGER)
  const reservedId = CompactionId('00000000-0000-0000-0000-000000000000')
  const reserve: BatchFacts = { ...facts, status: 'batch_success', stopReason: 'x',
    executionOrder: regions.map(region => region.input.id),
    regions: facts.regions.map(fact => ({
      ...fact, status: 'committed_with_error', compactionId: reservedId,
      replacementSeq: reservedSeq, error: 'x',
      replacementRouteTokens: Number.MAX_SAFE_INTEGER,
      replacementHeuristicTokens: Number.MAX_SAFE_INTEGER,
      result: { compactionId: reservedId, startSeq: reservedSeq, summarySeq: reservedSeq,
        endSeq: reservedSeq, summary: [], shadowedRange: { start: reservedSeq, end: reservedSeq },
        shadowedSeqs: [], shadowedTokenCount: fact.shadowedHeuristicTokens },
    })),
  }
  renderBatchFacts(reserve, config)
  renderBatchFacts(reserve, config, {
    isError: true,
    error: { message: 'x', info: { name: 'ToolExecutionAbortedError', code: 'ABORTED' } },
    content: [{ type: 'text', text: 'x' }],
  })
  const ordered = [...regions].sort((a, b) => b.startIndex - a.startIndex)
  for (const region of ordered) {
    const fact = facts.regions[region.inputIndex]!
    const emitted: SessionEvent[] = []
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session) emitted.push(event)
    })
    try {
      exec.signal.throwIfAborted()
      await revalidate(ctx, agent, identity, region, config)
      exec.signal.throwIfAborted()
      facts.executionOrder.push(region.input.id)
      fact.result = await engine.compactPrewritten(region, agent, identity, exec.signal)
      fact.compactionId = fact.result.compactionId
      observeCommit(fact, emitted)
      fact.status = 'committed'
      const replacement = ctx.tokenMeter.measure(agent.session).nodes.find(node => node.seq === fact.replacementSeq)
      if (replacement !== undefined) {
        fact.replacementRouteTokens = replacement.tokens
        fact.replacementHeuristicTokens = replacement.heuristicTokens
      }
    } catch (error: unknown) {
      fact.error = error instanceof Error ? error.message : String(error)
      fact.status = observeCommit(fact, emitted) ? 'committed_with_error' : 'failed'
      // A durable summary without observable replacement cannot confirm the commit outcome.
      if (fact.compactionId !== undefined && fact.replacementSeq === undefined
        && region.seqs.some(seq => !agent.session.surface.nodes.includes(seq))) fact.status = 'unconfirmed'
      facts.stopReason = fact.error
      facts.status = facts.regions.some(item => item.status === 'committed' || item.status === 'committed_with_error' || item.status === 'unconfirmed') ? 'partial' : 'all_failed'
      return renderBatchFacts(facts, config)
    } finally {
      dispose()
    }
  }
  facts.status = 'batch_success'
  return renderBatchFacts(facts, config)
}
