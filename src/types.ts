/** Shared ACP module inputs and execution-local durable facts. */
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { BasicCompactionConfig, ResolvedConfig as BasicResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionId, CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, Message, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Literal substring of one eligible current derived text block, optionally limited by actual role; ACP displays are excluded. */
export interface TextEndpoint {
  readonly text: string
  readonly role?: Message['role']
}

/** One model-written replacement. */
export interface RegionInput {
  /** Exactly two endpoints; both complete nodes are included. */
  readonly range: readonly TextEndpoint[]
  readonly summary: string
}

/** One independently submitted native/both tool call. */
export interface CompressInput {
  readonly regions: readonly RegionInput[]
}

/** Thresholds for one exact working-model route. */
export interface PressureRoute {
  readonly provider: string
  readonly model: string
  readonly nudgeAtTokens: number
  readonly resetBelowTokens: number
}

/** ACP settings, deliberately separate from the native Basic settings. */
export interface AcpConfig {
  readonly maxRegions: number
  readonly summaryMaxTokens: number
  readonly summaryMaxBytes: number
  readonly resultMaxBytes: number
  readonly confirmationMaxTokens: number
  readonly confirmationMaxBytes: number
  readonly reminderMaxTokens: number
  readonly reminderMaxBytes: number
  readonly taskSourceKinds: readonly string[]
  readonly pressureRoutes: readonly PressureRoute[]
}

/** Loader configuration; Basic owns native auto/pruner/overflow policy. */
export interface PluginConfig {
  readonly acp: AcpConfig
  readonly basic: BasicCompactionConfig
}

/** Normal, appended assistant author accepted by the independent-call guard. */
export interface ExecutionIdentity {
  readonly sessionId: SessionId
  readonly turn: number
  readonly step: number
  readonly assistantSeq: SessionSeq
  readonly callId: ToolCallId
  readonly provider: string
  readonly model: string
}

/** Preflight fixes one expanded selection and its interpreted messages. */
export interface ResolvedRegion {
  readonly input: RegionInput
  readonly inputIndex: number
  readonly expanded: boolean
  readonly start: SessionSeq
  readonly end: SessionSeq
  readonly endpointSeqs: readonly [SessionSeq, SessionSeq]
  readonly startIndex: number
  readonly endIndex: number
  readonly seqs: readonly SessionSeq[]
  readonly events: readonly SessionEvent[]
  readonly messages: readonly (Message | null)[]
  readonly measurement: TokenMeasurement
  readonly shadowedRouteTokens: number
  readonly shadowedHeuristicTokens: number
}

/** Actual replacement evidence remains available even if native closing throws. */
export interface RegionFact {
  readonly inputIndex: number
  readonly range: readonly TextEndpoint[]
  expanded: boolean
  status: 'not_attempted' | 'committed' | 'committed_with_error' | 'failed' | 'unconfirmed'
  compactionId?: CompactionId
  replacementSeq?: SessionSeq
  result?: CompactionResult
  replacementRouteTokens?: number
  replacementHeuristicTokens?: number
  error?: string
  readonly shadowedSeqs: readonly SessionSeq[]
  readonly shadowedRouteTokens: number
  readonly shadowedHeuristicTokens: number
}

/** Final body outcome, before the tool registry's cancellation and post policies. */
export interface BatchFacts {
  status: 'batch_success' | 'partial' | 'all_failed'
  readonly regions: RegionFact[]
  readonly executionOrder: number[]
  stopReason?: string
}

/** Exact adjacent assistant/result pair eligible for pre-step maintenance. */
export interface HideCandidate {
  readonly identity: ExecutionIdentity
  readonly execution: Readonly<ToolExecution>
  readonly assistantSeq: SessionSeq
  readonly toolCallSeq: SessionSeq
  readonly resultSeq: SessionSeq
  readonly facts: {
    readonly status: BatchFacts['status']
    readonly regions: readonly Pick<RegionFact, 'inputIndex' | 'status' | 'range' | 'expanded' | 'error'>[]
    readonly stopReason?: string
  }
}

/** Maps are owned by the single composition effect, not persistent queues. */
export interface AcpState {
  readonly identities: WeakMap<Readonly<ToolExecution>, ExecutionIdentity>
  readonly facts: WeakMap<Readonly<ToolExecution>, BatchFacts>
  readonly hideCandidates: WeakMap<Agent, HideCandidate>
}

/** Exact awaited pre-step payload passed through the single wrapper. */
export interface PreStepFrame {
  readonly agent: Agent
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** Guard worker registers policies/observers and returns the admitted identity. */
export interface GuardHooks {
  requireIdentity(exec: Readonly<ToolExecution>): ExecutionIdentity
  finalizeContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
}

/** Hide worker observes final results; this hook runs before native pressure. */
export interface HideHooks {
  cleanupBeforeNative(frame: PreStepFrame): void | Promise<void>
}

/** Reminder worker measures after native processing and preserves decision metadata. */
export interface ReminderHooks {
  noticeAfterNative(frame: PreStepFrame, decision: PreStepDecision): Promise<PreStepDecision>
}

/** Reminder initialization reads the real resolved native policy, never ACP defaults. */
export type ReminderBasicConfig = BasicResolvedConfig
