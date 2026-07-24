// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  ConversationSnapshot, SessionId, SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { PlanModeState } from '@deepseek-ai/dsh-client-connection/client'
import { PlanModeControl } from '../src/client/PlanModeControl.tsx'

afterEach(cleanup)

const SID = 's-plan' as SessionId

function setup(
  planMode: PlanModeState | null,
  setPlanMode = vi.fn(() => Promise.resolve<string | null>(null)),
  running = false,
) {
  const store = createSnapshotStore({ planMode, running })
  const useSession = bindSnapshotSelector(store) as unknown as SnapshotSelectorHook<ConversationSnapshot>
  const useSessions = (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>
  const view = render(
    <PlanModeControl
      sessionId={SID}
      useSession={useSession}
      useSessions={useSessions}
      setPlanMode={setPlanMode}
    />,
  )
  return { store, setPlanMode, view }
}

describe('PlanModeControl', () => {
  it('hides an unavailable capability and renders committed modes', () => {
    const unavailable = setup(null)
    expect(unavailable.view.container.innerHTML).toBe('')
    cleanup()
    setup({ active: false })
    expect(screen.getByTitle('当前为默认模式')).toBeTruthy()
    expect((screen.getByRole('combobox', { name: '协作模式' }) as HTMLSelectElement).value).toBe('default')
  })

  it('treats pending field presence as the target, including pending false', () => {
    setup({ active: false, pending: true })
    expect(screen.getByText('计划 · 待生效')).toBeTruthy()
    expect(screen.getByTitle(/当前为默认模式/)).toBeTruthy()
    cleanup()
    setup({ active: true, pending: false })
    expect(screen.getByText('默认 · 待生效')).toBeTruthy()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('default')
  })

  it('switches from the effective target and remains available while a turn runs', async () => {
    let resolve!: (value: string | null) => void
    const setPlanMode = vi.fn(() => new Promise<string | null>((done) => { resolve = done }))
    const { store } = setup({ active: false }, setPlanMode, true)
    const select = screen.getByRole('combobox', { name: '协作模式' }) as HTMLSelectElement
    expect(select.disabled).toBe(false)
    fireEvent.change(select, { target: { value: 'plan' } })
    expect(setPlanMode).toHaveBeenCalledWith(true)
    expect(select.disabled).toBe(true)

    store.set({ planMode: { active: false, pending: true }, running: true })
    resolve(null)
    await waitFor(() => {
      expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false)
    })
    expect(screen.getByText('计划 · 待生效')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    expect(setPlanMode).toHaveBeenCalledTimes(1)
  })

  it('surfaces host and transport failures without changing the confirmed mode', async () => {
    const setPlanMode = vi.fn()
      .mockResolvedValueOnce('host said no')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup({ active: false }, setPlanMode)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    expect((await screen.findByText('模式切换失败')).getAttribute('title')).toBe('host said no')
    expect(screen.getByTitle('当前为默认模式')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    expect(await screen.findByTitle('network down')).toBeTruthy()
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    expect(await screen.findByTitle('socket closed')).toBeTruthy()
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const successful = setup(
      { active: false },
      vi.fn(() => new Promise<string | null>((done) => { resolve = done })),
    )
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    successful.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const setPlanMode = vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail }))
    const { view } = setup({ active: false }, setPlanMode)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plan' } })
    view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
