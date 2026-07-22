import { describe, expect, it } from 'vitest'
import type { FC } from 'react'
import type { ScopedSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { narrowSlots, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'surface.a': { kind: 'single'; scope: 'root'; props: { label: string } }
    'surface.b': { kind: 'single'; scope: 'root'; props: { label: string } }
  }
}

const Comp: FC<{ label: string }> = () => null

describe('dynamic-key escape hatch', () => {
  it('specDynamic reads wide-typed specs for string keys; undefined before define', () => {
    const core = new SlotCore()
    expect(core.specDynamic('surface.a')).toBeUndefined()
    core.define('surface.a', { kind: 'single', scope: 'root' })
    expect(core.specDynamic('surface.a')).toEqual({ kind: 'single', scope: 'root' })
    expect(core.specDynamic('never.defined')).toBeUndefined()
  })

  it('entries/getVersion on an untouched key return the frozen empty array and 0', () => {
    const core = new SlotCore()
    expect(core.entries('surface.b')).toHaveLength(0)
    expect(core.entries('surface.b')).toBe(core.entries('surface.b'))
    expect(core.getVersion('surface.b')).toBe(0)
  })
})

describe('narrowSlots', () => {
  it('returns the same surface narrowed to the subset whitelist', () => {
    const wide: ScopedSlots<'surface.a' | 'surface.b'> = { renderSlot: () => null }
    const narrow = narrowSlots<'surface.a', 'surface.a' | 'surface.b'>(wide)
    expect(narrow).toBe(wide)
    const rejects = (s: ScopedSlots<'surface.a'>) => {
      // @ts-expect-error 'surface.b' is outside the narrowed whitelist
      return () => s.renderSlot('surface.b', {})
    }
    expect(rejects(narrow)).toBeTypeOf('function')
  })
})

describe('registration typing', () => {
  it('keyed/list registrations statically require options (runtime guard retained)', () => {
    const core = new SlotCore()
    core.define('surface.a', { kind: 'single', scope: 'root' })
    // single: options omissible.
    expect(() => core.register('surface.a', Comp)).not.toThrow()
  })
})
