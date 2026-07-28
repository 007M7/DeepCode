// @vitest-environment jsdom
/**
 * PopupSelectView interaction spec (design §10.2): the search input takes
 * focus on open and plain typing filters locally, ↑↓ move the filtered
 * highlight while ←→ stay native to the input, Enter selects single-flight,
 * Escape dismisses back through focusComposer, outside pointerdown dismisses
 * plainly, and the submitting/failed states render pending text and a
 * working retry button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SelectOption } from '../src/client/contract.ts'
import type { PopupSpec, TokenSegment } from '../src/client/popup.ts'
import { PopupSelectController } from '../src/client/popup.ts'
import { PopupSelectView } from '../src/client/PopupSelectView.tsx'

afterEach(cleanup)

const OPTIONS: SelectOption[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light', active: true },
  { id: 'sepia', label: 'Sepia', detail: 'warm' },
]

const SEGMENT: TokenSegment = { via: 'enter', token: '/theme' }

function spec(overrides: Partial<PopupSpec<string>> = {}): PopupSpec<string> {
  return {
    options: () => Promise.resolve(OPTIONS),
    onSelect: () => undefined,
    ...overrides,
  }
}

async function mountOpen(overrides: Partial<PopupSpec<string>> = {}, consumeResult = true) {
  const consume = vi.fn((_segment: TokenSegment) => consumeResult)
  const focusComposer = vi.fn()
  const popup = new PopupSelectController<string>({ consume, focusComposer })
  const view = render(<PopupSelectView popup={popup} />)
  await act(async () => {
    popup.open('theme', spec(overrides), 'ctx-A', SEGMENT)
    await Promise.resolve()
  })
  return { popup, view, consume, focusComposer, search: screen.getByRole('textbox', { name: 'Filter options' }) }
}

function rowLabels(): string[] {
  return screen.getAllByRole('option').map(o => o.querySelector('span')!.textContent)
}

describe('PopupSelectView', () => {
  it('renders null while closed, opens with focus in the search input', async () => {
    const popup = new PopupSelectController<string>({ consume: () => true, focusComposer: () => {} })
    const view = render(<PopupSelectView popup={popup} />)
    expect(view.container.childElementCount).toBe(0)
    await act(async () => {
      popup.open('theme', spec(), 'ctx-A', SEGMENT)
      await Promise.resolve()
    })
    const search = screen.getByRole('textbox', { name: 'Filter options' })
    expect(document.activeElement).toBe(search)
    expect(rowLabels()).toEqual(['Dark', 'Light', 'Sepia'])
  })

  it('typing filters rows locally and rebases the highlight', async () => {
    const options = vi.fn(() => Promise.resolve(OPTIONS))
    const { search } = await mountOpen({ options })
    act(() => { fireEvent.change(search, { target: { value: 'li' } }) })
    expect(rowLabels()).toEqual(['Light'])
    expect(screen.getByRole('option').getAttribute('aria-selected')).toBe('true')
    expect(options).toHaveBeenCalledTimes(1)
    act(() => { fireEvent.change(search, { target: { value: 'zzz' } }) })
    expect(screen.queryByRole('option')).toBeNull()
    expect(screen.queryByText('No options')).not.toBeNull()
  })

  it('ArrowUp/Down move the filtered highlight; ArrowLeft/Right are left to the native caret', async () => {
    const { search } = await mountOpen()
    act(() => { fireEvent.keyDown(search, { key: 'ArrowDown' }) })
    let options = screen.getAllByRole('option')
    expect(options[1]!.getAttribute('aria-selected')).toBe('true')
    act(() => { fireEvent.keyDown(search, { key: 'ArrowUp' }) })
    options = screen.getAllByRole('option')
    expect(options[0]!.getAttribute('aria-selected')).toBe('true')
    // fireEvent returns false when preventDefault was called: arrow left/right must NOT be intercepted.
    expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true)
    expect(fireEvent.keyDown(search, { key: 'ArrowRight' })).toBe(true)
  })

  it('Enter selects the highlighted row: onSelect, consume, close, focusComposer', async () => {
    const seen: Array<{ option: SelectOption; context: string }> = []
    const { view, search, consume, focusComposer } = await mountOpen({
      onSelect: (option, context) => { seen.push({ option, context }) },
    })
    act(() => { fireEvent.keyDown(search, { key: 'ArrowDown' }) })
    await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }) })
    expect(seen).toEqual([{ option: OPTIONS[1], context: 'ctx-A' }])
    expect(consume).toHaveBeenCalledExactlyOnceWith(SEGMENT)
    expect(focusComposer).toHaveBeenCalledTimes(1)
    expect(view.container.childElementCount).toBe(0)
  })

  it('click selects a row; mouseenter moves the highlight', async () => {
    const seen: SelectOption[] = []
    const { view } = await mountOpen({ onSelect: (option) => { seen.push(option) } })
    const options = screen.getAllByRole('option')
    act(() => { fireEvent.mouseEnter(options[2]!) })
    expect(screen.getAllByRole('option')[2]!.getAttribute('aria-selected')).toBe('true')
    await act(async () => { fireEvent.click(options[2]!) })
    expect(seen).toEqual([OPTIONS[2]])
    expect(view.container.childElementCount).toBe(0)
  })

  it('submitting shows pending, locks the search input, and further Enter/click no-op', async () => {
    let release!: () => void
    const onSelect = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const { search, consume } = await mountOpen({ onSelect })
    await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }) })
    expect(screen.queryByText('Applying…')).not.toBeNull()
    expect((search as HTMLInputElement).readOnly).toBe(true)
    await act(async () => {
      fireEvent.keyDown(search, { key: 'Enter' })
      fireEvent.click(screen.getAllByRole('option')[1]!)
    })
    expect(onSelect).toHaveBeenCalledTimes(1)
    await act(async () => {
      release()
      await Promise.resolve()
    })
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('a failed options load shows the error with a Retry button that reloads', async () => {
    let attempts = 0
    await mountOpen({
      options: () => {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('directory down')) : Promise.resolve(OPTIONS)
      },
    })
    expect(screen.getByRole('alert').textContent).toContain('directory down')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await Promise.resolve()
    })
    expect(attempts).toBe(2)
    expect(rowLabels()).toEqual(['Dark', 'Light', 'Sepia'])
  })

  it('an onSelect failure keeps the shell open with the error strip and no retry button (re-select is the retry)', async () => {
    const { search, consume } = await mountOpen({ onSelect: () => Promise.reject(new Error('host rejected')) })
    await act(async () => { fireEvent.keyDown(search, { key: 'Enter' }) })
    expect(screen.getByRole('alert').textContent).toContain('host rejected')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(consume).not.toHaveBeenCalled()
    expect(screen.getAllByRole('option').length).toBe(3)
  })

  it('Escape dismisses and restores composer focus', async () => {
    const { view, search, focusComposer } = await mountOpen()
    act(() => { fireEvent.keyDown(search, { key: 'Escape' }) })
    expect(view.container.childElementCount).toBe(0)
    expect(focusComposer).toHaveBeenCalledTimes(1)
  })

  it('an outside pointerdown dismisses without focusComposer; an inside one does not dismiss', async () => {
    const { view, focusComposer } = await mountOpen()
    act(() => { fireEvent.pointerDown(screen.getAllByRole('option')[0]!) })
    expect(view.container.childElementCount).not.toBe(0)
    act(() => { fireEvent.pointerDown(document.body) })
    expect(view.container.childElementCount).toBe(0)
    expect(focusComposer).not.toHaveBeenCalled()
  })
})
