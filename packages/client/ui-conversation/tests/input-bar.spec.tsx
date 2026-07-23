// @vitest-environment jsdom
// InputBar behavior: Enter-send semantics (IME guard, shift newline,
// ctrl/meta insert, repeat suppression), the running lock with stop-only
// action, unlock refocus, error strip copy, and the focus-keeping mousedown.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'

afterEach(cleanup)

function setup(over?: Partial<InputBarProps>) {
  const props: InputBarProps = {
    draft: 'hello', running: false, disabled: false, error: null,
    variant: 'composer',
    onDraftChange: vi.fn(), onSend: vi.fn(), onStop: vi.fn(),
    ...over,
  }
  const view = render(<InputBar {...props} />)
  const textarea = view.container.querySelector('textarea')!
  const button = view.container.querySelector('button')!
  return { view, textarea, button, props }
}

describe('Enter semantics', () => {
  it('plain Enter sends queue mode; repeat and empty are suppressed', () => {
    const { textarea, props } = setup()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledWith('queue')
    fireEvent.keyDown(textarea, { key: 'Enter', repeat: true })
    expect(props.onSend).toHaveBeenCalledTimes(1)
    const empty = setup({ draft: '   ' })
    fireEvent.keyDown(empty.textarea, { key: 'Enter' })
    expect(empty.props.onSend).not.toHaveBeenCalled()
  })

  it('non-Enter keys and Shift+Enter fall through to native behavior', () => {
    const { textarea, props } = setup()
    fireEvent.keyDown(textarea, { key: 'a' })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('Ctrl/Meta+Enter inserts a newline through execCommand instead of sending', () => {
    const exec = vi.fn()
    ;(document as unknown as { execCommand: typeof exec }).execCommand = exec
    const { textarea, props } = setup()
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(exec).toHaveBeenCalledWith('insertText', false, '\n')
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('composition Enter never sends: ref guard, isComposing, and keyCode 229 paths', async () => {
    vi.useFakeTimers()
    try {
      const { textarea, props } = setup()
      fireEvent.compositionStart(textarea)
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(props.onSend).not.toHaveBeenCalled()
      fireEvent.compositionEnd(textarea)
      // Safari delivers the closing keydown before the deferred clear.
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(props.onSend).not.toHaveBeenCalled()
      vi.advanceTimersByTime(20)
      fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })
      expect(props.onSend).not.toHaveBeenCalled()
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(props.onSend).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('running lock and primary button', () => {
  it('running locks the textarea and turns the primary into stop', () => {
    const { textarea, button, props } = setup({ running: true })
    expect(textarea.disabled).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('停止')
    fireEvent.click(button)
    expect(props.onStop).toHaveBeenCalledTimes(1)
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('idle primary sends and disables on empty draft', () => {
    const { button, props } = setup()
    fireEvent.click(button)
    expect(props.onSend).toHaveBeenCalledWith('queue')
    const empty = setup({ draft: '' })
    expect(empty.button.disabled).toBe(true)
  })

  it('unlock refocuses the textarea; mousedown on the button keeps focus', () => {
    const { view, props } = setup({ running: true })
    view.rerender(<InputBar {...props} running={false} />)
    const textarea = view.container.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    textarea.blur()
    fireEvent.mouseDown(view.container.querySelector('button')!)
    expect(document.activeElement).toBe(textarea)
  })

  it('disabled state shows the unavailable placeholder; typing forwards drafts', () => {
    const { textarea } = setup({ disabled: true, draft: '' })
    expect(textarea.placeholder).toBe('会话不可用')
    const live = setup({ draft: '' })
    expect(live.textarea.placeholder).toContain('Enter 发送')
    fireEvent.change(live.textarea, { target: { value: 'typed' } })
    expect(live.props.onDraftChange).toHaveBeenCalledWith('typed')
    const runningPh = setup({ running: true, draft: '' })
    expect(runningPh.textarea.placeholder).toContain('停止')
    const custom = setup({ placeholder: '自定义' })
    expect(custom.textarea.placeholder).toBe('自定义')
  })
})

describe('error strip and variants', () => {
  it('renders send and stop failure copy', () => {
    const send = setup({ error: { op: 'send', message: 'boom' } })
    expect(send.view.getByText(/发送失败：boom/)).toBeTruthy()
    const stop = setup({ error: { op: 'stop', message: 'halt' } })
    expect(stop.view.getByText(/停止失败：halt/)).toBeTruthy()
  })

  it('hero variant adds the hero class and accessory row renders', () => {
    const { view } = setup({ variant: 'hero', accessory: <i data-testid="acc" /> })
    expect(view.getByTestId('acc')).toBeTruthy()
    expect(view.container.querySelector('[class*="hero"]')).not.toBeNull()
  })
})

describe('image draft rail', () => {
  it('collects supported clipboard images and leaves non-image clipboard data to the browser', () => {
    const onAddImages = vi.fn()
    const { textarea } = setup({ draft: '', onAddImages })
    const image = new File([Uint8Array.of(1, 2, 3)], 'pixel.png', { type: 'image/png' })
    const prevented = fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
          { kind: 'file', type: 'image/png', getAsFile: () => image },
        ],
      },
    })
    expect(prevented).toBe(false)
    expect(onAddImages).toHaveBeenCalledWith([image])

    fireEvent.paste(textarea, {
      clipboardData: { items: [{ kind: 'file', type: 'video/mp4', getAsFile: () => image }] },
    })
    expect(onAddImages).toHaveBeenCalledTimes(1)
  })

  it('accepts supported image drops, highlights the target, and prevents browser navigation', () => {
    const onAddImages = vi.fn()
    const { view } = setup({ draft: '', onAddImages })
    const card = view.container.querySelector('[class*="card"]')!
    const image = new File([Uint8Array.of(1, 2, 3)], 'dropped.png', { type: 'image/png' })
    const dataTransfer = {
      types: ['Files'],
      files: [image],
      dropEffect: 'none',
    }
    expect(fireEvent.dragEnter(card, { dataTransfer })).toBe(false)
    expect(view.getByRole('status').textContent).toContain('松开以添加图片')
    expect(fireEvent.dragOver(card, { dataTransfer })).toBe(false)
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(fireEvent.drop(card, { dataTransfer })).toBe(false)
    expect(view.queryByRole('status')).toBeNull()
    expect(onAddImages).toHaveBeenCalledWith([image])
  })

  it('ignores unsupported dropped files and refuses drops while locked', () => {
    const onAddImages = vi.fn()
    const { view } = setup({ draft: '', onAddImages })
    const card = view.container.querySelector('[class*="card"]')!
    const documentFile = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    fireEvent.drop(card, {
      dataTransfer: { types: ['Files'], files: [documentFile], dropEffect: 'none' },
    })
    expect(view.getByText(/暂仅支持 PNG/)).toBeTruthy()
    expect(onAddImages).not.toHaveBeenCalled()

    const image = new File([Uint8Array.of(1)], 'locked.png', { type: 'image/png' })
    const locked = setup({ draft: '', disabled: true, onAddImages })
    const lockedCard = locked.view.container.querySelector('[class*="card"]')!
    const dataTransfer = { types: ['Files'], files: [image], dropEffect: 'copy' }
    fireEvent.dragEnter(lockedCard, { dataTransfer })
    expect(locked.view.queryByRole('status')).toBeNull()
    fireEvent.dragOver(lockedCard, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('none')
    fireEvent.drop(lockedCard, { dataTransfer })
    expect(onAddImages).not.toHaveBeenCalled()
  })

  it('allows image-only send, removes a thumbnail, and opens original preview on double-click', () => {
    const file = new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' })
    const attachment = { id: 'draft-1', file, previewUrl: 'blob:draft-1' }
    const onRemoveAttachment = vi.fn()
    const { view, textarea, props } = setup({
      draft: '', attachments: [attachment], onRemoveAttachment,
    })
    const send = view.getByRole('button', { name: '发送' }) as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(props.onSend).toHaveBeenCalledWith('queue')

    fireEvent.click(view.getByRole('button', { name: '移除图片 pixel.png' }))
    expect(onRemoveAttachment).toHaveBeenCalledWith('draft-1')
    fireEvent.doubleClick(view.getByTitle('双击查看原图'))
    expect(view.getByRole('dialog', { name: '原图预览' })).toBeTruthy()
    expect(view.getAllByAltText('pixel.png').every(node => (node as HTMLImageElement).src.includes('blob:draft-1'))).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByRole('dialog', { name: '原图预览' })).toBeNull()
  })
})
