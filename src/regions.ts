/** Independent region validation and tail-to-head native transactions without rollback. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CompactionId, toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'
import { assertCompleteToolPairs, expandToolPairs, RegionSelectionError, protectedNodes, sampleSurface, type ProtectionReason, type SurfaceCapture } from './protection.ts'
import { literalClue, safeSplitRanges } from './boundaries.ts'
import { endpointMatches } from './endpoints.ts'
import type { ActiveCompactionEngine } from './provider.ts'
import type { AcpConfig, AcpState, BatchFacts, CompressInput, ExecutionIdentity, RegionFact, ResolvedRegion, TextEndpoint } from './types.ts'
import type { ToolExecutionFailure, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Reject malformed author budgets before any native compaction transaction starts. */
function validateInput(ctx: Context, input: CompressInput, config: AcpConfig): void {
  if (input.regions.length === 0 || input.regions.length > config.maxRegions) {
    throw new Error(`ACP: submit 1-${config.maxRegions} non-adjacent regions`)
  }
  let bytes = 0
  let tokens = 0
  input.regions.forEach((region, index) => {
    if (region.range.length !== 2) throw new Error(`ACP: region ${index} requires exactly two text endpoints`)
    region.range.forEach((endpoint, position) => {
      if (endpoint.text.length === 0) throw new Error(`ACP: region ${index} endpoint ${position} text must not be empty`)
    })
    if (region.summary.trim().length === 0) throw new Error(`ACP: summary ${index} must not be empty`)
    bytes += Buffer.byteLength(region.summary, 'utf8')
    tokens += ctx.tokenMeter.estimateMessage(createUserMessage({ content: [{ type: 'text', text: region.summary }], source: { kind: 'user' } }))
  })
  if (bytes > config.summaryMaxBytes || tokens > config.summaryMaxTokens) {
    throw new Error(`ACP: batch summaries exceed the total budget (${tokens} tokens, ${bytes} bytes)`)
  }
}

/** Scan every current node; multiple matching blocks within one node count once. */
function resolveEndpoint(surface: SurfaceCapture, endpoint: TextEndpoint, regionIndex: number, position: number): number {
  const matches = endpointMatches(surface, endpoint)
  if (matches.length === 1) return matches[0]!.index
  const bounded = (text: string) => Array.from(text).slice(0, 160).join('')
  const clues = matches.slice(0, 4).map(match => ({ role: match.role, text: bounded(match.text) }))
  throw new RegionSelectionError(`ACP: region ${regionIndex} endpoint ${position} ${matches.length === 0 ? 'has no match' : 'is ambiguous'} in eligible current derived message text blocks (case-sensitive literal substring, no normalization; ACP pressure/status displays and context_compress results excluded as endpoints). Choose more distinctive text or add role. ${JSON.stringify({ text: bounded(endpoint.text), role: endpoint.role, clues })}`)
}

/** Report bounded blocker text and reasons without introducing another selection interface. */
function assertUnprotected(
  surface: SurfaceCapture, seqs: readonly SessionSeq[], protection: ReadonlyMap<SessionSeq, readonly ProtectionReason[]>,
  regionIndex: number, phase: 'preflight' | 'revalidation', agent: Agent, originalStart: number, originalEnd: number,
): void {
  const blocked = seqs.filter(seq => protection.has(seq))
  if (blocked.length === 0) return
  const blockers = blocked.slice(0, 4).map(seq => {
    const index = surface.seqs.indexOf(seq)
    const message = surface.messages[index]
    const clue = literalClue(surface, index)
    return {
      role: message?.role ?? null,
      event_type: surface.events[index]?.type,
      reasons: protection.get(seq),
      text_excerpt: clue.text_excerpt,
      unique: clue.unique,
    }
  })
  const splits = blocked.some(seq => protection.get(seq)?.includes('current_step'))
    ? { ranges: [], unavailable: 'current_step is a hard rejection; no split suggestions' }
    : safeSplitRanges(surface, protection, agent.session, originalStart, originalEnd)
  const status = `${phase} rejected this region; independent regions may continue.`
  const carrier = blocked.some(seq => protection.get(seq)?.includes('latest_task_checkpoint'))
    ? ' A blocked summary carries the latest request driving the current Turn and is protected until a newer request arrives.' : ''
  throw new RegionSelectionError(
    `ACP: region ${regionIndex} contains protected context. ${status}`
    + ` Protected blockers: ${blocked.length}; showing ${blockers.length}. ${JSON.stringify(blockers)}`
    + carrier
    + ` Safe split ranges (within original range; write a separate summary for each; finer selections allowed): ${JSON.stringify(splits)}.`
    + ' Each range includes both complete endpoint nodes and every node between them. Move the boundaries or split around the blockers. Tool-call/result pairs are automatically completed before protection checks. Retry with distinctive literal text endpoints, not diagnostic metadata. A null text_excerpt means the node has no text block.',
  )
}

