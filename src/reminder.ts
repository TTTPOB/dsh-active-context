/** Post-native pressure notices; only durable user-message commits consume an episode. */
import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { buildContextMap } from 'dsh-session-tools/context-map'
import type { ContextMapNode, ContextMapOutput } from 'dsh-session-tools/context-map'
import type { AcpConfig, PreStepFrame, ReminderBasicConfig, ReminderHooks } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'acp-pressure': { readonly kind: 'acp-pressure' } & ContextFormed
  }
}

interface Episode {
  reminded: boolean
  candidate?: MessageId
}

/** Read the original Log, including notices no longer present on the Surface. */
function previouslyReminded(session: Session): boolean {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type === 'user/message' && event.data.source.kind === 'acp-pressure'
      && event.data.source.form === 'notice') return true
  }
  return false
}

function pressureBasis(measurement: TokenMeasurement): string {
  return measurement.baseline.kind === 'usage' ? 'API usage + estimated delta' : 'estimated'
}

function shortText(tokens: number, basis: string): string {
  return `宿主上下文维护提醒：T≈${tokens} tokens（${basis}），上下文压力偏高。`
}

function fits(ctx: Context, config: AcpConfig, message: UserMessage): boolean {
  return ctx.tokenMeter.estimateMessage(message) <= config.reminderMaxTokens
    && Buffer.byteLength(JSON.stringify(message), 'utf8') <= config.reminderMaxBytes
}

/** Protect the latest task node, not all completed steps following that task. */
function latestTaskIndex(session: Session, config: AcpConfig): number {
  let taskIndex = -1
  for (let index = session.surface.nodes.length - 1; index >= 0; index--) {
    const seq = session.surface.nodes[index]!
    const event = session.eventAt(seq)!
    const message = session.deriveEventMessage(event)
    const kind: string | undefined = message?.source.kind
    const form = message !== null && 'form' in message.source ? message.source.form : undefined
    if (message?.role === 'user' && form !== 'notice'
      && config.taskSourceKinds.includes(message.source.kind)
      && (kind !== 'agent-message' || form === 'relay')) {
      taskIndex = index
      break
    }
  }
  return taskIndex
}

function standaloneCandidate(session: Session, seq: ReturnType<typeof SessionSeq>, index: number, taskIndex: number): boolean {
  const message = session.deriveEventMessage(session.eventAt(seq)!)
  return index !== taskIndex && message !== null
    && message.role !== 'system' && message.role !== 'developer' && message.role !== 'tool'
    && (!('form' in message.source) || message.source.form !== 'instructions')
    && !message.content.some(block => block.type === 'tool-call')
}

/** Select only old standalone messages; paired tools and live instructions are never suggested. */
function suggestedNodes(session: Session, map: ContextMapOutput, frame: PreStepFrame, config: AcpConfig): ContextMapNode[] {
  const taskIndex = latestTaskIndex(session, config)
  const selected: ContextMapNode[] = []
  for (const node of map.nodes) {
    if (selected.length >= config.reminderMaxRegions) break
    if ((node.navigation.turn === frame.turn && node.navigation.step === frame.step)
      || selected.at(-1)?.surface_index === node.surface_index - 1
      || !standaloneCandidate(session, SessionSeq(node.seq), node.surface_index, taskIndex)) continue
    selected.push(node)
  }
  return selected
}

