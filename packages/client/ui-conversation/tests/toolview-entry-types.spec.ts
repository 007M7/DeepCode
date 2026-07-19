/**
 * Tool-ring Entry typing (design §7): I inferred from the inject factory at
 * the register site, component must accept ToolViewProps & I, and the resolve
 * read face carries the erased-but-present inject. Compile-time checks via
 * @ts-expect-error pairs; the runtime assertions just keep vitest happy.
 */
import { describe, expect, it } from 'vitest'
import type { FC } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ToolViewRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

const sid = (s: string): SessionId => s as SessionId

// Positive control: component's own injected share matches the factory's product.
interface RowInjected { useMyStore: () => number }
const InjectedRowComp: FC<ToolViewProps & RowInjected> = () => null
// Plain rows take the shared props only.
const PlainRowComp: FC<ToolViewProps> = () => null

describe('tool-ring entry typing', () => {
  it('register infers I from the inject factory and accepts a matching component', () => {
    const reg = new ToolViewRegistry()
    const off = reg.register('bash', InjectedRowComp, {
      inject: () => ({ useMyStore: () => 1 }),
    })
    expect(reg.resolve('bash', sid('s'))?.inject).toBeDefined()
    off()
  })

  it('injectless registration needs no options and resolves without inject', () => {
    const reg = new ToolViewRegistry()
    reg.register('read', PlainRowComp)
    expect('inject' in (reg.resolve('read', sid('s')) ?? {})).toBe(false)
  })

  it('compile-time: factory product must cover the component injected share', () => {
    const reg = new ToolViewRegistry()
    reg.register('bash', InjectedRowComp, {
      // @ts-expect-error the factory misses useMyStore, which the component requires
      inject: () => ({ somethingElse: 1 }),
    })
    expect(true).toBe(true)
  })

  // Known boundary (not asserted): a component demanding an injected share CAN
  // register bare — with I defaulting to `object`, FC<ToolViewProps & RowInjected>
  // is structurally assignable to FC<ToolViewProps & object> (parameter
  // bivariance over a wider props type). The register-site guarantee holds in
  // the direction that matters: WITH an inject factory, its product must cover
  // the component's share (previous case). The bare-register gap is the same
  // one SlotMap's single-kind register has and is accepted by design §7.

  it('compile-time: scope filter receives the branded SessionId', () => {
    const reg = new ToolViewRegistry()
    reg.register('bash', PlainRowComp, {
      // @ts-expect-error number is not assignable to SessionId
      scope: (id: number) => id > 0,
    })
    expect(true).toBe(true)
  })
})