/** Resolve independent selections, then reject every participant in a positional conflict. */
export async function preflightRegions(
  ctx: Context, agent: Agent, identity: ExecutionIdentity, input: CompressInput, config: AcpConfig,
): Promise<{ regions: ResolvedRegion[]; facts: RegionFact[] }> {
  validateInput(ctx, input, config)
  return ctx.sessionQuery.captureSession(agent.id, (reader, observation) => {
    const surface = sampleSurface(agent, reader, observation)
    const protection = protectedNodes(surface, identity, config)
    const measurement = ctx.tokenMeter.measure(agent.session)
    if (!isDeepStrictEqual(measurement.nodes.map(node => node.seq), surface.seqs)) throw new Error('ACP: Surface changed during preflight; select current text again')
    const facts: RegionFact[] = input.regions.map((item, inputIndex) => ({
      inputIndex, range: item.range, expanded: false, status: 'not_attempted',
      shadowedSeqs: [], shadowedRouteTokens: 0, shadowedHeuristicTokens: 0,
    }))
    const resolved: ResolvedRegion[] = []
    input.regions.forEach((item, inputIndex) => {
      const fact = facts[inputIndex]!
      try {
        const originalStart = resolveEndpoint(surface, item.range[0]!, inputIndex, 0)
        const originalEnd = resolveEndpoint(surface, item.range[1]!, inputIndex, 1)
        if (originalEnd < originalStart) throw new RegionSelectionError(`ACP: region ${inputIndex} endpoints are reversed`)
        const { start: startIndex, end: endIndex, missingCounterpart } = expandToolPairs(surface.messages, originalStart, originalEnd)
        const seqs = surface.seqs.slice(startIndex, endIndex + 1)
        const measured = measurement.nodes.slice(startIndex, endIndex + 1)
        const region: ResolvedRegion = {
          input: item, inputIndex, expanded: startIndex !== originalStart || endIndex !== originalEnd,
          start: seqs[0]!, end: seqs.at(-1)!, endpointSeqs: [surface.seqs[originalStart]!, surface.seqs[originalEnd]!], startIndex, endIndex, seqs,
          events: surface.events.slice(startIndex, endIndex + 1), messages: surface.messages.slice(startIndex, endIndex + 1), measurement,
          shadowedRouteTokens: measured.reduce((sum, node) => sum + node.tokens, 0),
          shadowedHeuristicTokens: measured.reduce((sum, node) => sum + node.heuristicTokens, 0),
        }
        facts[inputIndex] = { ...fact, expanded: region.expanded, shadowedSeqs: seqs,
          shadowedRouteTokens: region.shadowedRouteTokens, shadowedHeuristicTokens: region.shadowedHeuristicTokens }
        // Keep known selections for conflicts even when pairing or protection rejects them.
        resolved.push(region)
        if (missingCounterpart) throw new RegionSelectionError(`ACP: region ${inputIndex} tool call/result counterpart is missing from the current context`)
        if (!toolPairingBalancedBefore(agent.session, region.start) || !toolPairingBalancedAfter(agent.session, region.end)) {
          throw new RegionSelectionError(`ACP: region ${inputIndex} cannot complete balanced native tool-pair boundaries in the current context`)
        }
        assertUnprotected(surface, seqs, protection, inputIndex, 'preflight', agent, originalStart, originalEnd)
      } catch (error) {
        if (!(error instanceof RegionSelectionError)) throw error
        facts[inputIndex]!.status = 'failed'
        facts[inputIndex]!.error = error.message
      }
    })
    for (let left = 0; left < resolved.length; left += 1) {
      for (let right = left + 1; right < resolved.length; right += 1) {
        const a = resolved[left]!
        const b = resolved[right]!
        if (a.startIndex > b.endIndex + 1 || b.startIndex > a.endIndex + 1) continue
        for (const region of [a, b]) {
          const fact = facts[region.inputIndex]!
          fact.status = 'failed'
          const reason = `ACP: regions ${a.inputIndex} and ${b.inputIndex} overlap or are adjacent after tool-pair expansion; select them again`
          fact.error = fact.error === undefined ? reason : fact.error + '\n' + reason
        }
      }
    }
    return { regions: resolved.filter(region => facts[region.inputIndex]!.status !== 'failed'), facts }
  }, { projectionMode: 'none' })
}

