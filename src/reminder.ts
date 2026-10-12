/** Post-native pressure notices; only durable user-message commits consume an episode. */
import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { AcpConfig, ReminderBasicConfig, ReminderHooks } from './types.ts'

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

function notice(ctx: Context, config: AcpConfig, measurement: TokenMeasurement, nativeAt: number): UserMessage {
  const message = createUserMessage({
    content: [{ type: 'text', text:
      'Host context maintenance notice: context pressure is high.\n'
      + `T≈${measurement.totalTokens} tokens; native automatic compaction threshold H=${nativeAt}.\n`
      + 'Use context_compress to summarize completed work that no longer needs verbatim history. '
      + 'Prefer a complete multi-message work phase over isolated reports. '
      + `Select 1–${config.maxRegions} non-adjacent regions using distinctive literal text endpoints; read back history if needed. `
      + 'Exclude protected nodes; tool pairs are completed automatically before validation. '
      + 'Submit one standalone native/both call, with no task prose or other tools.',
    }],
    source: { kind: 'acp-pressure', form: 'notice', summary: boundContextSummary('High context pressure; summarize completed history.') },
  })
  const requiredTokens = ctx.tokenMeter.estimateMessage(message)
  const requiredBytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
  if (requiredTokens > config.reminderMaxTokens || requiredBytes > config.reminderMaxBytes) {
    throw new Error('ACP: complete pressure notice exceeds reminder budgets: '
      + `required estimated tokens=${requiredTokens}, actual UTF-8 bytes=${requiredBytes}; `
      + `configured reminderMaxTokens=${config.reminderMaxTokens}, reminderMaxBytes=${config.reminderMaxBytes}. `
      + 'Increase reminderMaxTokens/reminderMaxBytes to fit the complete notice.')
  }
  return message
}

/**
 * Install commit observation and return the composer's post-native hook.
 * Empty pressureRoutes explicitly disables early notices, not native compaction.
 * Unlisted routes are not enabled. Missing capacity and invalid dynamic H are
 * diagnosed once per route; native handling and the admitted decision survive.
 * A complete notice exceeding either budget throws at generation without consuming the episode.
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
      const message = notice(ctx, config, measurement, nativeAt)
      episode.candidate = message.id
      return { ...decision, messages: [...decision.messages, message] }
    },
  }
}
