// Tool-ring type-chain samples (design §9 item 5, toolviews half): the
// register→inject→resolve chain where `I` is inferred from the inject
// factory and proved against the component at the register site, plus
// expect-error duals. Tool names stay an open set (no per-tool props table —
// design §7); the strong typing under test is Entry-internal. The known
// bare-register variance edge (FC<Props & I> assignable to FC<Props & object>
// without an inject factory) is accepted by design §7 and deliberately not
// pinned here. Follows the slots-ring exemplar's shape.
import { describe, expect, it } from 'vitest'
import type { FC, ReactNode } from 'react'
import type { SessionBinding } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolViewOptions, ToolViewProps } from '../src/client/contract/toolview.ts'
import { ToolViewRegistry } from '../src/client/toolviews/registry.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

const sid = (s: string): SessionId => s as SessionId

/** Registrant's own injected share (locally declared — ownership rule). */
interface RowInjected { useRuns: () => number; actions2: { rerun: () => void } }

const InjectedRow: FC<ToolViewProps & RowInjected> = () => null
const PlainRow: FC<ToolViewProps> = () => null

describe('tool-ring type-chain negatives (compile-time; body never runs)', () => {
  it('holds the negative samples as expect-error sites', () => {
    const negatives = (registry: ToolViewRegistry) => {
      // 1. Inject factory under-produces the component's declared share:
      //    I infers from the factory, and the component position then fails.
      registry.register(
        'bash',
        // @ts-expect-error component wants actions2, which the factory never produces
        InjectedRow,
        { inject: () => ({ useRuns: () => 1 }) },
      )
      // 2. Inject factory produces a drifted value type for a declared key
      //    (I infers from the component position here, so TS flags the factory).
      registry.register(
        'bash',
        InjectedRow,
        // @ts-expect-error useRuns returns string here, component wants number
        { inject: () => ({ useRuns: () => 'one', actions2: { rerun: () => {} } }) },
      )
      // 3. Options object drifts: scope filter with a wrong parameter shape.
      const badScope: ToolViewOptions<RowInjected> = {
        // @ts-expect-error scope takes a SessionId, not a numeric index
        scope: (index: number) => index > 0,
      }
      void badScope
      // 4. Component demanding props outside ToolViewProps & I (a key neither
      //    standard nor injected) cannot register even with a full factory.
      const Overreaching: FC<ToolViewProps & RowInjected & { fromNowhere: boolean }> = () => null
      registry.register(
        'bash',
        // @ts-expect-error fromNowhere is neither a standard prop nor produced by the factory
        Overreaching,
        { inject: (): RowInjected => ({ useRuns: () => 1, actions2: { rerun: () => {} } }) },
      )
      return null as ReactNode
    }
    expect(negatives).toBeTypeOf('function')
  })
})

describe('tool-ring full chain (positive dual)', () => {
  it('registers with an inferred inject share, resolves by scope order, and reads the erased face back', () => {
    const registry = new ToolViewRegistry()
    // Registration: I inferred from the factory, component proved ⊇ ToolViewProps & I.
    const disposeGlobal = registry.register('bash', InjectedRow, {
      inject: (b: SessionBinding): RowInjected => ({
        useRuns: () => b.sessionId.length,
        actions2: { rerun: () => {} },
      }),
    })
    const disposeScoped = registry.register('bash', PlainRow, {
      scope: id => id === sid('swarm-1'),
    })

    // Resolve: scope match beats global; elsewhere the global row wins.
    expect(registry.resolve('bash', sid('swarm-1'))?.component).toBe(PlainRow)
    const global = registry.resolve('bash', sid('other'))
    expect(global?.component).toBe(InjectedRow)
    // Read face: I is erased to object, the factory reference survives; the
    // outlet-side restoration is the budgeted cast (same boundary as slots).
    const injected = (global?.inject as (b: SessionBinding) => RowInjected)(
      { sessionId: 'ab', session: { useSelector: undefined }, ctx: undefined },
    )
    expect(injected.useRuns()).toBe(2)
    // Unknown tool → undefined (caller falls back to the generic card).
    expect(registry.resolve('ghost-tool', sid('other'))).toBeUndefined()

    disposeScoped()
    expect(registry.resolve('bash', sid('swarm-1'))?.component).toBe(InjectedRow)
    disposeGlobal()
    expect(registry.resolve('bash', sid('other'))).toBeUndefined()
  })
})
