/** Strict single-call PTC admission and durable outer-result accounting. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AcpConfig, AcpState, BatchFacts, ExecutionIdentity } from './types.ts'
import { renderBatchFacts } from './regions.ts'

export const PTC_FORM = 'return await tools.context_compress(<JSON literal>);'
export const PTC_DENIAL = `ACP: use exactly ${PTC_FORM} as the entire run_code code, with one JSON object argument and optional outer whitespace. No variables, comments, task text, other calls or statements. Submit a separate run_code response containing only this program.`

/** Parse the complete allowed program without executing JavaScript. */
export function compressionProgram(code: string): object | undefined {
  const program = code.trim()
  const prefix = 'return await tools.context_compress('
  if (!program.startsWith(prefix) || !program.endsWith(');')) return undefined
  let value: unknown
  try {
    value = JSON.parse(program.slice(prefix.length, -2))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return undefined
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

interface Root {
  readonly exec: Readonly<ToolExecution>
  readonly identity: ExecutionIdentity
  readonly input: object
  child?: Readonly<ToolExecution>
  facts?: BatchFacts | undefined
  projected?: string
  overridden?: boolean
  projectedError?: string | undefined
}

/** Register root ownership; only a direct child can consume the one allowed call. */
export function installPtc(
  ctx: Context, config: AcpConfig, state: AcpState,
  authorize: (exec: Readonly<ToolExecution>) => ExecutionIdentity | undefined,
): (exec: Readonly<ToolExecution>) => ExecutionIdentity | undefined {
  const roots = new Map<ToolExecution['token'], Root>()
  const rootOf = (exec: Readonly<ToolExecution>) => {
    const root = roots.get(exec.token)
    return root !== undefined && root.exec.agent === exec.agent && root.exec.rootCallId === exec.rootCallId ? root : undefined
  }
  const errorKey = (result: Readonly<ToolExecutionResult>) => result.isError ? JSON.stringify(result.error) : undefined
  const project = (root: Root, result: Readonly<ToolExecutionResult>) => {
    if (root.facts === undefined) return undefined
    const text = renderBatchFacts(root.facts, config, result.isError ? {
      ...result, content: result.content.filter(block => block.type !== 'text' || block.text !== root.projected),
    } : undefined)
    root.projected = text
    root.projectedError = errorKey(result)
    return [{ type: 'text' as const, text }]
  }
  ctx.tools.guard(exec => {
    if (exec.name !== 'run_code' || exec.parent !== undefined) return undefined
    const args = exec.arguments
    if (args === null || typeof args !== 'object' || !('code' in args) || typeof args.code !== 'string') return undefined
    const input = compressionProgram(args.code)
    if (input === undefined) return args.code.includes('context_compress') ? PTC_DENIAL : undefined
    const runtime = ctx.get('ptcRuntime')
    if (runtime?.language !== 'typescript' || runtime.programFormat !== 'function-body') {
      return 'ACP PTC requires a TypeScript function-body runtime. Configure that runtime or use native mode. ' + PTC_DENIAL
    }
    const identity = authorize(exec)
    if (identity === undefined) return PTC_DENIAL
    roots.set(exec.token, { exec, identity, input })
    return undefined
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    const root = rootOf(exec)
    const content = root === undefined ? undefined : project(root, result)
    return content === undefined ? result : { ...result, content }
  }, { prepend: true })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const root = rootOf(exec)
    if (root === undefined || root.facts === undefined) return decision
    if (decision.kind === 'block' || decision.content !== undefined || decision.value !== undefined) root.overridden = true
    if (decision.kind === 'accept' && decision.value !== undefined) return decision
    const effective: Readonly<ToolExecutionResult> = decision.kind === 'block'
      ? { isError: true, content: decision.feedback, error: { message: decision.feedback.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') } }
      : result
    const content = project(root, effective)!
    return decision.kind === 'block' ? { ...decision, feedback: content } : {
      kind: 'accept', content: [...decision.content ?? [], ...content], ...decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts },
    }
  }, { prepend: true })
  ctx.on('tools/result', (exec, result) => {
    if (exec.parent !== undefined) {
      const root = roots.get(exec.parent)
      if (root?.child === exec) root.facts = state.facts.get(exec)
      return
    }
    const root = rootOf(exec)
    if (root === undefined) return
    roots.delete(exec.token)
    if (root.facts === undefined || exec.agent === undefined) return
    if (!result.isError && !root.overridden && !exec.signal.aborted && root.facts.status === 'batch_success'
      && result.content.some(block => block.type === 'text' && block.text === root.projected)) {
      state.identities.set(exec, { ...root.identity, transport: 'ptc' })
      state.facts.set(exec, root.facts)
    }
    // Cancellation and throwing post policies can replace all wrapper content.
    if (result.content.some(block => block.type === 'text' && block.text === root.projected)
      && root.projectedError === errorKey(result)) return
    const content = project(root, result)!
    exec.agent.session.append('user/message', createUserMessage({
      content,
      source: { kind: 'acp-maintenance', form: 'notice', summary: boundContextSummary('Final ACP outcome after run_code settlement.') },
    }), { surfaceOp: 'append', sourceEventSeqs: [root.identity.assistantSeq] })
  })
  ctx.effect(() => () => roots.clear())
  return exec => {
    if (exec.parent === undefined) return undefined
    const root = roots.get(exec.parent)
    if (root === undefined || root.child !== undefined || root.exec.agent !== exec.agent
      || root.exec.rootCallId !== exec.rootCallId || !isDeepStrictEqual(root.input, exec.arguments)) return undefined
    root.child = exec
    return { ...root.identity, callId: exec.callId }
  }
}