/** Re-resolve each original node list after earlier native replacements. */
async function revalidate(ctx: Context, agent: Agent, identity: ExecutionIdentity, region: ResolvedRegion, config: AcpConfig): Promise<void> {
  await ctx.sessionQuery.captureSession(agent.id, (reader, observation) => {
    const surface = sampleSurface(agent, reader, observation)
    const start = surface.seqs.indexOf(region.start)
    const end = surface.seqs.indexOf(region.end)
    if (start < 0 || end < start || !isDeepStrictEqual(surface.seqs.slice(start, end + 1), region.seqs)
      || !isDeepStrictEqual(surface.events.slice(start, end + 1), region.events)
      || !isDeepStrictEqual(surface.messages.slice(start, end + 1), region.messages)) {
      throw new RegionSelectionError(`ACP: target ${region.inputIndex} changed since preflight; select current text again`)
    }
    const protection = protectedNodes(surface, identity, config)
    assertUnprotected(surface, region.seqs, protection, region.inputIndex, 'revalidation', agent,
      surface.seqs.indexOf(region.endpointSeqs[0]), surface.seqs.indexOf(region.endpointSeqs[1]))
    assertCompleteToolPairs(surface.messages.slice(start, end + 1))
  }, { projectionMode: 'none' })
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
    cleanup: finalError !== undefined || facts.regions.some(fact => fact.status === 'unconfirmed') ? 'retained'
      : facts.regions.some(fact => fact.status === 'committed' || fact.status === 'committed_with_error') ? 'pending_final_settlement' : 'not_eligible',
    retry: 'Reselect only failed/not_attempted regions using current text; committed original endpoints may no longer match.',
    final_error: finalError === undefined ? undefined : {
      name: finalError.error.info?.name,
      code: finalError.error.info?.code,
      message: finalError.error.message,
      content: finalError.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
    },
    execution_order: facts.executionOrder,
    stop_reason: facts.stopReason,
    regions: facts.regions.map(fact => ({
      input_index: fact.inputIndex, status: fact.status, range: fact.range, expanded: fact.expanded,
      compaction_id: fact.compactionId, replacement_seq: fact.replacementSeq,
      node_count: fact.shadowedSeqs.length,
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

/** Submit valid regions tail to head; only attributable selection/shrink failures continue. */
export async function submitRegions(
  ctx: Context, engine: ActiveCompactionEngine, exec: ToolRunContext,
  identity: ExecutionIdentity, input: CompressInput, config: AcpConfig, state: AcpState,
): Promise<string> {
  const agent = exec.agent
  if (agent === undefined || agent.id !== identity.sessionId || identity.callId !== exec.callId) throw new Error('ACP: execution identity does not match the calling Agent')
  exec.signal.throwIfAborted()
  const { regions, facts: regionFacts } = await preflightRegions(ctx, agent, identity, input, config)
  const facts: BatchFacts = {
    status: 'all_failed', executionOrder: [],
    regions: regionFacts,
  }
  state.facts.set(exec, facts)
  // Reserve enough output space for the bounded native identifiers before the first write.
  const reservedSeq = SessionSeq(Number.MAX_SAFE_INTEGER)
  const reservedId = CompactionId('00000000-0000-0000-0000-000000000000')
  const reserve: BatchFacts = { ...facts, status: 'batch_success', stopReason: 'x',
    executionOrder: regions.map(region => region.inputIndex),
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
      facts.executionOrder.push(region.inputIndex)
      fact.result = await engine.compactPrewritten(region, agent, identity, exec.signal)
      fact.compactionId = fact.result.compactionId
      if (!observeCommit(fact, emitted)) throw new Error('ACP: native result has no observable replacement; commit is unconfirmed')
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
        && (fact.result !== undefined || region.seqs.some(seq => !agent.session.surface.nodes.includes(seq)))) fact.status = 'unconfirmed'
      const closedShrinkFailure = fact.compactionId === undefined
        && fact.error.startsWith('summary is not smaller than the shadowed content (')
        && emitted.some(event => event.type === 'compaction/end' && event.data.error !== undefined)
      if (!exec.signal.aborted && fact.status !== 'unconfirmed'
        && (error instanceof RegionSelectionError || closedShrinkFailure)) continue
      facts.stopReason = fact.error
      for (const remaining of facts.regions) {
        if (remaining.status === 'not_attempted') remaining.error = 'Execution stopped: ' + fact.error
      }
      facts.status = facts.regions.some(item => item.status === 'committed' || item.status === 'committed_with_error' || item.status === 'unconfirmed') ? 'partial' : 'all_failed'
      // Unknown host/native faults remain tool errors, not ordinary region diagnostics.
      if (!exec.signal.aborted) throw error
      return renderBatchFacts(facts, config)
    } finally {
      dispose()
    }
  }
  facts.status = facts.regions.every(fact => fact.status === 'committed') ? 'batch_success'
    : facts.regions.some(fact => fact.status === 'committed' || fact.status === 'committed_with_error') ? 'partial' : 'all_failed'
  return renderBatchFacts(facts, config)
}
