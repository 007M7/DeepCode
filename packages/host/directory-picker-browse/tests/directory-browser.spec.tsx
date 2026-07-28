// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import { DirectoryBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import { DirectoryBrowser } from '../src/client/DirectoryBrowser.tsx'

afterEach(cleanup)

const HOME = '/home/u'
const DOCS = `${HOME}/Documents`
const HARNESS = `${DOCS}/harness`

/** Listing fake over a tiny fixed tree; unknown paths reject like the Host. */
function listingFor(path?: string): DirectoryListing {
  const target = path ?? HOME
  const tree: Record<string, DirectoryListing> = {
    [HOME]: {
      path: HOME,
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'u', path: HOME, hidden: false },
      ],
      entries: [
        { name: '.config', path: `${HOME}/.config`, hidden: true },
        { name: 'Documents', path: DOCS, hidden: false },
      ],
      truncated: false,
    },
    [DOCS]: {
      path: DOCS,
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'u', path: HOME, hidden: false },
        { name: 'Documents', path: DOCS, hidden: false },
      ],
      entries: [{ name: 'harness', path: HARNESS, hidden: false }],
      truncated: false,
    },
    [HARNESS]: {
      path: HARNESS,
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'u', path: HOME, hidden: false },
        { name: 'Documents', path: DOCS, hidden: false },
        { name: 'harness', path: HARNESS, hidden: false },
      ],
      entries: [],
      truncated: false,
    },
  }
  const found = tree[target]
  if (found === undefined) {
    throw new DirectoryBrowseError({ code: 'directory-unreadable', message: `cannot list ${target}`, details: { path: target } })
  }
  return found
}

