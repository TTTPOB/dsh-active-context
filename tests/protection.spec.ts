import { describe, expect, it } from 'vitest'
import { createMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { AcpConfigSchema } from '../src/config.ts'
import { assertCompleteToolPairs, protectedSeqs, type SurfaceCapture } from '../src/protection.ts'
import { preflightRegions } from '../src/regions.ts'
import { providerFixture } from './provider-fixture.ts'
import type { ExecutionIdentity } from '../src/types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'acp-protection-test': { kind: 'acp-protection-test' } & ContextFormed }
}

describe('active context protection', () => {
  it('protects live system/developer/instructions, the current Step, and latest task but allows earlier completed steps', () => {
    const session = Session.create(SessionId('protection-fixture'))
    session.append('turn/start', { turn: 1 })
    const system = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('system') }, { surfaceOp: 'append' }).seq
    const developer = session.append('developer/message', { turn: 1, step: 1, message: createMessage({ role: 'developer', source: { kind: 'user' }, content: [{ type: 'text', text: 'developer' }] }) }, { surfaceOp: 'append' }).seq
    const oldTask = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'old task' }] }), { surfaceOp: 'append' }).seq
    session.append('step/start', { turn: 1, step: 1 })
    const oldStep = session.append('user/message', createUserMessage({ source: { kind: 'acp-protection-test' }, content: [{ type: 'text', text: 'finished step' }] }), { surfaceOp: 'append' }).seq
    session.append('step/end', { turn: 1, step: 1 })
    const instructions = session.append('user/message', createUserMessage({ source: { kind: 'acp-protection-test', form: 'instructions' }, content: [{ type: 'text', text: 'persistent instruction' }] }), { surfaceOp: 'append' }).seq
    const latestTask = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'latest task' }] }), { surfaceOp: 'append' }).seq
    session.append('step/start', { turn: 1, step: 2 })
    const currentStep = session.append('user/message', createUserMessage({ source: { kind: 'acp-protection-test', form: 'notice', summary: 'maintenance' }, content: [{ type: 'text', text: 'current step' }] }), { surfaceOp: 'append' }).seq
    const log = session.snapshotEvents()
    const seqs = [...session.surface.nodes]
    const events = seqs.map(seq => { const event = log[seq]; if (!event) throw new Error('missing fixture event'); return event })
    const surface: SurfaceCapture = { seqs, events, messages: events.map(event => session.deriveEventMessage(event)), log }
    const identity: ExecutionIdentity = { sessionId: session.id, turn: 1, step: 2, assistantSeq: SessionSeq(currentStep), callId: ToolCallId('test-call'), provider: 'test', model: 'test' }
    const protectedNodes = protectedSeqs(surface, identity, AcpConfigSchema({}))
    expect([...protectedNodes]).toEqual(expect.arrayContaining([system, developer, instructions, latestTask, currentStep]))
    expect(protectedNodes.has(oldTask)).toBe(false)
    expect(protectedNodes.has(oldStep)).toBe(false)
  })

  it('protects the checkpoint when native overflow folded the latest task before a later Step', async () => {
    const fixture = await providerFixture()
    try {
      fixture.session.append('tool/result', { turn: 4, step: 1, message: createToolResultMessage({ callId: fixture.identity.callId, isError: false, content: [{ type: 'text', text: 'done' }] }) }, { surfaceOp: 'append' })
      fixture.session.append('step/end', { turn: 4, step: 1 })
      const native = await fixture.engine.compactIfNeeded(fixture.agent, 'context-overflow', new AbortController().signal)
      expect(native?.shadowedSeqs).toContain(fixture.latestTask)
      const checkpoint = fixture.session.surface.nodes[0]!
      fixture.session.append('step/start', { turn: 4, step: 2 })
      const assistant = fixture.session.append('assistant/message', { turn: 4, step: 2, stream: [], message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'author', model: 'working' }, content: [{ type: 'tool-call', id: ToolCallId('second-compress'), name: 'context_compress', arguments: '{}' }] }) }, { surfaceOp: 'append' })
      const identity = { ...fixture.identity, step: 2, assistantSeq: assistant.seq, callId: ToolCallId('second-compress') }
      const message = fixture.session.deriveEventMessage(fixture.session.eventAt(checkpoint)!)!
      const block = message.content.find(block => block.type === 'text')!
      if (block.type !== 'text') throw new Error('Checkpoint has no text')
      const input = fixture.input([{ range: [{ text: block.text }, { text: block.text }], summary: 'replacement' }])
      await expect(preflightRegions(fixture.ctx, fixture.agent, identity, input, fixture.config)).rejects.toThrow(/protected/)
    } finally { await fixture.dispose() }
  })

  it('requires actual matching call/result identities, not just balanced counts', () => {
    const callId = ToolCallId('pair')
    const call = createMessage({ role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: callId, name: 'test', arguments: '{}' }] })
    const result = createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'ok' }] })
    expect(() => assertCompleteToolPairs([call, result])).not.toThrow()
    expect(() => assertCompleteToolPairs([call])).toThrow(/splits/)
    expect(() => assertCompleteToolPairs([result])).toThrow(/no selected call/)
    expect(() => assertCompleteToolPairs([call, { ...result, toolCallId: ToolCallId('wrong') }])).toThrow(/no selected call/)
  })
})
