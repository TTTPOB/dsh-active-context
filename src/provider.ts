/** Thin Basic provider: only model-authored calls replace the summarizer. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine, type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, Message, ToolSchema, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ExecutionIdentity, ResolvedRegion } from './types.ts'

/** Structural public vocabulary avoids importing Basic's unpublished source modules. */
interface SummaryInput {
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}
type SummaryOutput = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & ({ rawOutput: ContentBlock[]; llmStreamCall: true } | { rawOutput?: ContentBlock[]; llmStreamCall?: never })

/** Occupies the sole compaction service; automatic and overflow behavior remain inherited. */
export class ActiveCompactionEngine extends BasicCompactionEngine {
  private readonly prewritten = new WeakMap<Agent, { text: string; author: ExecutionIdentity }>()

  constructor(ctx: Context, basic: BasicCompactionConfig) {
    super(ctx, basic)
  }

  /** Submit one validated selection through the native current-turn transaction. */
  async compactPrewritten(
    region: ResolvedRegion,
    agent: Agent,
    author: ExecutionIdentity,
    signal: AbortSignal,
  ): Promise<CompactionResult> {
    if (this.prewritten.has(agent)) throw new Error('ACP: a summary is already in use for this agent')
    signal.throwIfAborted()
    this.prewritten.set(agent, { text: region.input.summary, author })
    try {
      return await super.compactRegion(region.start, region.end, agent, signal)
    } finally {
      this.prewritten.delete(agent)
    }
  }

  protected override async summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<SummaryOutput> {
    const supplied = this.prewritten.get(agent)
    if (supplied === undefined) return super.summarize(input, agent, signal)
    signal?.throwIfAborted()
    return {
      summary: [{ type: 'text', text: supplied.text }],
      provider: supplied.author.provider,
      model: supplied.author.model,
    }
  }
}
