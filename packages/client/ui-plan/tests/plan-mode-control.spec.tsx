// @vitest-environment jsdom
/**
 * PlanChip over the `plan` projection: nothing renders while the capability
 * is absent; with the capability present the chip renders in both states with
 * aria-pressed following the effective target (pending folds — /plan shows
 * pressed immediately, /plan off unpressed immediately); clicking executes
 * the command toward the opposite target and surfaces direction-specific
 * failures while the projection still owns the displayed state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/client'
import { PlanChip, type PlanChipProps } from '../src/client/PlanModeControl.tsx'

afterEach(cleanup)

function setup(
  plan: PlanProjection | undefined,
  setPlanMode = vi.fn((_on: boolean) => Promise.resolve<string | null>(null)),
  locked = false,
) {
  const store = createSnapshotStore<{ value: PlanProjection | undefined }>({ value: plan })
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const props = { useProjection, locked, setPlanMode } as unknown as PlanChipProps
  const view = render(<PlanChip {...props} />)
  return { store, setPlanMode, view }
}

const onChip = () => screen.getByRole('button', { name: 'Plan mode on, press to turn off' })
const offChip = () => screen.getByRole('button', { name: 'Plan mode off, press to turn on' })

describe('PlanChip', () => {
  it('renders nothing while the capability is absent', () => {
    const absent = setup(undefined)
    expect(absent.view.container.innerHTML).toBe('')
  })

  it('reflects the effective target as the pressed state, folding pending', () => {
    setup({ active: false, pending: false })
    expect(offChip().getAttribute('aria-pressed')).toBe('false')
    cleanup()
    setup({ active: true, pending: false })
    expect(onChip().getAttribute('aria-pressed')).toBe('true')
    cleanup()
    // /plan just ran (command/run folded, plan/mode not yet): target is plan.
    setup({ active: false, pending: true })
    expect(onChip().getAttribute('aria-pressed')).toBe('true')
    cleanup()
    // Active with a pending exit: the target is default — already unpressed.
    setup({ active: true, pending: true })
    expect(offChip().getAttribute('aria-pressed')).toBe('false')
  })

  it('unpressed chip executes /plan (on) once and follows the projection up', async () => {
    let resolve!: (value: string | null) => void
    const setPlanMode = vi.fn((_on: boolean) => new Promise<string | null>((done) => { resolve = done }))
    const { store } = setup({ active: false, pending: false }, setPlanMode)
    fireEvent.click(offChip())
    expect(setPlanMode).toHaveBeenCalledTimes(1)
    expect(setPlanMode).toHaveBeenLastCalledWith(true)
    // Busy while its own call is in flight.
    fireEvent.click(offChip())
    expect(setPlanMode).toHaveBeenCalledTimes(1)
    resolve(null)
    // The command's run record folds: target flips, the chip presses.
    store.set({ value: { active: false, pending: true } })
    await waitFor(() => {
      expect(onChip().getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('pressed chip executes /plan off and follows the projection down', async () => {
    const setPlanMode = vi.fn((_on: boolean) => Promise.resolve<string | null>(null))
    const { store } = setup({ active: true, pending: false }, setPlanMode)
    fireEvent.click(onChip())
    expect(setPlanMode).toHaveBeenLastCalledWith(false)
    store.set({ value: { active: true, pending: true } })
    await waitFor(() => {
      expect(offChip().getAttribute('aria-pressed')).toBe('false')
    })
  })

  it('disables under the locked owner prop', () => {
    setup({ active: true, pending: false }, vi.fn(), true)
    expect((onChip() as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces direction-specific admission and transport failures while staying visible', async () => {
    const exitFailing = vi.fn()
      .mockResolvedValueOnce('host said no')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup({ active: true, pending: false }, exitFailing)
    fireEvent.click(onChip())
    expect((await screen.findByText('退出 plan mode 失败')).getAttribute('title')).toBe('host said no')
    expect(onChip()).toBeTruthy()

    fireEvent.click(onChip())
    expect(await screen.findByTitle('network down')).toBeTruthy()

    fireEvent.click(onChip())
    expect(await screen.findByTitle('socket closed')).toBeTruthy()
    cleanup()

    const enterFailing = vi.fn().mockResolvedValueOnce('agent busy')
    setup({ active: false, pending: false }, enterFailing)
    fireEvent.click(offChip())
    expect((await screen.findByText('进入 plan mode 失败')).getAttribute('title')).toBe('agent busy')
    expect(offChip()).toBeTruthy()
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const successful = setup(
      { active: true, pending: false },
      vi.fn(() => new Promise<string | null>((done) => { resolve = done })),
    )
    fireEvent.click(onChip())
    successful.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const setPlanMode = vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail }))
    const { view } = setup({ active: true, pending: false }, setPlanMode)
    fireEvent.click(onChip())
    view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
