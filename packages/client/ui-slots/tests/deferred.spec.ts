// deferRegistration lifecycle: declaration-aware registration, HMR
// re-registration, and — the failure contract — no subscription survives a
// construction that throws synchronously (an already-occupied single slot).
import { describe, expect, it, vi } from 'vitest'
import { deferGroupRegistration, deferRegistration, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

// Shares the merges declared by core.spec.ts (same program); reuse its keys.
const HOLE = 'test.single' as const

function declared(): SlotCore {
  const core = new SlotCore()
  core.register({ name: 'root', children: { [HOLE]: { kind: 'single', scope: 'root' } } } as never, (() => null) as never)
  return core
}

describe('deferRegistration', () => {
  it('registers immediately under an existing declaration and disposes cleanly', () => {
    const core = declared()
    const component = (): null => null
    const handle = deferRegistration(core, HOLE, component, () =>
      core.register({ name: HOLE } as never, component as never))
    expect(core.entries(HOLE)).toHaveLength(1)
    handle.dispose()
    expect(core.entries(HOLE)).toHaveLength(0)
  })

  it('hands a late registration failure to onFailure after unsubscribing itself', async () => {
    const core = new SlotCore()
    const component = (): null => null
    const foreign = (): null => null
    const failures: unknown[] = []
    // Nothing is declared yet: the deferral just subscribes and waits.
    const register = vi.fn(() => core.register({ name: HOLE } as never, component as never))
    deferRegistration(core, HOLE, component, register, (error) => { failures.push(error) })
    // The declaration lands with a foreign occupant racing in first: the
    // deferral's flush-time attempt fails, unsubscribes itself, and reports
    // through onFailure instead of throwing out of the flush.
    core.register({ name: 'root', children: { [HOLE]: { kind: 'single', scope: 'root' } } } as never, (() => null) as never)
    const disposeForeign = core.register({ name: HOLE } as never, foreign as never)
    await Promise.resolve()
    expect(failures.map(String).join('')).toContain('already has a registration')
    // Unsubscribed: freeing the hole must not resurrect the loser.
    disposeForeign()
    await Promise.resolve()
    expect(core.entries(HOLE)).toHaveLength(0)
  })

  it('drops its subscription when the immediate registration throws', async () => {
    const core = declared()
    const foreign = (): null => null
    const disposeForeign = core.register({ name: HOLE } as never, foreign as never)
    const component = (): null => null
    const register = vi.fn(() => core.register({ name: HOLE } as never, component as never))
    // The single hole is occupied: the immediate attempt throws out of the
    // constructor, and the caller never receives a handle to dispose.
    expect(() => deferRegistration(core, HOLE, component, register)).toThrow(/already has a registration/)
    expect(register).toHaveBeenCalledOnce()
    // The subscription rolled back with it: freeing the hole flushes a
    // notification that must not resurrect the failed registration.
    disposeForeign()
    await Promise.resolve()
    expect(register).toHaveBeenCalledOnce()
    expect(core.entries(HOLE)).toHaveLength(0)
  })
})

describe('deferGroupRegistration', () => {
  const HOLES = ['test.single', 'test.grandchild'] as const

  function declaredPair(): SlotCore {
    const core = new SlotCore()
    core.register({
      name: 'root',
      children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
    } as never, (() => null) as never)
    return core
  }

  it('registers the whole group and disposes it as a unit', () => {
    const core = declaredPair()
    const component = (): null => null
    const group = deferGroupRegistration(core, HOLES, component, name =>
      core.register({ name } as never, component as never))
    for (const name of HOLES) expect(core.entries(name)).toHaveLength(1)
    group.dispose()
    for (const name of HOLES) expect(core.entries(name)).toHaveLength(0)
  })

  it('rolls the group back when construction fails partway', () => {
    const core = declaredPair()
    const component = (): null => null
    core.register({ name: HOLES[1] } as never, (() => null) as never)
    expect(() => deferGroupRegistration(core, HOLES, component, name =>
      core.register({ name } as never, component as never))).toThrow(/already has a registration/)
    // The first hole's registration and subscription rolled back with it.
    expect(core.entries(HOLES[0])).toHaveLength(0)
  })

  it('rolls the group back and re-raises loudly on a late conflict', async () => {
    const core = new SlotCore()
    const component = (): null => null
    const failures: unknown[] = []
    const onLoud = (reason: unknown): void => { failures.push(reason) }
    process.on('uncaughtException', onLoud)
    try {
      const group = deferGroupRegistration(core, HOLES, component, name =>
        core.register({ name } as never, component as never))
      // Declaration lands with a rival racing in ahead of the flush.
      core.register({
        name: 'root',
        children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
      } as never, (() => null) as never)
      core.register({ name: HOLES[0] } as never, (() => null) as never)
      core.register({ name: HOLES[1] } as never, (() => null) as never)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(failures.map(String).join('')).toContain('already has a registration')
      // No partial occupancy from the group's owner survives.
      for (const name of HOLES) {
        expect(core.entries(name).filter(entry => entry.component === component)).toHaveLength(0)
      }
      group.dispose()
    } finally {
      process.off('uncaughtException', onLoud)
    }
  })
})
