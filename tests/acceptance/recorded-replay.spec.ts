import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { installLlmReplay, type ReplayHandle } from '@deepseek-ai/dsh-llm-replay'
import { normalizeSessionSnapshots } from '@deepseek-ai/dsh-session-snapshot'
import { Session } from '@deepseek-ai/dsh-session'
import { eventLines, toHeaderLine } from '../../../deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import type { CompressInput } from '../../src/types.ts'
import { loadActiveContext } from './composition.ts'
import { selection, summaries } from './compression-fixture.ts'
import { createLoopFixture, HISTORY, runTurn, seedHistory } from './fixtures.ts'

const task = 'Finish the old analyses while preserving the middle constraint.'
function jsonl(session: Session): string {
  return JSON.stringify(toHeaderLine(session.header, session.inheritedEventCount)) + '\n' + eventLines(session.snapshotEvents()) + '\n'
}

it('replays recorded ACP model streams using existing llm-replay and compares complete logs using session-snapshot', async ({ onTestFinished }) => {
  const scratch = fileURLToPath(new URL('../../.scratch/text-anchors/tests/', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'recorded-snapshot-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  let input: CompressInput | undefined
  let replay: Awaited<ReturnType<typeof createLoopFixture>> | undefined
  let handle: ReplayHandle | undefined
  const producer = await createLoopFixture([
    [{ type: 'text', text: 'Recorded analysis A complete.' }],
    [{ type: 'text', text: 'Recorded middle constraint retained.' }],
    [{ type: 'text', text: 'Recorded analysis B complete.' }],
    () => {
      if (input === undefined) throw new Error('Missing sampled recorded selection')
      return [{ type: 'tool-call', id: ToolCallId('recorded-compress'), name: 'context_compress', arguments: JSON.stringify(input) }]
    },
    request => {
      const visible = JSON.stringify(request.messages)
      expect(visible).toContain(summaries[0])
      expect(visible).toContain(summaries[1])
      expect(visible).toContain(HISTORY[1].text)
      expect(visible).not.toContain('recorded-compress')
      return [{ type: 'text', text: 'Recorded final answer after compression.' }]
    },
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    await loadActiveContext(ctx, { basic: { auto: false } })
  })
  try {
    await seedHistory(producer.agent)
    input = selection(producer.agent.session)
    await runTurn(producer.agent, task)
    expect(producer.adapter.requests).toHaveLength(5)
    const recorded = jsonl(producer.agent.session)
    const file = join(root, 'session.v' + producer.agent.session.header.version + '.jsonl')
    await writeFile(file, recorded)

    // Replay consumes actual embedded assistant streams, not another hand-authored reply array.
    replay = await createLoopFixture([], async ctx => {
      await ctx.plugin(TokenMeter)
      await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
      await loadActiveContext(ctx, { basic: { auto: false } })
      handle = installLlmReplay(ctx, { file })
    })
    await seedHistory(replay.agent)
    await runTurn(replay.agent, task)
    handle!.assertConsumed()
    expect(replay.adapter.requests).toHaveLength(0)
    expect(replay.agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const normalized = (session: Session, raw: string) => normalizeSessionSnapshots([raw], {
      sessionIds: [session.id], cwd: session.header.cwd!,
    }, { nativeWriterOutput: true })[0]
    expect(normalized(replay.agent.session, jsonl(replay.agent.session))).toEqual(normalized(producer.agent.session, recorded))
  } finally {
    handle?.dispose()
    await replay?.ctx.fiber.dispose()
    await producer.ctx.fiber.dispose()
  }
})
