// @vitest-environment jsdom
/**
 * Field-control behavior: when a draft becomes a write, what a bad draft does
 * instead, and how an overridden field offers its reset.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NumberField, SecretField, TextField } from '../src/client/fields.tsx'

afterEach(cleanup)

const frame = {
  id: 'field',
  label: 'Command timeout',
  hint: 'How long one command may run.',
  overriddenLabel: 'Overridden',
  resetLabel: 'Reset to default',
  disabled: false,
}

describe('NumberField', () => {
  it('commits a changed draft on blur', () => {
    const onCommit = vi.fn()
    render(
      <NumberField {...frame} overridden={false} onReset={vi.fn()} value={60_000} onCommit={onCommit} />,
    )
    const input = screen.getByLabelText('Command timeout')

    fireEvent.change(input, { target: { value: '9000' } })
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledWith(9_000)
  })

  it('commits on Enter through the blur the key triggers', () => {
    const onCommit = vi.fn()
    render(
      <NumberField {...frame} overridden={false} onReset={vi.fn()} value={60_000} onCommit={onCommit} />,
    )
    const input = screen.getByLabelText('Command timeout')

    fireEvent.change(input, { target: { value: '1234' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledWith(1_234)
  })

  it('restores the last good value instead of committing a draft that is not a number', () => {
    const onCommit = vi.fn()
    render(
      <NumberField {...frame} overridden={false} onReset={vi.fn()} value={60_000} onCommit={onCommit} />,
    )
    const input = screen.getByLabelText('Command timeout')

    fireEvent.change(input, { target: { value: 'soon' } })
    fireEvent.blur(input)

    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveProperty('value', '60000')
  })

  it('writes nothing when the draft settles on the value already shown', () => {
    const onCommit = vi.fn()
    render(
      <NumberField {...frame} overridden={false} onReset={vi.fn()} value={60_000} onCommit={onCommit} />,
    )
    const input = screen.getByLabelText('Command timeout')

    fireEvent.change(input, { target: { value: '60000' } })
    fireEvent.blur(input)

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('offers the reset only while the field is overridden', () => {
    const onReset = vi.fn()
    const { rerender } = render(
      <NumberField {...frame} overridden={false} onReset={onReset} value={9_000} onCommit={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()

    rerender(
      <NumberField {...frame} overridden onReset={onReset} value={9_000} onCommit={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))

    expect(screen.getByText('Overridden')).toBeTruthy()
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('re-seeds the draft when the authoritative value changes underneath', () => {
    const { rerender } = render(
      <NumberField {...frame} overridden onReset={vi.fn()} value={9_000} onCommit={vi.fn()} />,
    )
    expect(screen.getByLabelText('Command timeout')).toHaveProperty('value', '9000')

    rerender(
      <NumberField {...frame} overridden={false} onReset={vi.fn()} value={60_000} onCommit={vi.fn()} />,
    )

    expect(screen.getByLabelText('Command timeout')).toHaveProperty('value', '60000')
  })

  it('ignores a keystroke that is not Enter', () => {
    const onCommit = vi.fn()
    render(
      <NumberField {...frame} overridden={false} onReset={vi.fn()} value={60_000} onCommit={onCommit} />,
    )
    const input = screen.getByLabelText('Command timeout')

    fireEvent.change(input, { target: { value: '9000' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('suppresses every interaction while disabled', () => {
    const onCommit = vi.fn()
    const onReset = vi.fn()
    render(
      <NumberField
        {...frame}
        disabled
        overridden
        onReset={onReset}
        value={9_000}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Command timeout')

    expect(input).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Reset to default' })).toHaveProperty('disabled', true)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onReset).not.toHaveBeenCalled()
  })
})

describe('TextField', () => {
  it('commits the trimmed draft', () => {
    const onCommit = vi.fn()
    render(
      <TextField
        {...frame}
        label="Endpoint"
        overridden={false}
        onReset={vi.fn()}
        value=""
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Endpoint')

    fireEvent.change(input, { target: { value: '  https://search.test/v1  ' } })
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledWith('https://search.test/v1')
  })

  it('commits an emptied draft, which clears the field', () => {
    const onCommit = vi.fn()
    render(
      <TextField
        {...frame}
        label="Endpoint"
        overridden
        onReset={vi.fn()}
        value="https://search.test/v1"
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Endpoint')

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledWith('')
  })

  it('renders its placeholder and commits on Enter', () => {
    const onCommit = vi.fn()
    render(
      <TextField
        {...frame}
        label="Endpoint"
        placeholder="https://api.deepseek.com"
        overridden={false}
        onReset={vi.fn()}
        value=""
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Endpoint')
    expect(input).toHaveProperty('placeholder', 'https://api.deepseek.com')

    fireEvent.change(input, { target: { value: 'https://other.test' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledWith('https://other.test')
  })

  it('ignores a keystroke that is not Enter and writes nothing unchanged', () => {
    const onCommit = vi.fn()
    render(
      <TextField
        {...frame}
        label="Endpoint"
        overridden={false}
        onReset={vi.fn()}
        value="https://search.test/v1"
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('Endpoint')

    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.blur(input)

    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('SecretField', () => {
  it('commits a non-empty draft and clears the control after writing', () => {
    const onCommit = vi.fn()
    render(
      <SecretField
        {...frame}
        label="API key"
        configured={false}
        stateLabel="No key is configured."
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('API key')

    fireEvent.change(input, { target: { value: ' ds-secret ' } })
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledWith('ds-secret')
    expect(input).toHaveProperty('value', '')
  })

  it('keeps the stored key when the draft is left blank', () => {
    const onCommit = vi.fn()
    render(
      <SecretField
        {...frame}
        label="API key"
        configured
        stateLabel="A key is configured."
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('API key')

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)

    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByText('A key is configured.')).toBeTruthy()
  })

  it('ignores a keystroke that is not Enter', () => {
    const onCommit = vi.fn()
    render(
      <SecretField
        {...frame}
        label="API key"
        configured={false}
        stateLabel="No key is configured."
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('API key')

    fireEvent.change(input, { target: { value: 'ds-secret' } })
    fireEvent.keyDown(input, { key: 'Tab' })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('never renders the value it writes', () => {
    render(
      <SecretField
        {...frame}
        label="API key"
        configured
        stateLabel="A key is configured."
        onCommit={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('API key')).toHaveProperty('type', 'password')
  })

  it('commits on Enter and stays disabled when the document is read-only', () => {
    const onCommit = vi.fn()
    const { rerender } = render(
      <SecretField
        {...frame}
        label="API key"
        configured={false}
        stateLabel="No key is configured."
        onCommit={onCommit}
      />,
    )
    const input = screen.getByLabelText('API key')
    fireEvent.change(input, { target: { value: 'ds-secret' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('ds-secret')

    rerender(
      <SecretField
        {...frame}
        disabled
        label="API key"
        configured
        stateLabel="A key is configured."
        onCommit={onCommit}
      />,
    )

    expect(screen.getByLabelText('API key')).toHaveProperty('disabled', true)
  })
})
