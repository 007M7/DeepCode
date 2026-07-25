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
  // aria-label (not role name): title carries the same label and would double-match.
  const button = view.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${over?.running === true ? 'Stop generating' : 'Send message'}"]`,
  )!
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
    expect(button.getAttribute('aria-label')).toBe('Stop generating')
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
    fireEvent.mouseDown(view.container.querySelector('button[aria-label="Send message"]')!)
    expect(document.activeElement).toBe(textarea)
  })

  it('disabled state shows the unavailable placeholder; typing forwards drafts', () => {
    const { textarea } = setup({ disabled: true, draft: '' })
    expect(textarea.placeholder).toBe('Session unavailable')
    const live = setup({ draft: '' })
    expect(live.textarea.placeholder).toBe('Message the agent')
    fireEvent.change(live.textarea, { target: { value: 'typed' } })
    expect(live.props.onDraftChange).toHaveBeenCalledWith('typed')
    const runningPh = setup({ running: true, draft: '' })
    expect(runningPh.textarea.placeholder).toBe('Generating a response…')
    const custom = setup({ placeholder: 'Custom placeholder' })
    expect(custom.textarea.placeholder).toBe('Custom placeholder')
  })
})

describe('error strip and variants', () => {
  it('renders send and stop failure copy', () => {
    const send = setup({ error: { op: 'send', message: 'boom' } })
    expect(send.view.container.querySelector('[role="alert"]')?.textContent).toBe('boom')
    const stop = setup({ error: { op: 'stop', message: 'halt' } })
    expect(stop.view.container.querySelector('[role="alert"]')?.textContent).toBe('halt')
  })

  it('hero variant adds the hero class and accessory row renders', () => {
    const { view } = setup({ variant: 'hero', accessory: <i data-testid="acc" /> })
    expect(view.getByTestId('acc')).toBeTruthy()
    expect(view.container.querySelector('[class*="hero"]')).not.toBeNull()
  })
})

describe('placeholder chrome', () => {
  it('renders attach / Plan / Read-only / model controls', () => {
    const { view } = setup()
    expect(view.getByLabelText('Add attachment')).toBeTruthy()
    expect((view.getByLabelText('Plan mode') as HTMLSelectElement).value).toBe('plan')
    expect((view.getByLabelText('Access mode') as HTMLSelectElement).value).toBe('readonly')
    expect((view.getByLabelText('Model') as HTMLSelectElement).value).toBe('v4-pro-high')
  })

  it('native select change updates the selected option', () => {
    const { view } = setup()
    const plan = view.getByLabelText('Plan mode') as HTMLSelectElement
    fireEvent.change(plan, { target: { value: 'agent' } })
    expect(plan.value).toBe('agent')
    const access = view.getByLabelText('Access mode') as HTMLSelectElement
    fireEvent.change(access, { target: { value: 'readwrite' } })
    expect(access.value).toBe('readwrite')
  })

  it('model select can drop the High option', () => {
    const { view } = setup()
    const model = view.getByLabelText('Model') as HTMLSelectElement
    fireEvent.change(model, { target: { value: 'v4-pro' } })
    expect(model.value).toBe('v4-pro')
    expect(model.selectedOptions[0]?.textContent).toBe('DeepSeek-V4-Pro')
  })

  it('running locks the chrome selects and attach control', () => {
    const { view } = setup({ running: true })
    expect((view.getByLabelText('Add attachment') as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByLabelText('Plan mode') as HTMLSelectElement).disabled).toBe(true)
    expect((view.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(true)
  })
})
