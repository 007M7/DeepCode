// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonBlock, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('MessageText', () => {
  it('renders the text verbatim', () => {
    const { container } = render(<MessageText text={'line1\nline2'} />)
    expect(container.textContent).toBe('line1\nline2')
  })
})

describe('JsonBlock', () => {
  it('collapsed by default; toggle reveals pretty-printed payload', () => {
    render(<JsonBlock label="args" payload={{ a: 1 }} />)
    expect(screen.queryByText(/"a": 1/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /args/ }))
    expect(screen.getByText(/"a": 1/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /args/ }))
    expect(screen.queryByText(/"a": 1/)).toBeNull()
  })

  it('defaultOpen renders the body immediately', () => {
    const { container } = render(<JsonBlock label="args" payload={[1, 2]} defaultOpen />)
    expect(container.querySelector('pre')?.textContent).toContain('1')
  })

  it('stringifies undefined payloads via String()', () => {
    const { container } = render(<JsonBlock label="x" payload={undefined} defaultOpen />)
    expect(container.querySelector('pre')?.textContent).toBe('undefined')
  })

  it('falls back to String() for circular payloads', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    const { container } = render(<JsonBlock label="x" payload={circular} defaultOpen />)
    expect(container.querySelector('pre')?.textContent).toBe('[object Object]')
  })

  it('truncates beyond the size cap with a suffix note', () => {
    const big = 'x'.repeat(30_000)
    const { container } = render(<JsonBlock label="x" payload={big} defaultOpen />)
    const body = container.querySelector('pre')!.textContent!
    expect(body.length).toBeLessThan(30_000)
    expect(body).toContain('截断')
  })
})
