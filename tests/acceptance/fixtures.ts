import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/** External model script; exhausted scripts fail rather than hiding extra requests. */
export type ScriptedReply = readonly ContentBlock[] | ((request: GenerateOptions) => readonly ContentBlock[])

/** Records real Loop requests but does not manufacture provider usage or pricing evidence. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: { provider: string; model: string; messages: RequestMessage[] }[] = []

  constructor(private readonly replies: readonly ScriptedReply[], private readonly capacity = 100_000) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.capacity } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.length
    this.requests.push({ provider: options.provider, model: options.model, messages: structuredClone(options.messages) })
    const reply = this.replies[index]
    if (reply === undefined) throw new Error('Unexpected model request ' + (index + 1))
    const blocks = typeof reply === 'function' ? reply(options) : reply
    for (const [blockIndex, block] of blocks.entries()) {
      yield { type: 'block-start', index: blockIndex, blockType: block.type }
      yield { type: 'block-end', index: blockIndex, block }
    }
    yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
  }
}

export const HISTORY = [
  { label: 'older-a', text: 'Completed analysis A: preserve exact symbol alpha and its failing assertion. ' + 'old detail A '.repeat(120) },
  { label: 'keep-middle', text: 'KEEP MIDDLE: do not change the public command and do not install dependencies.' },
  { label: 'older-b', text: 'Completed analysis B: preserve exact symbol beta and unresolved verification. ' + 'old detail B '.repeat(120) },
] as const

/** Mounts production services; callers own optional plugins, adapter script, and teardown. */
export async function createLoopFixture(replies: readonly ScriptedReply[], beforeLoop?: (ctx: Context) => Promise<void>) {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new ScriptedAdapter(replies)
    ctx.llm.registerAdapter(['acceptance'], adapter)
    await beforeLoop?.(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('active-context-acceptance'), {
      provider: 'acceptance', model: 'scripted',
    }, { cwd: '/acceptance/isolated-workspace' })
    return { ctx, adapter, agent }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/** Three completed real Turns provide two nonadjacent historical regions and a middle sentinel. */
export async function seedHistory(agent: Agent): Promise<void> {
  for (const item of HISTORY) await runTurn(agent, item.text)
}

/** Sends one task through the real Inbox and waits for production Loop settlement. */
export async function runTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}
