// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SettingsRootComponentProps } from '../src/client/contract/slots.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'

afterEach(cleanup)

const DICT: Record<string, string> = {
  'settings:trigger': 'Settings',
  'settings:title': 'Settings',
  'settings:close': 'Close',
}

type Row = { id: string; order: number; label: string }

function mount({
  wide = true,
  rows = [
    { id: 'general', order: 0, label: 'General' },
    { id: 'models', order: 10, label: 'Models' },
  ],
}: { wide?: boolean; rows?: Row[] } = {}) {
  // Mutable row store standing in for the ledger; bump() plays a change.
  let current = rows
  let version = 0
  const listeners = new Set<() => void>()
  const renderSlot = vi.fn(
    ((_key: string, _owner: unknown, opts?: { only?: string }) =>
      <div data-testid={`section-${opts?.only ?? 'all'}`} />) as SettingsRootComponentProps['renderSlot'],
  )
  // Global standard kit stubs: the shell consumes neither hook.
  const unusedHook = (() => { throw new Error('unused by SettingsRoot') }) as never
  const props: SettingsRootComponentProps = {
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    wide,
    translate: (ref) => DICT[ref] ?? ref,
    sectionsVersion: () => version,
    subscribeSections: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    sections: () => current,
    renderSlot,
  }
  const view = render(<SettingsRoot {...props} />)
  const bump = (next: Row[]) => {
    act(() => {
      current = next
      version += 1
      for (const fn of [...listeners]) fn()
    })
  }
  return { view, renderSlot, bump, listeners }
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
}

describe('SettingsRoot trigger', () => {
  it('renders the wide row with the label and opens the dialog', () => {
    mount()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.textContent).toContain('Settings')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings', expanded: true })).toBeTruthy()
  })

  it('drops the label in the rail state', () => {
    mount({ wide: false })
    expect(screen.getByRole('button', { name: 'Settings' }).textContent).toBe('')
  })
})

describe('SettingsPanel close paths', () => {
  it('closes via the header button', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via a mask click', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog.parentElement!.firstElementChild!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via document-level Escape and unhooks the listener with the panel', () => {
    mount()
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // Ignored while closed (listener removed with the panel) and non-Escape
    // keys are ignored while open.
    fireEvent.keyDown(document, { key: 'Escape' })
    openPanel()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('lands focus on the close button when the dialog opens', () => {
    mount()
    openPanel()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})

describe('SettingsPanel navigation', () => {
  it('projects rows, marks the first active, and renders only that section', () => {
    mount()
    openPanel()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('switches the rendered section on nav click', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
  })

  it('falls back to the first row when the active entry unregisters', () => {
    const { bump } = mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    bump([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('renders an empty content column when the ledger is empty', () => {
    const { renderSlot } = mount({ rows: [] })
    openPanel()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(renderSlot).not.toHaveBeenCalled()
  })

  it('drops the ledger subscription on unmount', () => {
    const { view, listeners } = mount()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})
