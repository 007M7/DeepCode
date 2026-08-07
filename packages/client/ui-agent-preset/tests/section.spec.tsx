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
    { id: 'standard', trust: 'system', isDefault: true, name: '标准模式', description: '完整的编码 agent。' },
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
    setName: vi.fn(),
    setDescription: vi.fn(),
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

/** Locate a card by the id it prints, not by its display name. */
function rowFor(id: string): HTMLElement {
  const key = screen.getAllByText(id).find(node => node.tagName === 'CODE')
  const row = key?.closest('li') ?? null
  /* v8 ignore next -- every rendered card prints its id */
  if (row === null) throw new Error(`no card for ${id}`)
  return row
}

describe('the preset list', () => {
  it('reads the roster once when it first renders', async () => {
    const actions = renderSection()

    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
  })

  it('shows the published name and description, falling back to the id', () => {
    renderSection()

    // The name is what a picker reads; the id stays visible as the key the
    // composition and the session header actually carry.
    expect(screen.getByText('标准模式')).toBeTruthy()
    expect(screen.getByText('完整的编码 agent。')).toBeTruthy()
    const mine = rowFor('mine')
    expect(within(mine).getAllByText('mine').length).toBeGreaterThan(0)
    expect(within(mine).getByText(en.noDescription)).toBeTruthy()
  })

  it('marks trust and the one in use, and offers no "set default" on it', () => {
    renderSection()

    const standard = rowFor('standard')
    expect(within(standard).getByText(en.builtIn)).toBeTruthy()
    expect(within(standard).getByText(en.inUse)).toBeTruthy()
    expect(within(standard).queryByText(en.setDefault)).toBeNull()
    expect(within(rowFor('mine')).getByText(en.userTrust)).toBeTruthy()
  })

  it('separates built-in presets from custom ones', () => {
    renderSection()

    // Two different things: one set ships with the deployment and is
    // read-only, the other is the user's own.
    expect(screen.getByRole('heading', { name: en.builtInGroup })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.customGroup })).toBeTruthy()
    expect(within(rowFor('standard')).getByText(en.builtIn)).toBeTruthy()
    expect(within(rowFor('mine')).getByText(en.userTrust)).toBeTruthy()
  })

  it('shows no group heading for a set nobody has', () => {
    renderSection({ rows: [{ id: 'standard', trust: 'system', isDefault: true }] })

    expect(screen.queryByRole('heading', { name: en.customGroup })).toBeNull()
  })

  it('picks a preset by clicking its card, and the one in use is inert', () => {
    const actions = renderSection()

    const inUse = within(rowFor('standard')).getByRole('button', { name: `${en.inUse}: 标准模式` })
    expect(inUse).toHaveProperty('disabled', true)
    fireEvent.click(inUse)

    // Clicking the card IS the choice; the preset already in use cannot be
    // re-picked, so the click reaches nothing.
    expect(actions.makeDefault).not.toHaveBeenCalled()
  })

  it('offers Edit for a local preset and View for a shipped one', () => {
    renderSection()

    expect(within(rowFor('mine')).getByRole('button', { name: en.edit })).toBeTruthy()
    // A shipped composition is readable but not editable, and the label is
    // what says so before the editor opens.
    expect(within(rowFor('standard')).getByRole('button', { name: en.view })).toBeTruthy()
  })

  it('offers Delete only for a locally authored preset', () => {
    renderSection()

    expect(within(rowFor('mine')).getByRole('button', { name: en.delete })).toBeTruthy()
    expect(within(rowFor('standard')).queryByRole('button', { name: en.delete })).toBeNull()
  })

  it('hides duplication and disables creation when nothing is writable', () => {
    renderSection({ authorable: false })

    expect(screen.queryByRole('button', { name: en.duplicate })).toBeNull()
    expect(screen.getByText(`+ ${en.newPreset}`)).toHaveProperty('disabled', true)
  })

  it('routes the row actions to the controller', () => {
    const actions = renderSection()

    // The card body is the control that picks a preset.
    fireEvent.click(within(rowFor('mine')).getByRole('button', { name: `${en.setDefault}: mine` }))
    fireEvent.click(within(rowFor('mine')).getByRole('button', { name: en.edit }))
    fireEvent.click(within(rowFor('mine')).getByRole('button', { name: en.duplicate }))
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
    writable: true, name: '我的预设', description: '', saving: false, error: null,
  }

  it('opens a blank draft without naming a preset it came from', () => {
    const { source: _copied, ...blank } = draft
    renderSection({ draft: { ...blank, id: '', creating: true } })

    // "New preset" starts empty — copying is what the per-row Duplicate does,
    // so a blank draft has no source to name and shows no copied-from hint.
    expect(screen.getByText(en.newPreset)).toBeTruthy()
    expect(screen.queryByText(new RegExp(en.copyOf))).toBeNull()
  })

  it('replaces the list while editing, and returns to it', () => {
    const actions = renderSection({ draft })

    // The form is tall and a card column is ~268px: squeezing it into one is
    // unusable, and hanging it off the end orphans it from the card it edits.
    expect(screen.queryByRole('heading', { name: en.builtInGroup })).toBeNull()
    const editor = screen.getByLabelText(en.composition)
    expect(editor).toHaveProperty('value', '- id: tool-read\n')
    fireEvent.change(editor, { target: { value: '- id: tool-edit\n' } })
    fireEvent.click(screen.getByRole('button', { name: `← ${en.backToList}` }))

    expect(actions.setContent).toHaveBeenCalledWith('- id: tool-edit\n')
    expect(actions.close).toHaveBeenCalledTimes(1)
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

    expect(screen.getByLabelText(en.composition)).toHaveProperty('readOnly', true)
    expect(screen.getByText(en.readOnlyNotice)).toBeTruthy()
    expect(screen.queryByText(en.save)).toBeNull()
    // Nothing to commit or abandon, and the back link above already leaves —
    // a lone Close button would be a second way out of the same screen.
    expect(screen.queryByText(en.cancel)).toBeNull()
    expect(screen.getByRole('button', { name: `← ${en.backToList}` })).toBeTruthy()
  })

  it('titles the panel by what it is doing', () => {
    renderSection({ draft })
    expect(screen.getByText(`${en.edit} · 我的预设`)).toBeTruthy()
    cleanup()

    // An unnamed draft falls back to what it was copied from.
    renderSection({ draft: { ...draft, name: '' } })
    expect(screen.getByText(`${en.edit} · mine`)).toBeTruthy()
    cleanup()

    renderSection({ draft: { ...draft, writable: false } })
    expect(screen.getByText(`${en.view} · 我的预设`)).toBeTruthy()
  })

  it('names a new preset and says what it was copied from', () => {
    const actions = renderSection({
      draft: { ...draft, id: '', source: 'standard', creating: true },
    })

    expect(screen.getByText(`${en.copyOf} standard`)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(en.presetIdPlaceholder), { target: { value: 'my-agent' } })

    expect(actions.setId).toHaveBeenCalledWith('my-agent')
  })

  it('edits the display name and description through the controller', () => {
    const actions = renderSection({ draft })

    fireEvent.change(screen.getByLabelText(en.displayName), { target: { value: '我的模式' } })
    fireEvent.change(screen.getByLabelText(en.displayDescription), { target: { value: '只做检索。' } })

    expect(actions.setName).toHaveBeenCalledWith('我的模式')
    expect(actions.setDescription).toHaveBeenCalledWith('只做检索。')
  })

  it('offers no display fields on a read-only preset', () => {
    renderSection({ draft: { ...draft, writable: false } })

    // Nothing here can be saved, so an editable name would be a lie.
    expect(screen.queryByLabelText(en.displayName)).toBeNull()
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

    fireEvent.click(within(rowFor('mine')).getByRole('button', { name: en.delete }))

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