/** Sample the current Session and the shared map in one synchronous read interval. */
function mapForNotice(ctx: Context, frame: PreStepFrame, config: AcpConfig, measurement: TokenMeasurement): ContextMapOutput {
  const session = frame.agent.session
  const cut = session.seq
  const projections = ctx.get('sessionProjections')?.snapshot(session, ['contextPressure', 'contextBreakdown'])
  const limit = Math.max(1, config.reminderMaxRegions * 2)
  const taskIndex = latestTaskIndex(session, config)
  const first = session.surface.nodes.find((seq, index) => standaloneCandidate(session, seq, index, taskIndex))
  return buildContextMap(session, {
    source: 'live',
    cursor: cut === 0 ? -1 : SessionSeq(cut - 1),
    readEvents: (from, to) => session.snapshotEvents(from, SessionLogOffset(Math.min(to, cut))),
    ...projections === undefined ? {} : { projections },
  }, measurement, {
    view: 'messages', metering: 'require', limit,
    ...first === undefined ? {} : {
      window: { anchor: { seq: first, edge: 'before' }, side: 'after' },
    },
  }, {
    mapPageSize: limit, mapMaxPageSize: limit, mapMaxSpans: config.reminderMaxRegions,
    previewChars: config.reminderPreviewChars,
    // The emitted notice, including framing and metadata, is bounded below.
    outputBytes: Number.MAX_SAFE_INTEGER,
  })
}

function notice(ctx: Context, frame: PreStepFrame, config: AcpConfig, measurement: TokenMeasurement, nativeAt: number): UserMessage {
  const basis = pressureBasis(measurement)
  const short = createUserMessage({
    content: [{ type: 'text', text: shortText(measurement.totalTokens, basis) }],
    source: { kind: 'acp-pressure', form: 'notice', summary: boundContextSummary('上下文压力偏高；请准备维护摘要') },
  })
  if (!fits(ctx, config, short)) throw new Error('ACP: reminder budgets cannot fit the complete short pressure notice')
  const heading = `宿主上下文维护提醒：T≈${measurement.totalTokens} tokens；原生自动压缩线 H=${nativeAt}。\n`
    + `计量依据：${basis}；baseline=${measurement.baseline.tokens}，delta=${measurement.surfaceDeltaTokens}。`
  const withText = (text: string) => freezeMessage({ ...short, content: [{ type: 'text' as const, text }] })
  const pressureOnly = withText(heading)
  if (config.reminderMaxRegions === 0) return fits(ctx, config, pressureOnly) ? pressureOnly : short
  const map = mapForNotice(ctx, frame, config, measurement)
  const nodes = suggestedNodes(frame.agent.session, map, frame, config)
  if (nodes.length === 0) return fits(ctx, config, pressureOnly) ? pressureOnly : short
  const render = (count: number, previewChars: number): UserMessage => withText(heading
    + `\n可先回读以下旧消息，准备摘要；保留当前任务与存活指令。\nsnapshot_ref=${JSON.stringify(map.snapshot_ref)}`
    + nodes.slice(0, count).map(node => `\n${JSON.stringify({
      source: node.source, locator: node.locator, estimated_tokens: node.estimated_tokens,
      read: { session_id: map.snapshot_ref.session_id, seq: node.seq },
      ...previewChars === 0 ? {} : { preview: Array.from(node.preview).slice(0, previewChars).join('') },
    })}`).join('')
    + '\n回读入口：session_event_read；更多区间：session_context_map。')
  // Shrink previews first, then intervals, then keep the pressure-only notice.
  for (let chars = config.reminderPreviewChars; chars > 0; chars = Math.floor(chars / 2)) {
    const candidate = render(nodes.length, chars)
    if (fits(ctx, config, candidate)) return candidate
  }
  for (let count = nodes.length; count > 0; count--) {
    const candidate = render(count, 0)
    if (fits(ctx, config, candidate)) return candidate
  }
  return fits(ctx, config, pressureOnly) ? pressureOnly : short
}

/**
 * Install commit observation and return the composer's post-native hook.
 * Empty pressureRoutes explicitly disables early notices, not native compaction.
 * Unlisted routes are not enabled. Missing capacity and invalid dynamic H are
 * diagnosed once per route; native handling and the admitted decision survive.
 * @param ctx - Plugin effect context with the production meter and LLM runtime.
 * @param config - ACP budgets and exact-route R/S thresholds.
 * @param basic - Validated configuration owned by the native Basic provider.
 * @returns A hook that preserves all decision metadata and never creates a request.
 */
