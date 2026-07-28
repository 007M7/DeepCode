// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverCard } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Anchor wrapper rect: the card positions from this (jsdom rects are all-zero by default). */
function stubAnchorRect(anchor: HTMLElement, rect: { top: number; right: number }): void {
  const wrapper = anchor.parentElement as HTMLElement
  wrapper.getBoundingClientRect = () => ({
    top: rect.top, right: rect.right, left: rect.right - 100, bottom: rect.top + 34,
    width: 100, height: 34, x: rect.right - 100, y: rect.top, toJSON: () => ({}),
  })
}

function mount(props: { openDelayMs?: number; disabled?: boolean } = {}) {
  const view = render(
    <HoverCard anchor={<span>row</span>} content={<div>card body</div>} {...props} />,
  )
  const anchor = screen.getByText('row')
  stubAnchorRect(anchor, { top: 40, right: 200 })
  return { view, anchor, wrapper: anchor.parentElement as HTMLElement }
}

describe('HoverCard', () => {
  it('opens after the dwell delay, positioned right of the anchor', () => {
    const { wrapper } = mount()
    fireEvent.pointerEnter(wrapper)
    expect(screen.queryByText('card body')).toBeNull()
    act(() => { vi.advanceTimersByTime(499) })
    expect(screen.queryByText('card body')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    const card = screen.getByText('card body').parentElement as HTMLElement
    expect(card.parentElement).toBe(document.body)
    expect(card.style.left).toBe('208px')
    expect(card.style.top).toBe('40px')
  })

  it('honors a custom openDelayMs', () => {
    const { wrapper } = mount({ openDelayMs: 50 })
    fireEvent.pointerEnter(wrapper)
    act(() => { vi.advanceTimersByTime(50) })
    expect(screen.getByText('card body')).toBeTruthy()
  })

  it('pointerleave before the delay cancels the pending open', () => {
    const { wrapper } = mount()
    fireEvent.pointerEnter(wrapper)
    fireEvent.pointerLeave(wrapper)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.queryByText('card body')).toBeNull()
  })

  it('pointerleave closes an open card immediately; re-enter restarts the dwell', () => {
    const { wrapper } = mount()
    fireEvent.pointerEnter(wrapper)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('card body')).toBeTruthy()
    fireEvent.pointerLeave(wrapper)
    expect(screen.queryByText('card body')).toBeNull()
    fireEvent.pointerEnter(wrapper)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('card body')).toBeTruthy()
  })

  it('a press inside the anchor dismisses the card without waiting for disabled', () => {
    const { wrapper } = mount()
    fireEvent.pointerEnter(wrapper)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('card body')).toBeTruthy()
    fireEvent.pointerDown(screen.getByText('row'))
    expect(screen.queryByText('card body')).toBeNull()
    // The pending timer is also cleared: no reopen after the dwell.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.queryByText('card body')).toBeNull()
  })

  it('disabled suppresses opening entirely', () => {
    const { wrapper } = mount({ disabled: true })
    fireEvent.pointerEnter(wrapper)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.queryByText('card body')).toBeNull()
  })

  it('flipping disabled true closes an open card', () => {
    const { view, wrapper } = mount()
    fireEvent.pointerEnter(wrapper)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByText('card body')).toBeTruthy()
    view.rerender(<HoverCard anchor={<span>row</span>} content={<div>card body</div>} disabled />)
    expect(screen.queryByText('card body')).toBeNull()
  })

  it('corrects the bottom-edge clamp once the mounted card height is measurable', () => {
    // First placement reads height 0 (card not yet mounted) and keeps the
    // anchor top; the post-mount correction re-clamps with the real height.
    window.innerHeight = 300
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 120 })
    try {
      const { wrapper } = mount()
      stubAnchorRect(screen.getByText('row'), { top: 280, right: 200 })
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      const card = screen.getByText('card body').parentElement as HTMLElement
      // 300 - 120 - 8 = 172, instead of the anchor top 280.
      expect(card.style.top).toBe('172px')
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })

  it('clamps inside placement itself when the card is already measured (resize path)', () => {
    window.innerHeight = 300
    const { wrapper } = mount()
    stubAnchorRect(screen.getByText('row'), { top: 280, right: 200 })
    fireEvent.pointerEnter(wrapper)
    act(() => { vi.advanceTimersByTime(500) })
    const card = screen.getByText('card body').parentElement as HTMLElement
    Object.defineProperty(card, 'offsetHeight', { value: 120 })
    act(() => { fireEvent.resize(window) })
    expect(card.style.top).toBe('172px')
  })

  it('repositions on capture-phase scroll while open and stops listening after close', () => {
    const { wrapper } = mount()
    fireEvent.pointerEnter(wrapper)
    act(() => { vi.advanceTimersByTime(500) })
    stubAnchorRect(screen.getByText('row'), { top: 90, right: 300 })
    act(() => { fireEvent.scroll(document) })
    const card = screen.getByText('card body').parentElement as HTMLElement
    expect(card.style.left).toBe('308px')
    expect(card.style.top).toBe('90px')
    fireEvent.pointerLeave(wrapper)
    expect(screen.queryByText('card body')).toBeNull()
  })

  it('unmount clears a pending open timer', () => {
    const { view, wrapper } = mount()
    fireEvent.pointerEnter(wrapper)
    view.unmount()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.queryByText('card body')).toBeNull()
  })
})
