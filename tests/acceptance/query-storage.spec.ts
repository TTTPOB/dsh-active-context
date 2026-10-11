import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { SessionCaptureReader, SessionObservation } from '@deepseek-ai/dsh-session-query'
import { expect, it, vi } from 'vitest'
import { createLoopFixture, seedHistory } from './fixtures.ts'

/** Detached consumer sample; the only assertion to Session stays inside the capture callback. */
function sample(meter: TokenMeter, reader: SessionCaptureReader, observation: SessionObservation) {
  return {
    cut: observation.cursor,
    nodes: reader.surface.nodes.map(seq => {
      const event = observation.readEvents(SessionLogOffset(seq), SessionLogOffset(seq + 1))[0]
      if (event === undefined) throw new Error('Surface node missing from source cut: ' + seq)
      return { seq, message: structuredClone(reader.deriveEventMessage(event)) }
    }),
    measurement: meter.measure(reader as Session),
    header: structuredClone(reader.requestHeader()),
  }
}

it('captures a real Loop live Session and its persisted cold copy without activation or writes', async () => {
  const scratch = fileURLToPath(new URL('./.cache/', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(scratch + 'query-storage-')
  const cold = new Context()
  const live = await createLoopFixture([
    [{ type: 'text', text: 'Historical A completed.' }],
    [{ type: 'text', text: 'Middle constraint retained.' }],
    [{ type: 'text', text: 'Historical B completed.' }],
  ], async ctx => {
    await ctx.plugin(TokenMeter)
    // Concrete production Query backend; this exact-read scenario needs no FTS index.
    await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
  })
  try {
    await seedHistory(live.agent)
    const session = live.agent.session
    const captured = await live.ctx.sessionQuery.captureSession(session.id, (reader, observation) => {
      expect(reader).toBe(session)
      return sample(live.ctx.tokenMeter, reader, observation)
    }, { projectionMode: 'none' })

    await cold.plugin(SessionStore)
    await cold.plugin(SessionProjectionRegistry)
    await cold.plugin(TokenMeter)
    await cold.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await cold.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
    const writer = await cold.sessionPersistence.create(session.header)
    try {
      await writer.append(session.snapshotEvents())
    } finally {
      await writer.close()
    }
    const before = await cold.sessionPersistence.stat(session.id)
    const prepare = vi.spyOn(cold.sessions, 'prepare')
    const enter = vi.spyOn(cold.sessions, 'enter')
    const announce = vi.spyOn(cold.sessions, 'announce')
    const captureCold = () => cold.sessionQuery.captureSession(session.id, (reader, observation) => {
      expect(reader).toBeInstanceOf(Session)
      expect(reader).toBe(prepare.mock.results.at(-1)?.value)
      return sample(cold.tokenMeter, reader, observation)
    }, { projectionMode: 'none' })
    const restored = await captureCold()
    expect(restored.nodes).toEqual(captured.nodes)
    expect(restored.header).toEqual(captured.header)
    expect(restored.cut).toBe(captured.cut)
    expect(restored.measurement.nodes).toEqual(captured.measurement.nodes)
    expect(restored.measurement.surfaceTokens).toBe(captured.measurement.surfaceTokens)
    // Cold preparation adds an in-memory seed marker, not an extra source record.
    expect(restored.measurement.logRevision).toBe(captured.measurement.logRevision + 1)
    expect(await captureCold()).toEqual(restored)
    expect(prepare).toHaveBeenCalledOnce()
    expect(enter).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
    expect(cold.sessions.get(session.id)).toBeUndefined()
    expect(cold.get('agents')).toBeUndefined()
    expect(await cold.sessionPersistence.stat(session.id)).toEqual(before)

    const detached = structuredClone(captured)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Later live input must not mutate the old DTO.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(captured).toEqual(detached)
    expect(live.adapter.requests).toHaveLength(3)
  } finally {
    await live.ctx.fiber.dispose()
    await cold.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
