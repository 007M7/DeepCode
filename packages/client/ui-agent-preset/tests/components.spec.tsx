// @vitest-environment jsdom
/**
 * The two preset surfaces: the General-settings row naming the default for
 * later sessions, and the composer seat naming this one's. The split is the
 * host's rule — a session's history is produced under its preset's tools, so
 * the choice is only ever offered while the conversation has not started.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentPresetRow } from '../src/client/AgentPresetRow.tsx'
import type { AgentPresetRowProps } from '../src/client/AgentPresetRow.tsx'
import { AgentPresetSeat } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSeatProps } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSettingsState } from '../src/client/settings-store.ts'
import type { AgentPresetSeatState } from '../src/client/seat-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const ROW_READY: AgentPresetSettingsState = {
  status: 'ready',
  error: null,
  writable: true,
  currentValue: 'standard',
  options: [{ id: 'standard', trust: 'system' }, { id: 'mine', trust: 'user' }],
}

const SEAT_READY: AgentPresetSeatState = {
  current: 'standard',
  options: [{ id: 'standard', trust: 'system' }, { id: 'mine', trust: 'user' }],
  switchable: true,
  busy: false,
  error: null,
}

function renderRow(state: Partial<AgentPresetSettingsState> = {}) {
  const store = createSnapshotStore<AgentPresetSettingsState>({ ...ROW_READY, ...state })
  const actions = { load: vi.fn(() => Promise.resolve()), select: vi.fn(() => Promise.resolve()) }
  render(<AgentPresetRow {...({
    ...actions,
    useAgentPreset: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as AgentPresetRowProps)} />)
  return { ...actions, store }
}

function renderSeat(state: Partial<AgentPresetSeatState> = {}, locked = false) {
  const store = createSnapshotStore<AgentPresetSeatState>({ ...SEAT_READY, ...state })
  const actions = { load: vi.fn(() => Promise.resolve()), select: vi.fn(() => Promise.resolve()) }
  render(<AgentPresetSeat {...({
    ...actions,
    locked,
    useAgentPresetSeat: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as AgentPresetSeatProps)} />)
  return { ...actions, store }
}

describe('the General-settings row', () => {
  it('reads the roster once and shows the current default', async () => {
    const { load } = renderRow()

    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button').textContent).toContain('standard')
    expect(screen.getByText(en.title)).toBeTruthy()
  })

  it('marks a locally authored option as local', () => {
    renderRow()

    fireEvent.click(screen.getByRole('button'))

    // A locally authored preset is as privileged as the plugins it names, so
    // the list says so rather than presenting every row as shipped and vetted.
    expect(screen.getByText(`mine · ${en.userTrust}`)).toBeTruthy()
    // A shipped preset carries no such mark — the id is all the menu says.
    expect(screen.getByRole('menu').textContent).toBe(`standardmine · ${en.userTrust}`)
  })

  it('writes the picked preset and closes the menu', () => {
    const { select } = renderRow()

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText(`mine · ${en.userTrust}`))

    expect(select).toHaveBeenCalledWith('mine')
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on an outside dismissal', () => {
    renderRow()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('says it is loading before the roster answers', () => {
    renderRow({ status: 'loading', currentValue: '' })

    expect(screen.getByRole('button').textContent).toContain(en.loading)
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  })

  it('shows a failure in place of the description', () => {
    renderRow({ error: 'boom' })

    expect(screen.getByRole('alert').textContent).toBe('boom')
  })

  it('renders nothing when the deployment composes no presets', () => {
    const { container } = render(<AgentPresetRow {...({
      load: vi.fn(() => Promise.resolve()),
      select: vi.fn(() => Promise.resolve()),
      useAgentPreset: bindSnapshotSelector(
        createSnapshotStore<AgentPresetSettingsState>({ ...ROW_READY, status: 'unavailable' }),
      ),
      t: (key: keyof typeof en) => en[key],
    } as unknown as AgentPresetRowProps)} />)

    expect(container.textContent).toBe('')
  })

  it('closes and locks the menu when the settings turn read-only', () => {
    const { store } = renderRow()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')

    act(() => { store.set({ ...ROW_READY, writable: false }) })

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  })
})

describe('the composer seat', () => {
  it('reads this session\'s state once and shows the preset it runs', async () => {
    const { load } = renderSeat()

    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button').textContent).toContain('standard')
    expect(screen.getByRole('button').getAttribute('title')).toBe(en.seatHint)
  })

  it('switches this session and closes the menu', () => {
    const { select } = renderSeat()

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText(`mine · ${en.userTrust}`))

    expect(select).toHaveBeenCalledWith('mine')
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on an outside dismissal', () => {
    renderSeat()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('offers no control once the conversation has started', () => {
    renderSeat({ switchable: false })

    // A disabled menu would suggest the preset could still be changed; past
    // the first turn it is a fact about the session, not a control.
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByTitle(en.lockedHint).textContent).toBe('standard')
  })

  it('closes an open menu when the session stops being switchable', () => {
    const { store } = renderSeat()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')

    act(() => { store.set({ ...SEAT_READY, switchable: false }) })

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('disables the trigger while a switch is in flight, and while the composer is', () => {
    const { store } = renderSeat({ busy: true })
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)

    act(() => { store.set(SEAT_READY) })
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false)

    cleanup()
    renderSeat({}, true)
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  })

  it('shows a refused switch on the trigger', () => {
    renderSeat({ error: 'agent-preset-locked' })

    expect(screen.getByRole('button').getAttribute('title')).toBe('agent-preset-locked')
  })

  it('renders nothing before the roster arrives or when there is none', () => {
    const { container } = render(<AgentPresetSeat {...({
      load: vi.fn(() => Promise.resolve()),
      select: vi.fn(() => Promise.resolve()),
      locked: false,
      useAgentPresetSeat: bindSnapshotSelector(
        createSnapshotStore<AgentPresetSeatState>({ ...SEAT_READY, options: [] }),
      ),
      t: (key: keyof typeof en) => en[key],
    } as unknown as AgentPresetSeatProps)} />)

    expect(container.textContent).toBe('')
    cleanup()

    const bare = render(<AgentPresetSeat {...({
      load: vi.fn(() => Promise.resolve()),
      select: vi.fn(() => Promise.resolve()),
      locked: false,
      useAgentPresetSeat: bindSnapshotSelector(
        createSnapshotStore<AgentPresetSeatState>({ ...SEAT_READY, current: '' }),
      ),
      t: (key: keyof typeof en) => en[key],
    } as unknown as AgentPresetSeatProps)} />)

    expect(bare.container.textContent).toBe('')
  })
})
