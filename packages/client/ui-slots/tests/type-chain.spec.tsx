// Slot type-chain negative samples (design.md §9 item 2) plus the slots-ring
// full-chain positive: register→inject→render composed under the ownership
// rule (owner share referenced, injected share locally declared).
import { describe, expect, it } from 'vitest'
import type { FC, ReactNode } from 'react'
import type {
  OwnerOf, RootBinding, ScopedSlots, SessionBinding, SlotMap, SlotOptions,
} from '@deepseek-ai/dsh-client-ui-slots'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/** Owner share as the slot-owning package's contract would export it. */
interface ChainOwnerShare { sessionId: string }
/** Registrant's own injected share (locally declared — ownership rule). */
interface ChainInjected { useThing: () => number; actions: { open: () => void } }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'chain.session': { kind: 'single'; scope: 'session'; props: ChainSessionProps; owner: ChainOwnerShare }
    'chain.root': { kind: 'single'; scope: 'root'; props: ChainRootProps; owner: object }
    'chain.keyed': { kind: 'keyed'; scope: 'root'; props: ChainRootProps; owner: object }
  }
}

/** Full props = owner share (referenced) + standard share + own injected. */
type ChainSessionProps = ChainOwnerShare & { useSession: unknown } & ChainInjected
type ChainRootProps = ChainInjected

const SessionComp: FC<ChainSessionProps> = () => null
const RootComp: FC<ChainRootProps> = () => null

describe('type-chain negatives (compile-time; bodies never run)', () => {
  it('holds the six negative samples as expect-error sites', () => {
    const negatives = (core: SlotCore, slots: ScopedSlots<'chain.session'>) => {
      // 1. Owner passing a registrant-injected key through renderSlot.
      //    OwnerOf<'chain.session'> = ChainOwnerShare — useThing is not in it.
      slots.renderSlot('chain.session', {
        sessionId: 's1',
        // @ts-expect-error injected keys are not owner-suppliable
        useThing: () => 1,
      })
      // 2. Inject factory returning a share that mismatches the registrant's
      //    declared own-injected slice (missing `actions`). The I-typed
      //    options form is where the mismatch surfaces (the full composed
      //    register constraint lands with the phase-2 consumer migration).
      const mismatched: SlotOptions<SlotMap['chain.session'], ChainInjected> = {
        // @ts-expect-error inject must supply the full registrant share
        inject: () => ({ useThing: () => 1 }),
      }
      void mismatched
      // 3. renderSlot on a key outside the whitelist.
      // @ts-expect-error 'chain.root' is not whitelisted on this surface
      slots.renderSlot('chain.root', {})
      // 4. keyed registration without options.
      // @ts-expect-error keyed kind requires options (RegisterArgs)
      core.register('chain.keyed', RootComp)
      // 5. Session-slot inject factory typed against RootBinding's surface.
      const sessionOpts: SlotOptions<{ kind: 'single'; scope: 'session'; props: ChainSessionProps }, ChainInjected> = {
        // @ts-expect-error session binding has sessionId; RootBinding-only factories don't type-check
        inject: (b: RootBinding & { notSession: true }) => ({ useThing: () => 1, actions: { open: () => {} } }),
      }
      void sessionOpts
      // 6. Hand-copied owner share drifting from the contract (wrong value type)
      //    — the composed-reference version right below compiles instead.
      interface DriftedProps { sessionId: number }
      const Drifted: FC<DriftedProps & ChainInjected> = () => null
      // @ts-expect-error drifted hand-copy of the owner share fails at register
      core.register('chain.session', Drifted)
      return null as ReactNode
    }
    expect(negatives).toBeTypeOf('function')
  })

  it('full chain (positive dual): composed props register, inject, and render cleanly', () => {
    const core = new SlotCore()
    core.define('chain.session', { kind: 'single', scope: 'session' })
    const dispose = core.register('chain.session', SessionComp, {
      inject: (b: SessionBinding): ChainInjected => ({
        useThing: () => b.sessionId.length,
        actions: { open: () => {} },
      }),
    })
    const entry = core.entries('chain.session')[0]!
    // Storage erasure boundary: entries() returns the default-I view; the
    // registrant share is restored after read-back (the budgeted cast).
    const injected = (entry.options.inject as unknown as (b: SessionBinding) => ChainInjected)(
      { sessionId: 's1', session: { useSelector: undefined }, ctx: undefined })
    expect(injected.useThing()).toBe(2)
    // Owner share stays reference-typed at the render surface.
    const ownerShare: OwnerOf<'chain.session'> = { sessionId: 's1' }
    expect(ownerShare.sessionId).toBe('s1')
    dispose()
    expect(core.entries('chain.session')).toHaveLength(0)
  })
})

// ── children validation layer (B-b, opt-in per entry) ───────────────────────

/** Delegating owner share: entry declares children, component carries a slots face. */
interface DelegOwnerShare { sessionId: string }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'chain.deleg': { kind: 'single'; scope: 'root'; props: object; owner: DelegOwnerShare; children: 'chain.child-a' | 'chain.child-b' }
    'chain.child-a': { kind: 'single'; scope: 'root'; props: object; owner: object }
    'chain.child-b': { kind: 'single'; scope: 'root'; props: object; owner: object }
    'chain.outside': { kind: 'single'; scope: 'root'; props: object; owner: object }
  }
}

describe('children validation layer (compile-time; bodies never run)', () => {
  it('accepts whitelists inside the authorized union, rejects outside keys', () => {
    const cases = (core: SlotCore) => {
      // Positive: slots face ⊆ children union (a strict subset is fine).
      const InUnion: FC<DelegOwnerShare & { slots: ScopedSlots<'chain.child-a'> }> = () => null
      core.register('chain.deleg', InUnion)
      // Positive: the full authorized union.
      const FullUnion: FC<DelegOwnerShare & { slots: ScopedSlots<'chain.child-a' | 'chain.child-b'> }> = () => null
      core.register('chain.deleg', FullUnion)
      // Positive: no slots face at all — delegation is optional.
      const NoSlots: FC<DelegOwnerShare> = () => null
      core.register('chain.deleg', NoSlots)
      // Negative: a key outside the authorized union collapses the slots constraint.
      const Outside: FC<DelegOwnerShare & { slots: ScopedSlots<'chain.outside'> }> = () => null
      // @ts-expect-error slots whitelist must stay inside the entry's children union
      core.register('chain.deleg', Outside)
      // Negative: smuggling an extra key alongside authorized ones still fails.
      const Mixed: FC<DelegOwnerShare & { slots: ScopedSlots<'chain.child-a' | 'chain.outside'> }> = () => null
      // @ts-expect-error a partially-authorized whitelist is still out of union
      core.register('chain.deleg', Mixed)
      // Entries WITHOUT children stay unchecked: any slots face registers
      // freely (I inferred from the inject factory as usual).
      const FreeFace: FC<ChainOwnerShare & { useSession: unknown } & ChainInjected & { slots: ScopedSlots<'chain.outside'> }> = () => null
      core.register('chain.session', FreeFace, {
        inject: (): ChainInjected & { slots: ScopedSlots<'chain.outside'> } =>
          ({ useThing: () => 1, actions: { open: () => {} }, slots: { renderSlot: () => null } }),
      })
    }
    expect(cases).toBeTypeOf('function')
  })
})
