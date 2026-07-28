// @vitest-environment jsdom
/**
 * PlanModeControl over the `plan` projection: an absent key (capability
 * absence) hides the control; {active, pending} renders committed and
 * pending-target labels; selection maps from the effective target and
 * surfaces failures without mutating the host-confirmed state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/client'
import { PlanModeControl, type PlanModeControlProps } from '../src/client/PlanModeControl.tsx'

afterEach(cleanup)

function setup(
  plan: PlanProjection | undefined,
  setPlanMode = vi.fn(() => Promise.resolve<string | null>(null)),
  locked = false,
) {
  const store = createSnapshotStore<{ value: PlanProjection | undefined }>({ value: plan })
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const props = { useProjection, locked, setPlanMode } as unknown as PlanModeControlProps
  const view = render(<PlanModeControl {...props} />)
  return { store, setPlanMode, view }
}

describe('PlanModeControl', () => {
  it('hides an absent capability and renders committed modes', () => {
    const absent = setup(undefined)
    expect(absent.view.container.innerHTML).toBe('')
    cleanup()
    setup({ active: false, pending: false })
    expect(screen.getByTitle('当前为默认模式')).toBeTruthy()
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: '协作模式' })
    expect(select.value).toBe('default')
    expect(document.getElementById(select.getAttribute('aria-describedby') ?? '')?.textContent)
      .toBe('当前为默认模式')
  })

  it('renders the pending target as the opposite of the committed state', () => {
    setup({ active: false, pending: true })
    expect(screen.getByText('计划 · 待生效')).toBeTruthy()
    const planSelect = screen.getByRole('combobox')
    expect(document.getElementById(planSelect.getAttribute('aria-describedby') ?? '')?.textContent)
      .toBe('当前为默认模式；计划模式将在下一次模型请求时生效')
    cleanup()
    setup({ active: true, pending: true })
    expect(screen.getByText('默认 · 待生效')).toBeTruthy()
    const defaultSelect = screen.getByRole<HTMLSelectElement>('combobox')
    expect(defaultSelect.value).toBe('default')
    expect(document.getElementById(defaultSelect.getAttribute('aria-describedby') ?? '')?.textContent)
      .toBe('当前为计划模式；默认模式将在下一次模型请求时生效')
  })

  it('switches from the effective target, disables during its own call, and follows the pushed projection', async () => {
    let resolve!: (value: string | null) => void
    const setPlanMode = vi.fn(() => new Promise<string | null>((done) => { resolve = done }))
    const { store } = setup({ active: false, pending: false }, setPlanMode)
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: '协作模式' })
    expect(select.disabled).toBe(false)
    fireEvent.change(select, { target: { value: 'plan' } })
    expect(setPlanMode).toHaveBeenCalledWith(true)
    expect(select.disabled).toBe(true)

    // The projection frame lands (command/run folded host-side).
    store.set({ value: { active: false, pending: true } })
    resolve(null)
    await waitFor(() => {
      expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(false)
    })
    expect(screen.getByText('计划 · 待生效')).toBeTruthy()
    // Re-selecting the effective target is a no-op.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    expect(setPlanMode).toHaveBeenCalledTimes(1)
  })

  it('disables under the locked owner prop', () => {
    setup({ active: false, pending: false }, vi.fn(), true)
    expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(true)
  })

  it('surfaces admission and transport failures without changing the confirmed mode', async () => {
    const setPlanMode = vi.fn()
      .mockResolvedValueOnce('host said no')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup({ active: false, pending: false }, setPlanMode)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    expect((await screen.findByText('模式切换失败')).getAttribute('title')).toBe('host said no')
    expect(screen.getByTitle('当前为默认模式')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    expect(await screen.findByTitle('network down')).toBeTruthy()
    expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(false)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    expect(await screen.findByTitle('socket closed')).toBeTruthy()
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const successful = setup(
      { active: false, pending: false },
      vi.fn(() => new Promise<string | null>((done) => { resolve = done })),
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    successful.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const setPlanMode = vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail }))
    const { view } = setup({ active: false, pending: false }, setPlanMode)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
