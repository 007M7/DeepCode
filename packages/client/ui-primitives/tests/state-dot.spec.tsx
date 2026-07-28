// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('StateDot', () => {
  it.each(['done', 'warning', 'ongoing', 'error'] as const)('renders state %s as data-state', (state) => {
    const { container } = render(<StateDot state={state} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.dataset['state']).toBe(state)
    expect(dot.getAttribute('aria-hidden')).toBe('true')
  })

  it('solid states are spans; ongoing is an svg gradient ring', () => {
    const { container, rerender } = render(<StateDot state="done" />)
    expect(container.firstElementChild?.tagName).toBe('SPAN')
    rerender(<StateDot state="ongoing" />)
    const ring = container.firstElementChild as SVGSVGElement
    expect(ring.tagName).toBe('svg')
    const circle = ring.querySelector('circle')
    expect(circle?.getAttribute('stroke-width')).toBe('1')
    expect(circle?.getAttribute('stroke')).toMatch(/^url\(#/)
    expect(ring.querySelector('linearGradient')).not.toBeNull()
  })

  it('sizes via the size prop in both shapes', () => {
    const { container, rerender } = render(<StateDot state="done" size={12} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.style.width).toBe('12px')
    expect(dot.style.height).toBe('12px')
    rerender(<StateDot state="ongoing" size={12} />)
    const ring = container.firstElementChild as SVGSVGElement
    expect(ring.getAttribute('width')).toBe('12')
    expect(ring.getAttribute('height')).toBe('12')
  })

  it('rejects unknown states at the type level', () => {
    const bad = (state: StateDotState) => state
    // @ts-expect-error 'paused' is not one of the four states
    expect(bad('paused')).toBe('paused')
  })
})
