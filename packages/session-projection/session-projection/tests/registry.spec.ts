/**
 * SessionProjectionRegistry unit drive: eager apply on committed events with
 * lazy cell build (registration after events, session after registration),
 * the Object.is no-change gate (same reference ⇒ zero change-feed work),
 * snapshot consistency (asOfSeq = last event seq; values from the watermark
 * cache), duplicate-key rejection, stateVersion validation, and effect-tied
 * removal of registrations and change listeners (HMR safety).
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { z } from 'zod'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/marks': { marks: string[] }
    'test/count': number
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'test/mark': { marks: string[] }
  }
}

/** Whole-value unit: latest test/mark event wins; unrelated events return the same reference. */
type MarksState = { marks: string[] } | null
const marksUnit = (): ProjectionDefinition<'test/marks', MarksState> => ({
  key: 'test/marks',
  schema: z.object({ marks: z.array(z.string()) }),
  init: () => null,
  apply: (state, event) => (event.type === 'test/mark' ? (event).data : state),
  view: state => state ?? { marks: [] },
  stateVersion: 1,
})

/** Counting unit over every event — state changes on each apply. */
const countUnit = (): ProjectionDefinition<'test/count', number> => ({
  key: 'test/count',
  schema: z.number().int().nonnegative(),
  init: () => 0,
  apply: state => state + 1,
  view: state => state,
  stateVersion: 1,
})

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, session: ctx.sessions.create() }
}

const mark = (session: Session, marks: string[]): SessionEvent =>
  session.append('test/mark', { marks })

describe('SessionProjectionRegistry drive', () => {
  it('drives a registered unit over committed events and snapshots the current value', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['a'])
    mark(session, ['a', 'b'])
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['test/marks']).toEqual({ marks: ['a', 'b'] })
    expect(snapshot.asOfSeq).toBe(session.seq - 1)
  })

  it('builds the cell lazily from the full log for a unit registered after events flowed', async () => {
    const { ctx, session } = await harness()
    mark(session, ['pre-registration'])
    ctx.sessionProjections.register(marksUnit())
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['pre-registration'] })
    // The lazily-built cell then continues on the live drive path.
    mark(session, ['after'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['after'] })
  })

  it('serves init-derived state and asOfSeq -1 for an empty log', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.asOfSeq).toBe(-1)
    expect(snapshot.values['test/marks']).toEqual({ marks: [] })
  })

  it('notifies onChanged with the validated view and the causing seq, and skips same-reference applies', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const seen: { key: string; value: unknown; seq: number; sessionId: string }[] = []
    ctx.sessionProjections.onChanged((changedSession, key, value, seq) => {
      seen.push({ key, value, seq, sessionId: String(changedSession.id) })
    })
    const event = mark(session, ['a'])
    // Non-matching event: apply returns the same reference — no notification.
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    expect(seen).toEqual([{ key: 'test/marks', value: { marks: ['a'] }, seq: event.seq, sessionId: String(session.id) }])
  })

  it('drives independently per session (cells are per-session watermarks)', async () => {
    const { ctx, session } = await harness()
    const other = ctx.sessions.create()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['one'])
    mark(other, ['two'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['one'] })
    expect(ctx.sessionProjections.snapshot(other).values['test/marks']).toEqual({ marks: ['two'] })
  })

  it('runs every registered unit — a changing unit notifies while a same-reference unit stays silent', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const changedKeys: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => {
      changedKeys.push(key)
    })
    session.append('turn/start', { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } })
    // count applied (+1 change), marks returned the same reference.
    expect(changedKeys).toEqual(['test/count'])
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['test/count']).toBe(1)
    expect(snapshot.values['test/marks']).toEqual({ marks: [] })
  })

  it('rejects duplicate keys loud and keeps the first unit', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    expect(() => ctx.sessionProjections.register(marksUnit())).toThrow(/"test\/marks" is already registered/)
    mark(session, ['kept'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['kept'] })
  })

  it('rejects a non-integer or negative stateVersion at register time', async () => {
    const { ctx } = await harness()
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: -1 })).toThrow(/stateVersion/)
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: 1.5 })).toThrow(/stateVersion/)
  })

  it('register() disposer removes the key (with its cells) and frees it for re-registration', async () => {
    const { ctx, session } = await harness()
    const dispose = ctx.sessionProjections.register(marksUnit())
    mark(session, ['cached'])
    dispose()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    ctx.sessionProjections.register(marksUnit())
    // Fresh registration rebuilds from the log, not from a stale cell.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['cached'] })
  })

  it('removes registrations and change listeners when their owning fiber unloads (HMR safety)', async () => {
    const { ctx, session } = await harness()
    const notifications: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionProjections.register(marksUnit())
      inner.sessionProjections.onChanged((_session, key) => {
        notifications.push(key)
      })
    }, { inject: ['sessionProjections'] }))
    mark(session, ['live'])
    expect(notifications).toEqual(['test/marks'])
    await fiber.dispose()
    mark(session, ['after-dispose'])
    expect(notifications).toEqual(['test/marks'])
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('fails loud when a unit view violates its own schema (async unit output is unrepresentable)', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register({
      key: 'test/marks',
      schema: z.object({ marks: z.array(z.string()) }),
      init: () => null as MarksState,
      apply: state => state,
      // A Promise (what an accidentally-async view would return) is not the
      // declared shape: the boundary parse rejects it before it leaves.
      view: () => Promise.resolve({ marks: [] }) as never,
      stateVersion: 1,
    })
    expect(() => ctx.sessionProjections.snapshot(session)).toThrow()
  })
})
