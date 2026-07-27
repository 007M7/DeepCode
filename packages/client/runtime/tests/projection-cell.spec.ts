/**
 * Projection cells (session-projection RFC): the one watermark rule shared by
 * live and window paths (replayed pages never roll back), baseline reset
 * semantics (late baseline never overwrites a newer commit), capability
 * absence as undefined, and the Session/SessionsService dispatch wiring.
 */
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { ProjectionCellSet } from '../src/client/sessions/projection-cell.ts'
import type { ProjectionCellSpec } from '../src/client/sessions/projection-cell.ts'
import { Session } from '../src/client/sessions/session.ts'
import { SessionsService } from '../src/client/sessions/service.ts'
import { FakeApiClient, ok } from './fake-api.ts'
import { entries, plainTurn } from './event-script.ts'

// Test-domain key merged into the projection map (the interface package's
// pure-type outlet): a whole-value marker list, the smallest last-wins shape.
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/marks': { marks: string[] }
  }
}

const SID = 'fk-s1' as SessionId

/** Whole-value domain event carrying the complete post-change state. */
const markEvent = (seq: number, marks: string[]): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, type: 'test/mark', data: { marks } }) as unknown as SessionEvent

/** Loose schema: passes objects with a marks array through, throws otherwise. */
const marksSpec = (): ProjectionCellSpec<'test/marks'> => ({
  key: 'test/marks',
  schema: {
    parse: (value) => {
      if (typeof value === 'object' && value !== null && Array.isArray((value as { marks?: unknown }).marks)) {
        return value as { marks: string[] }
      }
      throw new Error('not a marks payload')
    },
  },
  fromEvent: (event) => ((event.type as string) === 'test/mark'
    ? (event as unknown as { data: { marks: string[] } }).data
    : undefined),
})

describe('ProjectionCellSet semantics', () => {
  function bench() {
    const set = new ProjectionCellSet()
    const dispose = set.register(marksSpec())
    const cell = set.cellOf('test/marks')
    if (cell === undefined) throw new Error('cell missing after register')
    return { set, cell, dispose }
  }

  it('starts absent (undefined) until any signal lands', () => {
    const { cell } = bench()
    expect(cell.getSnapshot()).toBeUndefined()
  })

  it('applies whole values last-wins by seq and never rolls back on replayed old events', () => {
    const { set, cell } = bench()
    set.offerEvent(markEvent(5, ['a']))
    set.offerEvent(markEvent(9, ['a', 'b']))
    expect(cell.getSnapshot()).toEqual({ marks: ['a', 'b'] })
    // A replayed old page (window path) passes the same filter and drops.
    set.offerWindow([markEvent(3, ['stale']), markEvent(9, ['a', 'b'])])
    expect(cell.getSnapshot()).toEqual({ marks: ['a', 'b'] })
  })

  it('re-seeds value and watermark from a baseline, and events at or below asOfSeq drop after it', () => {
    const { set, cell } = bench()
    set.resetBaseline({ asOfSeq: 20, values: { 'test/marks': { marks: ['x'] } } })
    expect(cell.getSnapshot()).toEqual({ marks: ['x'] })
    set.offerEvent(markEvent(18, ['older-than-cut']))
    expect(cell.getSnapshot()).toEqual({ marks: ['x'] })
    set.offerEvent(markEvent(21, ['newer']))
    expect(cell.getSnapshot()).toEqual({ marks: ['newer'] })
  })

  it('drops a late baseline whose cut predates an already-applied commit (seq rule)', () => {
    const { set, cell } = bench()
    set.offerEvent(markEvent(30, ['live-commit']))
    set.resetBaseline({ asOfSeq: 25, values: { 'test/marks': { marks: ['stale-baseline'] } } })
    expect(cell.getSnapshot()).toEqual({ marks: ['live-commit'] })
  })

  it('marks a key absent when the block omits it — capability absence is undefined', () => {
    const { set, cell } = bench()
    set.offerEvent(markEvent(5, ['a']))
    set.resetBaseline({ asOfSeq: 10, values: {} })
    expect(cell.getSnapshot()).toBeUndefined()
  })

  it('degrades a baseline payload failing schema validation to absent instead of poisoning the cell', () => {
    const { set, cell } = bench()
    set.resetBaseline({ asOfSeq: 10, values: { 'test/marks': 'not-an-object' } })
    expect(cell.getSnapshot()).toBeUndefined()
    // The watermark still advanced to the cut: pre-cut events stay dropped.
    set.offerEvent(markEvent(8, ['pre-cut']))
    expect(cell.getSnapshot()).toBeUndefined()
  })

  it('throws on duplicate key registration and frees the key through the disposer', () => {
    const { set, dispose } = bench()
    expect(() => set.register(marksSpec())).toThrow(/already registered/)
    dispose()
    expect(set.cellOf('test/marks')).toBeUndefined()
    expect(() => set.register(marksSpec())).not.toThrow()
  })

  it('notifies subscribers on application (microtask-batched) and not on filtered events', async () => {
    const { set, cell } = bench()
    let ticks = 0
    cell.subscribe(() => { ticks += 1 })
    set.offerEvent(markEvent(5, ['a']))
    await Promise.resolve()
    expect(ticks).toBe(1)
    set.offerEvent(markEvent(3, ['replay']))
    set.offerEvent({ seq: 6, time: 6, type: 'unrelated/event', data: {} } as unknown as SessionEvent)
    await Promise.resolve()
    expect(ticks).toBe(1)
  })
})

