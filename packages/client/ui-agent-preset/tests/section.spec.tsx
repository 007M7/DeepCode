// @vitest-environment jsdom
/**
 * The management section's rendering rules: which actions a row offers depends
 * on its trust and whether it is the default, a shipped composition opens
 * without a Save, and a draft the host would refuse is blocked before it is
 * sent.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentPresetSection } from '../src/client/AgentPresetSection.tsx'
import type { AgentPresetSectionProps } from '../src/client/AgentPresetSection.tsx'
import type { AgentPresetSectionState } from '../src/client/section-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const READY: AgentPresetSectionState = {
  status: 'ready',
  error: null,
  authorable: true,
  rows: [
    { id: 'standard', trust: 'system', isDefault: true },
    { id: 'mine', trust: 'user', isDefault: false },
  ],
  draft: null,
  pendingDelete: null,
  deleting: false,
}

/**
 * Render the section over a fixed snapshot, with every action a spy.
 * @param state - the snapshot to render.
 * @returns the spies, so a test can assert what a click reached.
 */
function renderSection(state: Partial<AgentPresetSectionState> = {}) {
  const store = createSnapshotStore<AgentPresetSectionState>({ ...READY, ...state })
  const actions = {
    load: vi.fn(() => Promise.resolve()),
    open: vi.fn(() => Promise.resolve()),
    createFrom: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
    setId: vi.fn(),
    setContent: vi.fn(),
    save: vi.fn(() => Promise.resolve()),
    confirmDelete: vi.fn(),
    remove: vi.fn(() => Promise.resolve()),
    makeDefault: vi.fn(() => Promise.resolve()),
  }
  const props = {
    ...actions,
    useAgentPresetSection: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as AgentPresetSectionProps
  render(<AgentPresetSection {...props} />)
  return actions
}

function rowFor(id: string): HTMLElement {
  const row = screen.getByText(id).closest('li')
  /* v8 ignore next -- every rendered row id resolves to its card */
  if (row === null) throw new Error(`no row for ${id}`)
  return row
}

describe('the preset list', () => {
  it('reads the roster once when it first renders', async () => {
    const actions = renderSection()

    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
  })

  it('marks trust and the default, and offers no "set default" on the default row', () => {
    renderSection()

    const standard = rowFor('standard')
    expect(within(standard).getByText(en.builtIn)).toBeTruthy()
    expect(within(standard).getByText(en.defaultBadge)).toBeTruthy()
    expect(within(standard).queryByText(en.setDefault)).toBeNull()
    expect(within(rowFor('mine')).getByText(en.userTrust)).toBeTruthy()
  })

  it('offers Edit for a local preset and View for a shipped one', () => {
    renderSection()

    expect(within(rowFor('mine')).getByText(en.edit)).toBeTruthy()
    // A shipped composition is readable but not editable, and the label is
    // what says so before the editor opens.
    expect(within(rowFor('standard')).getByText(en.view)).toBeTruthy()
  })

  it('offers Delete only for a locally authored preset', () => {
    renderSection()

    expect(within(rowFor('mine')).getByText(en.delete)).toBeTruthy()
    expect(within(rowFor('standard')).queryByText(en.delete)).toBeNull()
  })

  it('hides duplication and disables creation when nothing is writable', () => {
    renderSection({ authorable: false })

    expect(screen.queryByText(en.duplicate)).toBeNull()
    expect(screen.getByText(`+ ${en.newPreset}`)).toHaveProperty('disabled', true)
  })

  it('routes the row actions to the controller', () => {
    const actions = renderSection()

    fireEvent.click(within(rowFor('mine')).getByText(en.setDefault))
    fireEvent.click(within(rowFor('mine')).getByText(en.edit))
    fireEvent.click(within(rowFor('mine')).getByText(en.duplicate))
    fireEvent.click(screen.getByText(`+ ${en.newPreset}`))

    expect(actions.makeDefault).toHaveBeenCalledWith('mine')
    expect(actions.open).toHaveBeenCalledWith('mine')
    expect(actions.createFrom).toHaveBeenCalledWith('mine')
    // The bare "new" copies the default, which the controller resolves.
    expect(actions.createFrom).toHaveBeenLastCalledWith()
  })

  it('shows a page-level failure without hiding the list', () => {
    renderSection({ error: 'settings are read-only' })

    expect(screen.getByRole('alert').textContent).toBe('settings are read-only')
    expect(rowFor('mine')).toBeTruthy()
  })

  it('renders nothing when the deployment composes no presets', () => {
    const { container } = render(<AgentPresetSection {...({
      useAgentPresetSection: bindSnapshotSelector(
        createSnapshotStore<AgentPresetSectionState>({ ...READY, status: 'unavailable', rows: [] })),
      t: (key: keyof typeof en) => en[key],
      load: vi.fn(() => Promise.resolve()),
    } as unknown as AgentPresetSectionProps)} />)

    expect(container.firstChild).toBeNull()
  })

  it('offers a retry when the roster could not be read', () => {
    const actions = renderSection({ status: 'error', error: 'roster unavailable' })

    expect(screen.getByRole('alert').textContent).toContain('roster unavailable')
    fireEvent.click(screen.getByText(en.retry))

    expect(actions.load).toHaveBeenCalledTimes(2)
  })
})

describe('the composition editor', () => {
  const draft = {
    id: 'mine', source: 'mine', creating: false, content: '- id: tool-read\n',
    writable: true, saving: false, error: null,
  }

  it('opens under the row it belongs to and edits through the controller', () => {
    const actions = renderSection({ draft })

    const editor = within(rowFor('mine')).getByRole('textbox')
    expect(editor).toHaveProperty('value', '- id: tool-read\n')
    fireEvent.change(editor, { target: { value: '- id: tool-edit\n' } })

    expect(actions.setContent).toHaveBeenCalledWith('- id: tool-edit\n')
  })

  it('saves and cancels through the controller', () => {
    const actions = renderSection({ draft })

    fireEvent.click(screen.getByText(en.save))
    fireEvent.click(screen.getByText(en.cancel))

    expect(actions.save).toHaveBeenCalledTimes(1)
    expect(actions.close).toHaveBeenCalledTimes(1)
  })

  it('reports a save in flight and blocks a second click', () => {
    const actions = renderSection({ draft: { ...draft, saving: true } })

    fireEvent.click(screen.getByText(en.saving))

    expect(actions.save).not.toHaveBeenCalled()
  })

  it('shows a shipped composition read-only, with no way to save it', () => {
    renderSection({ draft: { ...draft, id: 'standard', source: 'standard', writable: false } })

    expect(screen.getByRole('textbox')).toHaveProperty('readOnly', true)
    expect(screen.getByText(en.readOnlyNotice)).toBeTruthy()
    expect(screen.queryByText(en.save)).toBeNull()
    expect(screen.getByText(en.close)).toBeTruthy()
  })

  it('names a new preset and says what it was copied from', () => {
    const actions = renderSection({
      draft: { ...draft, id: '', source: 'standard', creating: true },
    })

    expect(screen.getByText(`${en.copyOf} standard`)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(en.presetNamePlaceholder), { target: { value: 'my-agent' } })

    expect(actions.setId).toHaveBeenCalledWith('my-agent')
  })

  it('blocks a save the host would refuse, and says why', () => {
    const actions = renderSection({
      draft: { ...draft, id: 'Upper Case', source: 'standard', creating: true },
    })

    expect(screen.getByRole('alert').textContent).toBe(en.idInvalid)
    fireEvent.click(screen.getByText(en.save))

    // Disabled rather than round-tripping: the id is a directory name and the
    // rule is the host's own.
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('shows the host\'s refusal instead of the local blocker', () => {
    renderSection({ draft: { ...draft, error: 'composition is not an entry list' } })

    expect(screen.getByRole('alert').textContent).toBe('composition is not an entry list')
  })
})

describe('deleting a preset', () => {
  it('asks before deleting', () => {
    const actions = renderSection()

    fireEvent.click(within(rowFor('mine')).getByText(en.delete))

    expect(actions.confirmDelete).toHaveBeenCalledWith('mine')
  })

  it('confirms and dismisses through the controller', () => {
    const actions = renderSection({ pendingDelete: 'mine' })

    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByText(en.deleteConfirm))
    fireEvent.click(within(dialog).getByText(en.cancel))

    expect(actions.remove).toHaveBeenCalledTimes(1)
    expect(actions.confirmDelete).toHaveBeenLastCalledWith(null)
  })

  it('dismisses the confirmation on Escape', () => {
    const actions = renderSection({ pendingDelete: 'mine' })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(actions.confirmDelete).toHaveBeenCalledWith(null)
  })

  it('reports a delete in flight', () => {
    const actions = renderSection({ pendingDelete: 'mine', deleting: true })

    fireEvent.click(within(screen.getByRole('dialog')).getByText(en.deleting))

    expect(actions.remove).not.toHaveBeenCalled()
  })
})