function mount(overrides: Partial<Parameters<typeof DirectoryBrowser>[0]> = {}) {
  const listDirectory = vi.fn(async (path?: string) => listingFor(path))
  const createDirectory = vi.fn(async (path: string, name: string) => `${path}/${name}`)
  const onOpen = vi.fn()
  const onClose = vi.fn()
  const props = {
    open: true,
    listDirectory,
    createDirectory,
    onOpen,
    onClose,
    busy: false,
    t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key}:${String(params.name)}`),
    ...overrides,
  }
  const view = render(<DirectoryBrowser {...props} />)
  return { view, props, listDirectory, createDirectory, onOpen, onClose }
}

/** The rendered level columns, left-to-right. */
function columns(): HTMLElement[] {
  return screen.getAllByRole('list')
}

/** The actionable button inside a listitem seat (rows keep native button semantics). */
function rowButton(item: HTMLElement): HTMLButtonElement {
  return within(item).getByRole<HTMLButtonElement>('button')
}

describe('DirectoryBrowser', () => {
  it('opens at the Host home as one wide column, hides hidden entries, and roots the crumbs at Home', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    expect(b.listDirectory).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    expect(columns()).toHaveLength(1)
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    expect(screen.queryByText('.config')).toBeNull()
    expect(screen.getByRole('button', { name: 'browser.home' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '/' })).toBeNull()
  })

  it('selects a row into the two-pane view: children preview right, crumbs follow the selection', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    const [level, preview] = columns()
    const selectedRow = within(level!).getByRole('listitem')
    expect(selectedRow.textContent).toBe('Documents')
    expect(rowButton(selectedRow).getAttribute('aria-current')).toBe('true')
    expect(within(preview!).getByRole('listitem').textContent).toBe('harness')
    expect(b.listDirectory).toHaveBeenLastCalledWith(DOCS, expect.any(AbortSignal))
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: 'Documents' })).toBeTruthy()
  })

  it('advances one level when a right-column row is picked', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(rowButton(within(columns()[1]!).getByRole('listitem')))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'harness' })).toBeTruthy() })
    const [level] = columns()
    const selectedRow = within(level!).getByRole('listitem')
    expect(selectedRow.textContent).toBe('harness')
    expect(rowButton(selectedRow).getAttribute('aria-current')).toBe('true')
  })

  it('aborts a superseded listing on the wire, and the in-flight one on close', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const gates: (() => void)[] = []
    const listDirectory = vi.fn((path?: string, signal?: AbortSignal) => {
      signals.push(signal)
      if (signals.length === 1) return Promise.resolve(listingFor(path))
      // Later listings hang until released: supersession must abort them
      // on the wire, not merely discard their eventual results.
      return new Promise<DirectoryListing>((resolve) => { gates.push(() => { resolve(listingFor(path)) }) })
    })
    const b = mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    expect(signals).toHaveLength(2)
    // A crumb jump supersedes the hanging preview: its request aborts.
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    expect(signals[1]?.aborted).toBe(true)
    expect(signals[2]?.aborted).toBe(false)
    // Closing the dialog aborts the still-pending navigation too.
    b.view.rerender(<DirectoryBrowser {...b.props} listDirectory={listDirectory} open={false} />)
    expect(signals[2]?.aborted).toBe(true)
  })

  it('jumps back through a crumb into a fresh single-column level', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(columns()).toHaveLength(1) })
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    expect(rowButton(screen.getByRole('listitem')).getAttribute('aria-current')).toBeNull()
  })

  it('opens the selection, else the listed level; Cancel closes; busy freezes Open', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.open' }))
    expect(b.onOpen).toHaveBeenCalledWith(HOME)
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.open' }))
    expect(b.onOpen).toHaveBeenLastCalledWith(DOCS)
    fireEvent.click(screen.getByRole('button', { name: 'browser.cancel' }))
    expect(b.onClose).toHaveBeenCalled()

    const busy = mount({ busy: true })
    await waitFor(() => { expect(busy.listDirectory).toHaveBeenCalled() })
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'browser.open' }).at(-1)!.disabled).toBe(true)
  })

  it('edits the path from the crumb bar: Enter navigates, Escape restores, blank is ignored', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    expect(input.value).toBe(HOME)
    fireEvent.change(input, { target: { value: DOCS } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('harness') })
    expect(columns()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const again = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(again, { target: { value: '   ' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    expect(b.listDirectory).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(again, { key: 'Escape' })
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
  })

  it('restarts the home listing when Escape cancels an edit opened before any level listed', async () => {
    // The initial home listing hangs; Edit Path supersedes it while parent
    // is still null, and Escape must not strand a blank picker.
    let settled = false
    const gate = new Promise<never>(() => {})
    const listDirectory = vi.fn(async (path?: string) => {
      if (!settled) { settled = true; return gate }
      return listingFor(path)
    })
    mount({ listDirectory })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    expect(input.value).toBe('')
    fireEvent.keyDown(input, { key: 'Escape' })
    // Cancellation relaunched the home listing instead of leaving neither
    // rows nor status behind.
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('Documents') })
    expect(listDirectory).toHaveBeenCalledTimes(2)
    expect(listDirectory).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
  })

  it('passes the entered path to the Host untrimmed (trim only gates blank drafts)', async () => {
    const listDirectory = vi.fn(async (path?: string) => listingFor(path))
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS} ` } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // A trailing space may name a real directory; trimming would list its sibling.
    await waitFor(() => { expect(listDirectory).toHaveBeenLastCalledWith(`${DOCS} `, expect.any(AbortSignal)) })
  })

  it('surfaces an unreadable target as an alert and keeps the edit open for correction', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    fireEvent.change(input, { target: { value: '/nope' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('cannot list /nope') })
    expect(screen.getByLabelText('browser.editPath')).toBeTruthy()
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
  })

  it('folds non-typed failures into readable text (Error message, String otherwise)', async () => {
    const b = mount({ listDirectory: vi.fn(async () => { throw new Error('socket down') }) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('socket down') })
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    const raw = mount({ listDirectory: vi.fn(async () => { throw 'raw failure' }) })
    await waitFor(() => { expect(screen.getAllByRole('alert').at(-1)!.textContent).toBe('raw failure') })
    expect(raw.onOpen).not.toHaveBeenCalled()
  })

  it('renders the full ancestry when the level sits outside the home subtree', async () => {
    const outside: DirectoryListing = {
      path: '/srv/data',
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'srv', path: '/srv', hidden: false },
        { name: 'data', path: '/srv/data', hidden: false },
      ],
      entries: [],
      truncated: false,
    }
    mount({ listDirectory: vi.fn(async () => outside) })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'data' })).toBeTruthy() })
    expect(screen.getByRole('button', { name: '/' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'browser.home' })).toBeNull()
  })

  it('scopes Escape to the topmost dialog: the nested create closes first, the browser only after', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    expect(screen.getByLabelText('browser.folderName')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    // The nested dialog consumed Escape; the browser stays up.
    expect(screen.queryByLabelText('browser.folderName')).toBeNull()
    expect(b.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.onClose).toHaveBeenCalledOnce()
  })

  it('keeps both dialogs open when Escape lands during an in-flight creation', async () => {
    let resolve!: (path: string) => void
    const createDirectory = vi.fn(() => new Promise<string>((settle) => { resolve = settle }))
    const b = mount({ createDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'pending' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    // The in-flight fence holds the nested dialog, and the browser must not
    // fall out from under it either.
    expect(screen.getByLabelText('browser.folderName')).toBeTruthy()
    expect(b.onClose).not.toHaveBeenCalled()
    await act(async () => { resolve(`${HOME}/pending`) })
  })

  it('keeps New folder disabled while the post-create relist is still loading', async () => {
    const pending: (() => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    // Every listing after the create hangs until drained: the button must not
    // offer a second create against a target the pending relist/select
    // sequence is about to change.
    const fresh: DirectoryListing = {
      path: `${HOME}/fresh`, home: HOME,
      crumbs: [...listingFor(HOME).crumbs, { name: 'fresh', path: `${HOME}/fresh`, hidden: false }],
      entries: [],
      truncated: false,
    }
    b.listDirectory.mockImplementation((path?: string) =>
      new Promise<DirectoryListing>((settle) => {
        pending.push(() => { settle(path === `${HOME}/fresh` ? fresh : listingFor(path)) })
      }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.newFolder' }).disabled).toBe(true)
    // Drain the relist and the follow-up selection listing; only then does
    // the affordance return.
    await act(async () => { for (const settle of pending.splice(0)) settle() })
    await act(async () => { for (const settle of pending.splice(0)) settle() })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.newFolder' }).disabled).toBe(false)
  })

  it('keeps path entry available when the home listing fails', async () => {
    const listDirectory = vi.fn(async (): Promise<DirectoryListing> => {
      throw new DirectoryBrowseError({ code: 'directory-unreadable', message: 'home unreadable', details: { path: HOME } })
    })
    mount({ listDirectory })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('home unreadable') })
    // With no listed level, typing an absolute path is the one way forward.
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    fireEvent.change(input, { target: { value: DOCS } })
    listDirectory.mockImplementation(async (path?: string) => listingFor(path))
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByText('harness')).toBeTruthy() })
  })

  it('disables Open and New folder while a path draft is uncommitted', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    // targetPath still names the previous listing; committing actions must
    // not act on it while a different path is displayed in the header.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.newFolder' }).disabled).toBe(true)
    fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Escape' })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' }).disabled).toBe(false)
  })

  it('ignores Enter while an IME composition is active in either input', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    // Path editor: a composing Enter confirms the candidate, not the path.
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const pathInput = screen.getByLabelText('browser.editPath')
    fireEvent.change(pathInput, { target: { value: DOCS } })
    const listCalls = b.listDirectory.mock.calls.length
    fireEvent.compositionStart(pathInput)
    fireEvent.keyDown(pathInput, { key: 'Enter' })
    expect(b.listDirectory.mock.calls.length).toBe(listCalls)
    fireEvent.compositionEnd(pathInput)
    fireEvent.keyDown(pathInput, { key: 'Enter' })
    await waitFor(() => { expect(b.listDirectory).toHaveBeenLastCalledWith(DOCS, expect.any(AbortSignal)) })
    // Create dialog: same guard.
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const nameInput = screen.getByLabelText('browser.folderName')
    fireEvent.change(nameInput, { target: { value: '新建' } })
    fireEvent.compositionStart(nameInput)
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(b.createDirectory).not.toHaveBeenCalled()
    fireEvent.compositionEnd(nameInput)
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    await waitFor(() => { expect(b.createDirectory).toHaveBeenCalledWith(DOCS, '新建') })
  })

  it('surfaces a two-pane navigation failure as an alert below the columns', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    b.listDirectory.mockImplementation(async () => {
      throw new DirectoryBrowseError({ code: 'directory-unreadable', message: 'denied', details: { path: HOME } })
    })
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    // Both panes survive the failure; the alert renders in the flow, not as a
    // third column competing for the fixed widths.
    expect(columns()).toHaveLength(2)
  })

  it('keeps the editor open when a pending listing settles right after Edit Path was clicked', async () => {
    const pending: ((listing: DirectoryListing) => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    // A crumb navigation hangs; the user opens the editor before it settles.
    b.listDirectory.mockImplementation(() =>
      new Promise<DirectoryListing>((settle) => { pending.push(settle) }))
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'browser.home' }))
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    expect(screen.getByLabelText('browser.editPath')).toBeTruthy()
    await act(async () => { pending.shift()!(listingFor(HOME)) })
    // The superseded settlement must not close the editor underneath the user.
    expect(screen.getByLabelText('browser.editPath')).toBeTruthy()
  })

  it('ignores a pending navigation that settles after Escape cancelled the editor', async () => {
    const pending: ((listing: DirectoryListing) => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    b.listDirectory.mockImplementation(() =>
      new Promise<DirectoryListing>((settle) => { pending.push(settle) }))
    fireEvent.change(input, { target: { value: DOCS } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape' })
    // The cancelled navigation settling late must not jump the view to DOCS.
    await act(async () => { pending.shift()!(listingFor(DOCS)) })
    expect(screen.queryByText('harness')).toBeNull()
    expect(screen.getByText('Documents')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps a newer path edit when an older slow navigation settles', async () => {
    const pending: ((listing: DirectoryListing) => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    b.listDirectory.mockImplementation(() =>
      new Promise<DirectoryListing>((settle) => { pending.push(settle) }))
    fireEvent.change(input, { target: { value: DOCS } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // The user keeps typing while the lookup hangs; the older completion must
    // neither clear this newer draft nor swap the view to the older path.
    fireEvent.change(input, { target: { value: `${DOCS}/har` } })
    await act(async () => { pending.shift()!(listingFor(DOCS)) })
    expect(screen.getByLabelText<HTMLInputElement>('browser.editPath').value).toBe(`${DOCS}/har`)
    expect(screen.queryByText('harness')).toBeNull()
  })

  it('keeps an intact selection preview when a path edit is cancelled', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Escape' })
    // Nothing was superseded: the two-pane view survives the cancel.
    expect(columns()).toHaveLength(2)
  })

  it('falls back to the single-pane level when a path edit superseded the preview and was cancelled', async () => {
    const pending: ((listing: DirectoryListing) => void)[] = []
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    // Selection starts a preview that never lands (superseded below).
    b.listDirectory.mockImplementation(() =>
      new Promise<DirectoryListing>((settle) => { pending.push(settle) }))
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    fireEvent.change(input, { target: { value: `${DOCS}/x` } })
    fireEvent.keyDown(input, { key: 'Escape' })
    // No half-empty two-pane residue: back to the single wide level.
    expect(columns()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'browser.editPath' })).toBeTruthy()
  })

  it('drops a creation that settles after the browser unmounted', async () => {
    let settleCreate!: (path: string) => void
    const createDirectory = vi.fn(() => new Promise<string>((settle) => { settleCreate = settle }))
    const b = mount({ createDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    const listCalls = b.listDirectory.mock.calls.length
    b.view.unmount()
    // The dead flow must not issue the post-create relist.
    await act(async () => { settleCreate(`${HOME}/slow`) })
    expect(b.listDirectory.mock.calls.length).toBe(listCalls)
  })

  it('clears the selection when its preview listing fails', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    b.listDirectory.mockImplementation(async () => {
      throw new DirectoryBrowseError({ code: 'directory-unreadable', message: 'denied', details: { path: DOCS } })
    })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    // The breadcrumb names the level, so the level must be the committing
    // target: no half-selected two-pane state survives the failure.
    expect(columns()).toHaveLength(1)
    expect(rowButton(screen.getByRole('listitem')).getAttribute('aria-current')).toBeNull()
  })

  it('ignores dismissal while adoption is busy', async () => {
    const b = mount({ busy: true })
    await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.onClose).not.toHaveBeenCalled()
  })

  it('makes every parent control inert while the nested create dialog is open', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    // Modal traps no focus: Shift-Tab/AT reach the parent, so closing,
    // adopting, and retargeting must all disable underneath the child. Both
    // dialogs carry a cancel: the parent's disables, the child's stays live.
    const cancels = screen.getAllByRole<HTMLButtonElement>('button', { name: 'browser.cancel' })
    expect(cancels.map(button => button.disabled).sort()).toEqual([false, true])
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.editPath' }).disabled).toBe(true)
    for (const row of screen.getAllByRole('listitem')) {
      expect(rowButton(row).disabled).toBe(true)
    }
  })

  it('drops a creation failure that lands after the flow closed and reopened', async () => {
    let rejectCreate!: (reason: unknown) => void
    const createDirectory = vi.fn(() => new Promise<string>((_settle, reject) => { rejectCreate = reject }))
    const b = mount({ createDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    b.view.rerender(<DirectoryBrowser {...b.props} open />)
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    // The stale failure must not surface an alert inside the fresh flow.
    await act(async () => { rejectCreate(new Error('too late')) })
    expect(screen.queryByText('too late')).toBeNull()
  })

  it('drops a creation that settles after the flow closed and reopened', async () => {
    let settleCreate!: (path: string) => void
    const createDirectory = vi.fn(() => new Promise<string>((settle) => { settleCreate = settle }))
    const b = mount({ createDirectory })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    fireEvent.change(screen.getByLabelText('browser.folderName'), { target: { value: 'slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'browser.create' }))
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    b.view.rerender(<DirectoryBrowser {...b.props} open />)
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    const listCallsBefore = b.listDirectory.mock.calls.length
    // The stale settlement must not relist the old target or reopen the
    // nested dialog's state inside the fresh flow.
    await act(async () => { settleCreate(`${HOME}/slow`) })
    expect(b.listDirectory.mock.calls.length).toBe(listCallsBefore)
    expect(screen.queryByLabelText('browser.folderName')).toBeNull()
    expect(screen.getByText('Documents')).toBeTruthy()
  })

  it('passes the folder name to the Host untrimmed (trim only gates blank drafts)', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const input = screen.getByLabelText('browser.folderName')
    fireEvent.change(input, { target: { value: 'project ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // A trailing space may be the wanted spelling; trimming would create a sibling.
    await waitFor(() => { expect(b.createDirectory).toHaveBeenCalledWith(HOME, 'project ') })
  })

  it('creates a folder through the nested dialog and lands with it selected', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    // The nested dialog names the create target (the selected folder).
    expect(screen.getByText('browser.createIn:Documents')).toBeTruthy()
    // The created folder becomes listable (like the real backend after mkdir).
    b.listDirectory.mockImplementation(async (path?: string) => {
      if (path === `${DOCS}/fresh`) {
        return {
          path: `${DOCS}/fresh`, home: HOME,
          crumbs: [...listingFor(DOCS).crumbs, { name: 'fresh', path: `${DOCS}/fresh`, hidden: false }],
          entries: [],
          truncated: false,
        }
      }
      if (path === DOCS) {
        const docs = listingFor(DOCS)
        return { ...docs, entries: [...docs.entries, { name: 'fresh', path: `${DOCS}/fresh`, hidden: false }] }
      }
      return listingFor(path)
    })
    const input = screen.getByLabelText('browser.folderName')
    fireEvent.change(input, { target: { value: 'fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(b.createDirectory).toHaveBeenCalledWith(DOCS, 'fresh') })
    // The create target became the level and the new folder its selection.
    await waitFor(() => {
      expect(within(screen.getByRole('navigation')).getByRole('button', { name: 'Documents' })).toBeTruthy()
      const level = columns()[0]!
      const rows = within(level).getAllByRole('listitem')
      expect(rows.some(row => row.textContent === 'fresh' && rowButton(row).getAttribute('aria-current') === 'true')).toBe(true)
    })
  })

  it('keeps the nested dialog open on a creation failure and cancels cleanly', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    b.createDirectory.mockRejectedValueOnce(
      new DirectoryBrowseError({ code: 'directory-exists', message: 'taken already', details: { path: `${HOME}/x` } }))
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    expect(screen.getByText('browser.createIn:browser.home')).toBeTruthy()
    const input = screen.getByLabelText('browser.folderName')
    // A blank name never submits.
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(b.createDirectory).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('taken already') })
    fireEvent.keyDown(screen.getByLabelText('browser.folderName'), { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })

    // The nested Cancel button and the nested mask both close only the child dialog.
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const nested = screen.getByRole('dialog', { name: 'browser.newFolder' })
    fireEvent.click(within(nested).getByRole('button', { name: 'browser.cancel' }))
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const masks = document.querySelectorAll('[aria-hidden="true"]')
    fireEvent.click(masks[masks.length - 1]!)
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })
    expect(screen.getByRole('dialog', { name: 'browser.title' })).toBeTruthy()
  })

  it('surfaces a post-create relist failure on the browser surface', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    // Creation succeeds, but relisting the target fails afterwards.
    b.listDirectory.mockRejectedValueOnce(new Error('level vanished'))
    const input = screen.getByLabelText('browser.folderName')
    fireEvent.change(input, { target: { value: 'fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('level vanished') })
  })

  it('drops a stale child listing that resolves after a crumb jump', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    let resolveSlow!: (value: DirectoryListing) => void
    const slow = new Promise<DirectoryListing>((settle) => { resolveSlow = settle })
    b.listDirectory.mockReturnValueOnce(slow)
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenCalledTimes(3) })
    await waitFor(() => { expect(columns()).toHaveLength(1) })
    resolveSlow(listingFor(DOCS))
    await new Promise(settle => setTimeout(settle, 0))
    // The superseded selection preview did not reopen the second pane.
    expect(columns()).toHaveLength(1)
  })

  it('drops a stale failure that rejects after a newer navigation', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    let rejectSlow!: (reason: unknown) => void
    const slow = new Promise<DirectoryListing>((_settle, fail) => { rejectSlow = fail })
    b.listDirectory.mockReturnValueOnce(slow)
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenCalledTimes(3) })
    rejectSlow(new Error('too late to matter'))
    await new Promise(settle => setTimeout(settle, 0))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
  })

  it('drops a stale navigation failure that rejects after a newer jump', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    let rejectSlow!: (reason: unknown) => void
    const slow = new Promise<DirectoryListing>((_settle, fail) => { rejectSlow = fail })
    b.listDirectory.mockReturnValueOnce(slow)
    // A slow crumb jump superseded by a second jump.
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Documents' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenCalledTimes(4) })
    rejectSlow(new Error('late nav failure'))
    await new Promise(settle => setTimeout(settle, 0))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a stale navigation listing that resolves after a newer jump', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    let resolveSlow!: (value: DirectoryListing) => void
    const slow = new Promise<DirectoryListing>((settle) => { resolveSlow = settle })
    b.listDirectory.mockReturnValueOnce(slow)
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Documents' }))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('harness') })
    resolveSlow(listingFor(undefined))
    await new Promise(settle => setTimeout(settle, 0))
    // The stale home listing did not replace the newer Documents level.
    expect(screen.getByRole('listitem').textContent).toBe('harness')
  })

  it('names the create target by its path when the level reports no crumbs', async () => {
    const bare: DirectoryListing = { path: '/srv/data', home: HOME, crumbs: [], entries: [], truncated: false }
    mount({ listDirectory: vi.fn(async () => bare) })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'browser.newFolder' })).toBeTruthy() })
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'browser.newFolder' }).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    expect(screen.getByText('browser.createIn:/srv/data')).toBeTruthy()
  })

  it('refuses to close the nested dialog while the creation is in flight', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    let settleCreate!: (path: string) => void
    b.createDirectory.mockReturnValueOnce(new Promise<string>((settle) => { settleCreate = settle }))
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const input = screen.getByLabelText('browser.folderName')
    fireEvent.change(input, { target: { value: 'slow' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Escape and the mask are both inert while creating.
    fireEvent.keyDown(screen.getByLabelText('browser.folderName'), { key: 'Escape' })
    const masks = document.querySelectorAll('[aria-hidden="true"]')
    fireEvent.click(masks[masks.length - 1]!)
    expect(screen.getByLabelText('browser.folderName')).toBeTruthy()
    settleCreate(`${HOME}/slow`)
    await waitFor(() => { expect(screen.queryByLabelText('browser.folderName')).toBeNull() })
  })

  it('says a level is incomplete when the backend cut it at its bound', async () => {
    const cut = { ...listingFor(HOME), truncated: true }
    mount({ listDirectory: vi.fn(async () => cut) })
    await screen.findByText('browser.truncated')
  })

  it('flags a truncated child preview under a complete level', async () => {
    mount({
      listDirectory: vi.fn(async (path?: string) =>
        (path === DOCS ? { ...listingFor(DOCS), truncated: true } : listingFor(path))),
    })
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    expect(screen.queryByText('browser.truncated')).toBeNull()
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    await screen.findByText('browser.truncated')
  })

  it('pins the child pane into view when its preview lands (narrow viewports scroll the miller row)', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    const row = document.querySelector('[class*=millerRow]') as HTMLElement
    // jsdom does no layout: stub the overflow width the effect pins against.
    Object.defineProperty(row, 'scrollWidth', { value: 640, configurable: true })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    await waitFor(() => { expect(row.scrollLeft).toBe(640) })
  })

  it('starts back at home on reopen', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(rowButton(screen.getByRole('listitem')))
    await waitFor(() => { expect(columns()).toHaveLength(2) })
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    b.view.rerender(<DirectoryBrowser {...b.props} open />)
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('Documents') })
    expect(columns()).toHaveLength(1)
    expect(b.listDirectory).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
  })
})
