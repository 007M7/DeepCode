// deferRegistration lifecycle: declaration-aware registration, HMR
// re-registration, and — the failure contract — no subscription survives a
// construction that throws synchronously (an already-occupied single slot).
import { describe, expect, it, vi } from 'vitest'
import { deferRegistration, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

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
