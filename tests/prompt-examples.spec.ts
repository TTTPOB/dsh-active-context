import { expect, it } from 'vitest'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { ACP_INSTRUCTIONS, Config } from '../src/index.ts'
import { preflightRegions } from '../src/regions.ts'
import type { CompressInput, ExecutionIdentity } from '../src/types.ts'
import { loadActiveContext } from './loop-fixtures/loader.ts'
import { createLoopFixture } from './loop-fixtures/agent-loop.ts'

interface ExampleMessage {
  role: 'user' | 'assistant'
  text: string
}

/** Read the model-facing JSON examples, then exercise the actual schema and matcher. */
function exampleJson(): unknown[] {
  return [...ACP_INSTRUCTIONS.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match): unknown => JSON.parse(match[1]!))
}

function history(value: unknown): ExampleMessage[] {
  if (!Array.isArray(value)) throw new Error('Prompt history must be a JSON array')
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || !('role' in entry) || !('text' in entry)
      || (entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.text !== 'string') {
      throw new Error('Prompt history must contain role/text messages')
    }
    return { role: entry.role, text: entry.text }
  })
}

function input(schema: JsonSchemaNode, value: unknown): CompressInput {
  expect(validateJsonSchemaValue(schema, value)).toEqual([])
  return value as CompressInput
}

async function exampleFixture(messages: readonly ExampleMessage[]) {
  const fixture = await createLoopFixture([], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
  })
  const { ctx, agent } = fixture
  try {
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const seqs = messages.map(message => message.role === 'user'
      ? session.append('user/message', createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'user' } }), { surfaceOp: 'append' }).seq
      : session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: message.text }], source: { kind: 'model', provider: 'acceptance', model: 'scripted' } }) }, { surfaceOp: 'append' }).seq)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Separate current task; preserve this input.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 2, step: 1 })
    const callId = ToolCallId('prompt-example-call')
    const author = session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'context_compress', arguments: '{}' }], source: { kind: 'model', provider: 'acceptance', model: 'scripted' } }) }, { surfaceOp: 'append' })
    const identity: ExecutionIdentity = { sessionId: agent.id, turn: 2, step: 1, assistantSeq: author.seq, callId, provider: 'acceptance', model: 'scripted' }
    const schema = ctx.tools.schemas().find(tool => tool.name === 'context_compress')?.parameters
    assertSupportedJsonSchema(schema)
    return { ...fixture, seqs, identity, schema, config: Config({}).acp }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

it('the first prompt submission selects three complete old messages using interior text phrases', async () => {
  const examples = exampleJson()
  const messages = history(examples[0])
  const f = await exampleFixture(messages)
  try {
    const submitted = input(f.schema, examples[1])
    const range = submitted.regions[0]!.range
    for (const [message, endpoint] of [[messages[0]!, range[0]!], [messages[2]!, range[1]!]] as const) {
      const offset = message.text.indexOf(endpoint.text)
      expect(offset).toBeGreaterThan(0)
      expect(offset + endpoint.text.length).toBeLessThan(message.text.length)
    }
    const { regions: resolved } = await preflightRegions(f.ctx, f.agent, f.identity, submitted, f.config)
    expect(resolved[0]!.seqs).toEqual(f.seqs)
    expect(resolved[0]!.messages.map(message => message?.content)).toEqual(messages.map(message => [{ type: 'text', text: message.text }]))
  } finally { await f.ctx.fiber.dispose() }
})

it('the repeated assistant phrase is ambiguous, while the corrected prompt submission selects the whole second node', async () => {
  const examples = exampleJson()
  const messages = history(examples[2])
  const f = await exampleFixture(messages)
  try {
    const ambiguous = input(f.schema, examples[3])
    const corrected = input(f.schema, examples[4])
    const before = f.agent.session.snapshotEvents()
    await expect(preflightRegions(f.ctx, f.agent, f.identity, ambiguous, f.config)).resolves.toMatchObject({ facts: [expect.objectContaining({ status: 'failed', error: expect.stringMatching(/endpoint 0 is ambiguous/) })] })
    expect(f.agent.session.snapshotEvents()).toEqual(before)
    const { regions: resolved } = await preflightRegions(f.ctx, f.agent, f.identity, corrected, f.config)
    expect(resolved[0]!.seqs).toEqual([f.seqs[1]])
    expect(resolved[0]!.messages[0]!.content).toEqual([{ type: 'text', text: messages[1]!.text }])
  } finally { await f.ctx.fiber.dispose() }
})

it('states endpoint direction and full-node selection verbatim in both instructions and range schema', async () => {
  const orientation = 'range[0] identifies the start node and range[1] identifies the end node. The start must be at or before the end in current context order. Both endpoint nodes and all nodes between them are selected in full. If both endpoints identify the same node, only that node is selected.'
  const f = await exampleFixture(history(exampleJson()[0]))
  try {
    expect(ACP_INSTRUCTIONS).toContain(orientation)
    expect(ACP_INSTRUCTIONS).toContain('return await tools.context_compress(<JSON literal>);')
    expect(ACP_INSTRUCTIONS).toContain('PTC partial, failed, cancelled or host-overridden root pairs are retained')
    expect(JSON.stringify(f.schema)).toContain(orientation)
    expect(ACP_INSTRUCTIONS).not.toContain('Keep complete tool-call/result pairs')
    expect(ACP_INSTRUCTIONS).toContain('automatically expands ranges outward')
  } finally { await f.ctx.fiber.dispose() }
})
