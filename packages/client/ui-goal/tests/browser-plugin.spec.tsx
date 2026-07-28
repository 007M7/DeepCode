// @vitest-environment jsdom
/**
 * ui-goal browser half on a real cordis Context with fake slots/connection/
 * sessions faces: the plugin registers the GoalBar dock entry at
 * conversation.input.dock, the inject face's three verbs read the CAS ref
 * from the session's CURRENT projected value at call time (no fence — the
 * RPC's compare-and-set is the guard), a missing projection short-circuits
 * to the no-current-goal error without touching the wire, and RPC errors
 * map onto the inline-render result shape. Registration disposal rides the
 * plugin fiber (HMR safety). The node half and the invariant companion are
 * exercised over the same Context.
 */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { GoalProjection } from '@deepseek-ai/dsh-goal/client'
import type { GoalBarActions } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { GoalDock } from '../src/client/GoalBar.tsx'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId

function makeProjection(revision = 3): GoalProjection {
  return {
    goal: {
      id: 'g-1' as GoalProjection['goal']['id'],
      revision,
      objective: 'Ship it',
      phase: 'active',
      maxGoalRounds: 8,
    },
    roundsStarted: 1,
    createdAt: 10,
    updatedAt: 20,
  }
}

/** Boot the plugin over fake faces; goals verbs record payloads and answer per the script. */
function bench(options: { projection?: GoalProjection | null | undefined; failWith?: { code: string; message: string } } = {}) {
  const ctx = new Context()
  const calls: { method: string; payload: unknown }[] = []
  function answer<T>(method: string, value: T) {
    return (payload: unknown) => {
      calls.push({ method, payload })
      return Promise.resolve({
        result: options.failWith === undefined
          ? { ok: true as const, value }
          : { ok: false as const, error: { ...options.failWith, details: {} } },
      })
    }
  }
  const ref = { id: 'g-1', revision: 3 }
  ctx.provide('connection', { api: { goals: {
    edit: answer('goal.edit', { ref }),
    resume: answer('goal.resume', { ref }),
    clear: answer('goal.clear', { cleared: true as const }),
  } } })
  const entries = new Map<string, { id?: string; order?: number; inject?: (sessionId: SessionId) => GoalBarActions }>()
  ctx.provide('slots', {
    register(reg: { name: string; id?: string; order?: number; inject?: (sessionId: SessionId) => GoalBarActions }) {
      entries.set(reg.name, reg)
      return () => { entries.delete(reg.name) }
    },
  })
  ctx.provide('conversation', {})
  ctx.provide('sessions', {
    binding: (id: SessionId) => ({
      sessionId: id,
      session: { projections: { faceOf: (key: string) => ({
        getSnapshot: () => (key === 'goal' ? options.projection : undefined),
        subscribe: () => () => {},
      }) } },
      ctx,
    }),
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls,
    entry: () => entries.get('conversation.input.dock'),
  }
}

describe('ui-goal browser plugin', () => {
  it('registers the GoalBar dock entry with the documented id and order', async () => {
    const b = bench()
    await b.fiber.await()
    expect(b.entry()).toMatchObject({ id: 'goal', order: 1 })
    expect(b.entry()?.inject).toBeTypeOf('function')
  })

  it('verbs read the CAS ref from the current projected value at call time', async () => {
    const b = bench({ projection: makeProjection(5) })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    expect(await verbs.onEdit('New objective')).toEqual({ ok: true })
    expect(await verbs.onResume()).toEqual({ ok: true })
    expect(await verbs.onClear()).toEqual({ ok: true })
    expect(b.calls.map(c => c.method)).toEqual(['goal.edit', 'goal.resume', 'goal.clear'])
    const ref = { id: 'g-1', revision: 5 }
    expect(b.calls[0]?.payload).toEqual({ sessionId: 's1', ref, objective: 'New objective' })
    expect(b.calls[1]?.payload).toEqual({ sessionId: 's1', ref })
    expect(b.calls[2]?.payload).toEqual({ sessionId: 's1', ref })
  })

  it('a null or absent projection short-circuits every verb without touching the wire', async () => {
    for (const projection of [null, undefined]) {
      const b = bench({ projection })
      await b.fiber.await()
      const verbs = b.entry()!.inject!(sid('s1'))
      for (const result of [await verbs.onEdit('x'), await verbs.onResume(), await verbs.onClear()]) {
        expect(result).toEqual({ ok: false, error: { code: 'no-current-goal', message: 'no current goal to mutate' } })
      }
      expect(b.calls).toHaveLength(0)
    }
  })

  it('maps a settled RPC error onto the inline-render shape', async () => {
    const b = bench({ projection: makeProjection(), failWith: { code: 'internal', message: 'stale revision' } })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    expect(await verbs.onEdit('x')).toEqual({ ok: false, error: { code: 'internal', message: 'stale revision' } })
  })

  it('drops the dock entry when the plugin fiber unloads (HMR safety)', async () => {
    const b = bench()
    await b.fiber.await()
    expect(b.entry()).toBeDefined()
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
  })
})

describe('GoalDock adapter', () => {
  it('renders the projected goal snapshot and nothing for absent/null', () => {
    const projection = makeProjection()
    const useProjection = vi.fn(() => projection)
    const actions: GoalBarActions = {
      onEdit: () => Promise.resolve({ ok: true }),
      onResume: () => Promise.resolve({ ok: true }),
      onClear: () => Promise.resolve({ ok: true }),
    }
    const dockProps = (up: () => GoalProjection | null | undefined) =>
      ({ useProjection: up, ...actions }) as unknown as Parameters<typeof GoalDock>[0]
    const shown = render(<GoalDock {...dockProps(useProjection)} />)
    expect(shown.getByText('Ship it')).toBeTruthy()
    cleanup()

    const empty = render(<GoalDock {...dockProps(() => null)} />)
    expect(empty.container.firstChild).toBeNull()
    cleanup()

    const absent = render(<GoalDock {...dockProps(() => undefined)} />)
    expect(absent.container.firstChild).toBeNull()
  })
})

describe('ui-goal node half', () => {
  // The invariant companion is mounted by the vitest-wide invariant host on
  // every Context this suite creates; its registration is covered there.
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
