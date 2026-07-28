// @vitest-environment jsdom
/**
 * PlanChip over the `plan` projection: nothing renders while the capability
 * is absent or the effective target is the default mode; the chip renders
 * while the target is plan mode (pending follows the target — /plan shows it
 * immediately, /plan off hides it immediately); the chip button executes
 * /plan off and surfaces failures without hiding until the projection says so.
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
  exitPlanMode = vi.fn(() => Promise.resolve<string | null>(null)),
  locked = false,
) {
  const store = createSnapshotStore<{ value: PlanProjection | undefined }>({ value: plan })
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const props = { useProjection, locked, exitPlanMode } as unknown as PlanChipProps
  const view = render(<PlanChip {...props} />)
  return { store, exitPlanMode, view }
}

const chip = () => screen.getByRole('button', { name: 'Plan mode on, press to turn off' })

describe('PlanChip', () => {
  it('renders nothing for absent capability or the default mode', () => {
    const absent = setup(undefined)
    expect(absent.view.container.innerHTML).toBe('')
    cleanup()
    const inactive = setup({ active: false, pending: false })
    expect(inactive.view.container.innerHTML).toBe('')
    cleanup()
    // Active with a pending exit: the target is default — chip already gone.
    const leaving = setup({ active: true, pending: true })
    expect(leaving.view.container.innerHTML).toBe('')
  })

  it('renders while the effective target is plan mode, including the pending entry window', () => {
    setup({ active: true, pending: false })
    expect(chip()).toBeTruthy()
    cleanup()
    // /plan just ran (command/run folded, plan/mode not yet): target is plan.
    setup({ active: false, pending: true })
    expect(chip()).toBeTruthy()
  })

  it('the chip executes /plan off once and follows the projection down', async () => {
    let resolve!: (value: string | null) => void
    const exitPlanMode = vi.fn(() => new Promise<string | null>((done) => { resolve = done }))
    const { store } = setup({ active: true, pending: false }, exitPlanMode)
    fireEvent.click(chip())
    expect(exitPlanMode).toHaveBeenCalledTimes(1)
    // Busy while its own call is in flight.
    fireEvent.click(chip())
    expect(exitPlanMode).toHaveBeenCalledTimes(1)
    resolve(null)
    // The off command's run record folds: target flips, the chip unmounts.
    store.set({ value: { active: true, pending: true } })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Plan mode on, press to turn off' })).toBeNull()
    })
  })

  it('disables under the locked owner prop', () => {
    setup({ active: true, pending: false }, vi.fn(), true)
    expect((chip() as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces admission and transport failures while staying visible', async () => {
    const exitPlanMode = vi.fn()
      .mockResolvedValueOnce('host said no')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup({ active: true, pending: false }, exitPlanMode)
    fireEvent.click(chip())
    expect((await screen.findByText('退出 plan mode 失败')).getAttribute('title')).toBe('host said no')
    expect(chip()).toBeTruthy()

    fireEvent.click(chip())
    expect(await screen.findByTitle('network down')).toBeTruthy()

    fireEvent.click(chip())
    expect(await screen.findByTitle('socket closed')).toBeTruthy()
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const successful = setup(
      { active: true, pending: false },
      vi.fn(() => new Promise<string | null>((done) => { resolve = done })),
    )
    fireEvent.click(chip())
    successful.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const exitPlanMode = vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail }))
    const { view } = setup({ active: true, pending: false }, exitPlanMode)
    fireEvent.click(chip())
    view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
