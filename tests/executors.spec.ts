import { expect, it } from 'vitest'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { fixture } from './guard-fixtures/fixture.ts'

class InlineRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly programFormat = 'function-body'
  readonly isolation = 'test'
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: 15_000 }
  }
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    try {
      return { logs: [], value: await new AsyncFunction('tools', spec.program)(spec.bindings[0]!.functions) }
    } catch (error) {
      return { logs: [], error: { kind: 'exception', message: String(error) } }
    }
  }
}

for (const policy of ['accept', 'block', 'replace', 'throw'] as const) {
  it(`settles canonical PTC child facts through the executor root with ${policy} policy`, async () => {
    const program = 'return await tools.context_compress({});'
    const f = await fixture({ mode: 'ptc', cleanup: false, replies: [
      [{ type: 'tool-call', name: 'run_code', id: ToolCallId('root'), arguments: JSON.stringify({ code: program, description: 'Compress history' }) }],
      [{ type: 'text', text: 'done' }],
    ] })
    try {
      provideWorkingDirectoryFixture(f.ctx)
      await f.ctx.plugin(InlineRuntime)
      if (policy !== 'accept') f.ctx.on('tools/post-execute', (exec, _result, next) => {
        if (exec.name !== 'run_code') return next()
        if (policy === 'throw') throw new Error('root policy failure')
        return policy === 'block'
          ? { kind: 'block', feedback: [{ type: 'text', text: 'root policy block' }] }
          : { kind: 'accept', content: [{ type: 'text', text: 'root policy replacement' }] }
      })
      await f.run()
      expect(f.executions, JSON.stringify(f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result'))).toHaveLength(1)
      expect(f.executions[0]!.parent).toBeDefined()
      const root = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'root')!
      expect(root).toBeDefined()
      if (root.type !== 'tool/result') throw new Error('missing root result')
      expect(root.data.message.isError).toBe(policy === 'block' || policy === 'throw')
      const allText = JSON.stringify(f.agent.session.snapshotEvents())
      expect(allText).toContain('compressed')
      expect(allText).toContain('original 0')
      if (policy === 'accept') expect(root.data.message.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('original 0') }),
      ]))
      else expect(f.state.hideCandidates.has(f.agent)).toBe(false)
    } finally { await f.ctx.fiber.dispose() }
  })
}