describe('Session dispatch wiring', () => {
  function makeSession() {
    const api = new FakeApiClient()
    const session = new Session(SID, api)
    const dispose = session.projections.register(marksSpec())
    const cell = session.projections.cellOf('test/marks')
    if (cell === undefined) throw new Error('cell missing after register')
    return { api, session, cell, dispose }
  }

  it('feeds live appends through the cell filter', async () => {
    const { api, session, cell } = makeSession()
    api.onHistory = () => Promise.resolve(ok({ events: entries(plainTurn(0, 0, '问', '答')) as never[], hasMore: false }))
    await session.open()
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: markEvent(6, ['live']) })
    expect(cell.getSnapshot()).toEqual({ marks: ['live'] })
  })

  it('re-seeds from a history response carrying a projections block, then folds newer window events', async () => {
    const { api, session, cell } = makeSession()
    const window = [...plainTurn(0, 0, '问', '答'), markEvent(6, ['from-window'])]
    api.onHistory = () => Promise.resolve(ok({
      events: entries(window) as never[], hasMore: false,
      projections: { asOfSeq: 4, values: { 'test/marks': { marks: ['from-baseline'] } } },
    } as never))
    await session.open()
    // Baseline cut at 4; the window's seq-6 domain event is newer and wins.
    expect(cell.getSnapshot()).toEqual({ marks: ['from-window'] })
  })

  it('treats a blockless response as event-only folding (no reset), and a resync repull cannot roll back', async () => {
    const { api, session, cell } = makeSession()
    api.onHistory = () => Promise.resolve(ok({ events: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false }))
    await session.open()
    expect(cell.getSnapshot()).toBeUndefined()
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: markEvent(6, ['live']) })
    expect(cell.getSnapshot()).toEqual({ marks: ['live'] })
    // Reconnect resync repulls the same window (no block, no domain events): state holds.
    await session.resync()
    expect(cell.getSnapshot()).toEqual({ marks: ['live'] })
  })

  it('applies the stale-baseline guard end to end: a resync whose block predates a live commit keeps the commit', async () => {
    const { api, session, cell } = makeSession()
    api.onHistory = () => Promise.resolve(ok({
      events: entries(plainTurn(0, 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 5, values: { 'test/marks': { marks: ['baseline'] } } },
    } as never))
    await session.open()
    expect(cell.getSnapshot()).toEqual({ marks: ['baseline'] })
    // Contiguous live commit applies immediately (seq 6 = tail 5 + 1)…
    session.handleMuxEnvelope('r' as never, { type: 'session/event', sessionId: SID, event: markEvent(6, ['commit-6']) })
    expect(cell.getSnapshot()).toEqual({ marks: ['commit-6'] })
    // …then a resync repull serves the same stale block (cut 5 < applied 6):
    // the baseline reset must not overwrite the newer commit (seq rule).
    await session.resync()
    expect(cell.getSnapshot()).toEqual({ marks: ['commit-6'] })
  })
})

describe('SessionsService roster', () => {
  const sid = (s: string): SessionId => s as SessionId

  async function bench() {
    const ctx = new Context()
    const api = new FakeApiClient()
    const svc = new SessionsService(ctx, api)
    api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s1'), updatedAt: 1, running: false, blank: false }],
    }) as never)
    await svc.refresh()
    await Promise.resolve()
    return { ctx, api, svc }
  }

  it('materializes registered specs on already-live scopes and future scopes alike', async () => {
    const b = await bench()
    const binding1 = b.svc.binding(sid('s1'))
    if (binding1 === undefined) throw new Error('no binding for s1')
    b.svc.registerProjectionCell(marksSpec())
    expect(binding1.session.projections.cellOf('test/marks')).toBeDefined()
    // A session arriving later gets the roster at scope mint.
    b.api.onList = () => Promise.resolve(ok({
      items: [
        { sessionId: sid('s1'), updatedAt: 1, running: false, blank: false },
        { sessionId: sid('s2'), updatedAt: 2, running: false, blank: false },
      ],
    }) as never)
    await b.svc.refresh()
    await Promise.resolve()
    const binding2 = b.svc.binding(sid('s2'))
    expect(binding2?.session.projections.cellOf('test/marks')).toBeDefined()
  })

  it('exposes the key-addressed cell face on provideInfo (the useProjection resolution path)', async () => {
    const b = await bench()
    b.svc.registerProjectionCell(marksSpec())
    const info = b.svc.provideInfo('s1')
    if (info === undefined) throw new Error('no provide info for s1')
    expect(info.projections?.cellOf('test/marks')).toBeDefined()
    expect(info.projections?.cellOf('test/ghost')).toBeUndefined()
    // The no-session projection carries no face: every key reads absent.
    expect(b.svc.maybeProvideInfo(undefined).projections).toBeUndefined()
  })

  it('removes the cell from every live session through the disposer (HMR semantics)', async () => {
    const b = await bench()
    const dispose = b.svc.registerProjectionCell(marksSpec())
    const binding = b.svc.binding(sid('s1'))
    expect(binding?.session.projections.cellOf('test/marks')).toBeDefined()
    dispose()
    expect(binding?.session.projections.cellOf('test/marks')).toBeUndefined()
  })
})
