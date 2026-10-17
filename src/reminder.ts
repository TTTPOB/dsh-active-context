/** Post-native pressure notices; only durable user-message commits consume an episode. */
import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { protectedNodes, sampleSurface, type SurfaceCapture } from './protection.ts'
import { protectionGroups } from './boundaries.ts'
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

function notice(ctx: Context, config: AcpConfig, measurement: TokenMeasurement, nativeAt: number, surface: SurfaceCapture, frame: PreStepFrame): UserMessage {
  const protection = protectedNodes(surface, frame, config, 'pre-step')
  const groups = protectionGroups(surface, protection)
  const core = 'Host context maintenance notice: context pressure is high.\n'
    + `T≈${measurement.totalTokens} tokens; native automatic compaction threshold H=${nativeAt}.\n`
    + 'Use context_compress to summarize completed work that no longer needs verbatim history. '
    + 'Prefer a complete multi-message work phase over isolated reports. '
    + `Select 1–${config.maxRegions} non-overlapping regions using distinctive literal text endpoints; read back history if needed. `
    + 'Every range must stay in one section between protected boundaries; any finer range within that section is allowed. '
    + 'The map does not prescribe compression ranges. B labels and protected clues identify boundaries, not selectable endpoints; choose actual text + optional role from messages inside a section. '
    + 'Tool-span completion can reach protection and reject a range; this current map does not replace validation. '
    + 'New input/current entering Step is not in this pre-step Surface map and cannot be selected. Current executing Step is always a hard rejection. '
    + 'Submit one standalone native call, or one PTC run_code with code exactly return await tools.context_compress(<JSON literal>);. No other statements, task prose or tools.'
  let message = createUserMessage({
    content: [{ type: 'text', text: core }],
    source: { kind: 'acp-pressure', form: 'notice', summary: boundContextSummary('High context pressure; summarize completed history.') },
  })
  const render = (selected: typeof groups) => {
    const ordered = [...selected].sort((a, b) => a.start - b.start)
    const omitted = groups.length - ordered.length
    const nodes = protection.size - ordered.reduce((sum, group) => sum + group.count, 0)
    return core + '\nProtected boundaries in Surface order (consecutive same-class nodes grouped):\n'
      + (ordered.length === 0 ? '[none listed]\n' : ordered.map(group => group.text).join('\n') + '\n')
      + (omitted === 0 ? 'All current Surface protection groups listed.'
        : `Omitted ${omitted} protection groups (${nodes} nodes); there are unlisted boundaries. Do not assume an unlisted section is clear.`)
  }
  const fits = (text: string) => {
    message = { ...message, content: [{ type: 'text', text }] }
    return ctx.tokenMeter.estimateMessage(message) <= config.reminderMaxTokens
      && Buffer.byteLength(JSON.stringify(message), 'utf8') <= config.reminderMaxBytes
  }
  const selected: typeof groups = []
  // Make easily missed task/carrier nodes visible before spending room on instructions.
  if (fits(render(selected))) {
    for (const group of [...groups].sort((a, b) => Number(b.hasLatestTask) - Number(a.hasLatestTask))) {
      if (fits(render([...selected, group]))) selected.push(group)
    }
    message = { ...message, content: [{ type: 'text', text: render(selected) }] }
  } else {
    const requiredTokens = ctx.tokenMeter.estimateMessage(message)
    const requiredBytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
    throw new Error('ACP: complete pressure notice exceeds reminder budgets: '
      + `required estimated tokens=${requiredTokens}, actual UTF-8 bytes=${requiredBytes}; `
      + `configured reminderMaxTokens=${config.reminderMaxTokens}, reminderMaxBytes=${config.reminderMaxBytes}. `
      + 'Increase reminderMaxTokens/reminderMaxBytes to fit the complete notice.')
  }
  return message
}

/**
 * Install commit observation and return the composer's post-native hook.
 * Exact routes override pressureDefault ratios of the maximum contextWindow.
 * Without either setting, early notices are disabled. Missing capacity and invalid dynamic H are
 * diagnosed once per route; native handling and the admitted decision survive.
 * The map explicitly counts omitted groups; an over-budget core throws without consuming the episode.
 * @param ctx - Plugin effect context with the production meter and LLM runtime.
 * @param config - ACP budgets and exact-route R/S thresholds.
 * @param basic - Validated configuration owned by the native Basic provider.
 * @returns A hook that preserves all decision metadata and never creates a request.
 */
export function installReminder(ctx: Context, config: AcpConfig, basic: ReminderBasicConfig): ReminderHooks {
  const episodes = new WeakMap<Session, Episode>()
  const episodeFor = (session: Session): Episode => {
    let episode = episodes.get(session)
    if (episode === undefined) {
      episode = { reminded: previouslyReminded(session) }
      episodes.set(session, episode)
    }
    return episode
  }
  const warned = new Set<string>()
  let active = true
  ctx.effect(() => () => { active = false })
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
    hasPendingReminder: session => episodeFor(session).reminded,
    async noticeAfterNative(frame, decision) {
      if (!active || (config.pressureRoutes.length === 0 && config.pressureDefault === undefined)
        || decision.kind === 'reject' || frame.signal.aborted) return decision
      // Match Loop/model-selection suppression: a notice must not wake a skipped step.
      if (decision.messages.length === 0 && (frame.step === 1 || frame.messages.length > 0)) return decision
      const session = frame.agent.session
      const header = session.requestHeader()
      if (header === undefined) return decision
      const route = config.pressureRoutes.find(route => route.provider === header.config.provider && route.model === header.config.model)
      if (route === undefined && config.pressureDefault === undefined) return decision
      const { provider, model } = header.config
      const key = `${provider}/${model}`
      let info
      try {
        info = await ctx.llm.resolveModelInfo(provider, model, frame.signal)
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
      const nudgeAtTokens = route?.nudgeAtTokens ?? Math.floor(capacity * config.pressureDefault!.nudgeAtRatio)
      const resetBelowTokens = route?.resetBelowTokens ?? Math.floor(capacity * config.pressureDefault!.resetBelowRatio)
      const override = basic.modelPolicies.find(policy => policy.provider === provider && policy.model === model)
      const output = header.config.maxTokens ?? info.defaultMaxTokens ?? 0
      const nativeAt = Math.floor(Math.min(capacity * (override?.thresholdRatio ?? basic.thresholdRatio),
        capacity - output - (override?.headroomTokens ?? basic.headroomTokens)))
      if (!(resetBelowTokens < nudgeAtTokens && nudgeAtTokens < nativeAt)) {
        warn(key, `requires R < S < H; got R=${resetBelowTokens}, S=${nudgeAtTokens}, H=${nativeAt} (C=${capacity}, O=${output})`)
        return decision
      }
      const measurement = ctx.tokenMeter.measure(session)
      let episode = episodes.get(session)
      if (measurement.totalTokens < resetBelowTokens) {
        episode = { reminded: false }
        episodes.set(session, episode)
      } else episode = episodeFor(session)
      if (episode.reminded || measurement.totalTokens < nudgeAtTokens) return decision
      const message = await ctx.sessionQuery.captureSession(frame.agent.id, (reader, observation) =>
        notice(ctx, config, measurement, nativeAt, sampleSurface(frame.agent, reader, observation), frame), { projectionMode: 'none' })
      episode.candidate = message.id
      return { ...decision, messages: [...decision.messages, message] }
    },
  }
}
