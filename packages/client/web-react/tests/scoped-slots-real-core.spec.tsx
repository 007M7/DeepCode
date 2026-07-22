// @vitest-environment jsdom
/**
 * Integration against the real ui-slots SlotCore (T1): the outlet's uSES
 * pairing rides the real subscribe/getVersion/entries surfaces, and the
 * whitelist narrows at compile time (expect-error negative samples).
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { scopedSlots } from '@deepseek-ai/dsh-client-web-react'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'spec.single': { kind: 'single'; scope: 'root'; props: { label?: string } }
    'spec.list': { kind: 'list'; scope: 'root'; props: object }
    'spec.off-limits': { kind: 'single'; scope: 'root'; props: object }
  }
}

describe('scopedSlots over the real SlotCore', () => {
  it('renders registrations live: define, register, dispose back to fallback', async () => {
    const core = new SlotCore()
    core.define('spec.single', { kind: 'single', scope: 'root' })
    const slots = scopedSlots(core, 'spec.single')
    const view = render(<>{slots.renderSlot('spec.single', {}, { fallback: <i>none</i> })}</>)
    expect(view.container.textContent).toBe('none')
    let dispose = () => {}
    // The real core batches subscriber notification per microtask: async act.
    await act(async () => { dispose = core.register('spec.single', ({ label }) => <b>{label ?? 'on'}</b>) })
    expect(view.container.textContent).toBe('on')
    await act(async () => { dispose(); dispose() })   // disposer is idempotent in the real core
    expect(view.container.textContent).toBe('none')
  })

  it('passes owner props through and orders list entries', () => {
    const core = new SlotCore()
    core.define('spec.single', { kind: 'single', scope: 'root' })
    core.define('spec.list', { kind: 'list', scope: 'root' })
    core.register('spec.single', ({ label }) => <b>{label}</b>)
    core.register('spec.list', () => <span>2</span>, { id: 'two', order: 2 })
    core.register('spec.list', () => <span>1</span>, { id: 'one', order: 1 })
    const slots = scopedSlots(core, 'spec.single', 'spec.list')
    const view = render(
      <>
        {slots.renderSlot('spec.single', { label: 'owner' })}
        {slots.renderSlot('spec.list', {})}
      </>,
    )
    expect(view.container.textContent).toBe('owner12')
  })

  it('fails loud when rendering a key that was never defined', () => {
    const core = new SlotCore()
    const slots = scopedSlots(core, 'spec.single')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<>{slots.renderSlot('spec.single', {})}</>)).toThrow(/before define/)
    spy.mockRestore()
  })

  it('narrows the whitelist at compile time and backstops at runtime', () => {
    const core = new SlotCore()
    core.define('spec.single', { kind: 'single', scope: 'root' })
    core.define('spec.off-limits', { kind: 'single', scope: 'root' })
    const slots = scopedSlots(core, 'spec.single')
    // @ts-expect-error spec.off-limits is outside this ScopedSlots whitelist
    expect(() => slots.renderSlot('spec.off-limits', {})).toThrow(/whitelist/)
    // @ts-expect-error unknown keys are rejected even before whitelist narrowing
    expect(() => slots.renderSlot('spec.nonexistent', {})).toThrow(/whitelist/)
  })
})