export function installReminder(ctx: Context, config: AcpConfig, basic: ReminderBasicConfig): ReminderHooks {
  const episodes = new WeakMap<Session, Episode>()
  const warned = new Set<string>()
  let active = true
  ctx.effect(() => () => { active = false })
  if (config.pressureRoutes.length > 0) {
    const minimum = createUserMessage({
      content: [{ type: 'text', text: shortText(Number.MAX_SAFE_INTEGER, 'API usage + estimated delta') }],
      source: { kind: 'acp-pressure', form: 'notice', summary: boundContextSummary('上下文压力偏高；请准备维护摘要') },
    })
    if (!fits(ctx, config, minimum)) throw new Error('ACP: reminderMaxTokens/reminderMaxBytes must fit a complete short pressure notice')
  }
  ctx.on('session/event', (session, event) => {
    const episode = episodes.get(session)
    if (episode === undefined || event.type !== 'user/message' || event.surfaceOp !== 'append'
      || event.data.id !== episode.candidate || event.data.source.kind !== 'acp-pressure'
      || event.data.source.form !== 'notice') return
    episode.reminded = true
    delete episode.candidate
  })
  const warn = (route: string, detail: string) => {
    if (warned.has(route)) return
    warned.add(route)
    ctx.logger.warn(`ACP pressure reminder (${route}): ${detail}; native pressure handling remains enabled`)
  }
  return {
    async noticeAfterNative(frame, decision) {
      if (!active || config.pressureRoutes.length === 0 || decision.kind === 'reject' || frame.signal.aborted) return decision
      // Match Loop/model-selection suppression: a notice must not wake a skipped step.
      if (decision.messages.length === 0 && (frame.step === 1 || frame.messages.length > 0)) return decision
      const session = frame.agent.session
      const header = session.requestHeader()
      if (header === undefined) return decision
      const route = config.pressureRoutes.find(route => route.provider === header.config.provider && route.model === header.config.model)
      if (route === undefined) return decision
      const key = `${route.provider}/${route.model}`
      let info
      try {
        info = await ctx.llm.resolveModelInfo(route.provider, route.model, frame.signal)
      } catch (error) {
        if (frame.signal.aborted || !active) return decision
        warn(key, `cannot resolve model capacity: ${error instanceof Error ? error.message : String(error)}`)
        return decision
      }
      if (frame.signal.aborted || !active) return decision
      const capacity = info.context?.contextWindow
      if (capacity === undefined) {
        warn(key, 'model contextWindow is unknown; declare model capacity before enabling this pressure route')
        return decision
      }
      const override = basic.modelPolicies.find(policy => policy.provider === route.provider && policy.model === route.model)
      const output = header.config.maxTokens ?? info.defaultMaxTokens ?? 0
      const nativeAt = Math.floor(Math.min(capacity * (override?.thresholdRatio ?? basic.thresholdRatio),
        capacity - output - (override?.headroomTokens ?? basic.headroomTokens)))
      if (!(route.resetBelowTokens < route.nudgeAtTokens && route.nudgeAtTokens < nativeAt)) {
        warn(key, `requires R < S < H; got R=${route.resetBelowTokens}, S=${route.nudgeAtTokens}, H=${nativeAt} (C=${capacity}, O=${output})`)
        return decision
      }
      const measurement = ctx.tokenMeter.measure(session)
      let episode = episodes.get(session)
      if (measurement.totalTokens < route.resetBelowTokens) {
        episode = { reminded: false }
        episodes.set(session, episode)
      } else if (episode === undefined) {
        episode = { reminded: previouslyReminded(session) }
        episodes.set(session, episode)
      }
      if (episode.reminded || measurement.totalTokens < route.nudgeAtTokens) return decision
      const message = notice(ctx, frame, config, measurement, nativeAt)
      episode.candidate = message.id
      return { ...decision, messages: [...decision.messages, message] }
    },
  }
}
