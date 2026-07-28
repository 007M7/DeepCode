// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import { DirectoryBrowseError } from '@deepseek-ai/dsh-client-runtime/client'
import { DirectoryBrowser } from '../src/client/DirectoryBrowser.tsx'

afterEach(cleanup)

const HOME = '/home/u'

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
        { name: 'Documents', path: `${HOME}/Documents`, hidden: false },
      ],
    },
    [`${HOME}/Documents`]: {
      path: `${HOME}/Documents`,
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'home', path: '/home', hidden: false },
        { name: 'u', path: HOME, hidden: false },
        { name: 'Documents', path: `${HOME}/Documents`, hidden: false },
      ],
      entries: [{ name: 'harness', path: `${HOME}/Documents/harness`, hidden: false }],
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
    t: (key: string) => key,
    ...overrides,
  }
  const view = render(<DirectoryBrowser {...props} />)
  return { view, props, listDirectory, createDirectory, onOpen, onClose }
}

describe('DirectoryBrowser', () => {
  it('opens at the Host home, hides hidden entries, and roots the crumbs at Home', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    expect(b.listDirectory).toHaveBeenCalledWith(undefined)
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
    expect(screen.queryByText('.config')).toBeNull()
    // Inside the home subtree the chain collapses to a localized Home crumb.
    expect(screen.getByRole('button', { name: 'browser.home' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '/' })).toBeNull()
  })

  it('enters a row on click and jumps back through a crumb', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('listitem'))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('harness') })
    expect(b.listDirectory).toHaveBeenLastCalledWith(`${HOME}/Documents`)
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('Documents') })
  })

  it('edits the path from the crumb bar: Enter navigates, Escape restores', async () => {
    mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText<HTMLInputElement>('browser.editPath')
    expect(input.value).toBe(HOME)
    fireEvent.change(input, { target: { value: `${HOME}/Documents` } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('harness') })
    // Escape leaves an opened edit without navigating.
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    fireEvent.keyDown(screen.getByLabelText('browser.editPath'), { key: 'Escape' })
    expect(screen.queryByLabelText('browser.editPath', { selector: 'input' })).toBeNull()
    expect(screen.getByRole('listitem').textContent).toBe('harness')
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

  it('creates a folder inline and refreshes the level; failures land as alerts', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const input = screen.getByLabelText('browser.newFolder')
    fireEvent.change(input, { target: { value: 'fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(b.createDirectory).toHaveBeenCalledWith(HOME, 'fresh') })
    // The level reloads after creation (initial + post-create).
    await waitFor(() => { expect(b.listDirectory).toHaveBeenLastCalledWith(HOME) })

    b.createDirectory.mockRejectedValueOnce(
      new DirectoryBrowseError({ code: 'directory-exists', message: 'taken already', details: { path: `${HOME}/x` } }))
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const retry = screen.getByLabelText('browser.newFolder')
    fireEvent.change(retry, { target: { value: 'x' } })
    fireEvent.keyDown(retry, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('taken already') })
  })

  it('confirms the listed directory through Open, closes through Cancel, and freezes while busy', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.open' }))
    expect(b.onOpen).toHaveBeenCalledWith(HOME)
    fireEvent.click(screen.getByRole('button', { name: 'browser.cancel' }))
    expect(b.onClose).toHaveBeenCalled()

    const busy = mount({ busy: true })
    await waitFor(() => { expect(busy.listDirectory).toHaveBeenCalled() })
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'browser.open' }).at(-1)!.disabled).toBe(true)
  })

  it('renders the full ancestry when the listing sits outside the home subtree', async () => {
    const outside: DirectoryListing = {
      path: '/srv/data',
      home: HOME,
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'srv', path: '/srv', hidden: false },
        { name: 'data', path: '/srv/data', hidden: false },
      ],
      entries: [],
    }
    mount({ listDirectory: vi.fn(async () => outside) })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'data' })).toBeTruthy() })
    expect(screen.getByRole('button', { name: '/' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'browser.home' })).toBeNull()
  })

  it('folds non-typed failures into readable text (Error message, String otherwise)', async () => {
    const b = mount({ listDirectory: vi.fn(async () => { throw new Error('socket down') }) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('socket down') })
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    const raw = mount({ listDirectory: vi.fn(async () => { throw 'raw failure' }) })
    await waitFor(() => { expect(screen.getAllByRole('alert').at(-1)!.textContent).toBe('raw failure') })
    expect(raw.onOpen).not.toHaveBeenCalled()
  })

  it('cancels the inline folder row with Escape and ignores a blank name', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.newFolder' }))
    const input = screen.getByLabelText('browser.newFolder')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(b.createDirectory).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('browser.newFolder')).toBeNull()
  })

  it('ignores a blank path draft on Enter', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'browser.editPath' }))
    const input = screen.getByLabelText('browser.editPath')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Only the initial home listing ran; the blank draft navigated nowhere.
    expect(b.listDirectory).toHaveBeenCalledTimes(1)
  })

  it('drops a stale listing that resolves after a newer navigation', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    // The next navigation (into Documents) hangs; a Home-crumb jump supersedes it.
    let resolveSlow!: (value: DirectoryListing) => void
    const slow = new Promise<DirectoryListing>((settle) => { resolveSlow = settle })
    b.listDirectory.mockReturnValueOnce(slow)
    fireEvent.click(screen.getByRole('listitem'))
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenCalledTimes(3) })
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('Documents') })
    resolveSlow(listingFor(`${HOME}/Documents`))
    await new Promise(settle => setTimeout(settle, 0))
    // The stale Documents listing did not clobber the newer Home level.
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
  })

  it('drops a stale failure that rejects after a newer navigation', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    let rejectSlow!: (reason: unknown) => void
    const slow = new Promise<DirectoryListing>((_settle, fail) => { rejectSlow = fail })
    b.listDirectory.mockReturnValueOnce(slow)
    fireEvent.click(screen.getByRole('listitem'))
    fireEvent.click(screen.getByRole('button', { name: 'browser.home' }))
    await waitFor(() => { expect(b.listDirectory).toHaveBeenCalledTimes(3) })
    rejectSlow(new Error('too late to matter'))
    await new Promise(settle => setTimeout(settle, 0))
    // The superseded failure surfaces no alert over the newer level.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('listitem').textContent).toBe('Documents')
  })

  it('starts back at home on reopen', async () => {
    const b = mount()
    await waitFor(() => { expect(screen.getByRole('listitem')).toBeTruthy() })
    fireEvent.click(screen.getByRole('listitem'))
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('harness') })
    b.view.rerender(<DirectoryBrowser {...b.props} open={false} />)
    b.view.rerender(<DirectoryBrowser {...b.props} open />)
    await waitFor(() => { expect(screen.getByRole('listitem').textContent).toBe('Documents') })
    expect(b.listDirectory).toHaveBeenLastCalledWith(undefined)
  })
})
