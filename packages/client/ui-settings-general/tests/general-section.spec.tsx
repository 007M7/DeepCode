// @vitest-environment jsdom
/** GeneralSection behavior: skeleton rows stay inert, Language menu drives
 * setLocale, Appearance cubes follow the preference and drive setTheme. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import { createGeneralSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import type { GeneralSectionComponentProps } from '../src/client/contract.ts'

afterEach(cleanup)

const LOCALES = [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }]

/** Empty global standard-kit hooks (the section reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, intent: undefined, phase: 'ready' })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], intent: undefined, state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function mount(init?: { active?: string; preference?: 'light' | 'dark' | 'system' }) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createGeneralSettingsStore().create()
  store.actions.syncLocale(init?.active ?? 'en', LOCALES, 0)
  store.actions.syncTheme(init?.preference ?? 'system', 0)
  const setLocale = vi.fn()
  const setTheme = vi.fn()
  const props: GeneralSectionComponentProps = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => en[key] ?? key,
    setLocale,
    setTheme,
  }
  render(<GeneralSection {...props} />)
  return { store, setLocale, setTheme }
}

const pressed = (name: RegExp): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('GeneralSection', () => {
  it('renders the four groups with skeleton rows inert', () => {
    const b = mount()
    // Permission: disabled selector showing the fixed value.
    const permission = screen.getByRole('button', { name: /Read only/ }) as HTMLButtonElement
    expect(permission.disabled).toBe(true)
    fireEvent.click(permission)
    // Tool Call: both mode cubes render as plain text, no buttons.
    expect(screen.getByText('Schema mode')).toBeDefined()
    expect(screen.getByText('Code mode')).toBeDefined()
    expect(screen.queryByRole('button', { name: /Schema mode/ })).toBeNull()
    expect(b.setLocale).not.toHaveBeenCalled()
    expect(b.setTheme).not.toHaveBeenCalled()
  })

  it('opens the language menu, selects a locale, and closes', () => {
    const b = mount({ active: 'en' })
    const trigger = screen.getByRole('button', { name: /English/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: '中文' }))
    expect(b.setLocale).toHaveBeenCalledWith('zh')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menuitem', { name: '中文' })).toBeNull()
  })

  it('closes the language menu on outside pointerdown without selecting', () => {
    const b = mount({ active: 'en' })
    const trigger = screen.getByRole('button', { name: /English/ })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: '中文' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menuitem', { name: '中文' })).toBeNull()
    expect(b.setLocale).not.toHaveBeenCalled()
  })

  it('reflects a store locale change in the trigger label (unknown id falls back to the id)', () => {
    const b = mount({ active: 'en' })
    act(() => { b.store.actions.syncLocale('zh', LOCALES, 1) })
    expect(screen.getByRole('button', { name: /中文/ })).toBeDefined()
    act(() => { b.store.actions.syncLocale('fr', LOCALES, 2) })
    expect(screen.getByRole('button', { name: /fr/ })).toBeDefined()
  })

  it('marks the appearance cube matching the preference and switches on click', () => {
    const b = mount({ preference: 'dark' })
    expect(pressed(/Dark/)).toBe('true')
    expect(pressed(/Light/)).toBe('false')
    expect(pressed(/System/)).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /Light/ }))
    expect(b.setTheme).toHaveBeenCalledWith('light')
    // Selection follows the store mirror, not the click echo.
    act(() => { b.store.actions.syncTheme('light', 1) })
    expect(pressed(/Light/)).toBe('true')
    expect(pressed(/Dark/)).toBe('false')
  })
})
