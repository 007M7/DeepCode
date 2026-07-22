// @vitest-environment jsdom
/**
 * AppFrame interaction spec: drag sequences (pointer capture + rAF flush),
 * concession response to viewport change, details stays mounted at zero
 * width. jsdom has no layout engine, so the frame width comes from a mocked
 * getBoundingClientRect and resizes are driven through the ResizeObserver
 * stub; assertions read the inline grid template.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-web-react'
import { AppFrame, CenterColumn, DetailsColumn, type PanelState } from '@deepseek-ai/dsh-client-ui-layout/client'
import { clampWidth } from '@deepseek-ai/dsh-client-ui-layout/client'

/** Observer stub: captures the callback so tests can fire resizes manually. */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this as unknown as ResizeObserver) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

let frameWidth = 1920

function mountFrame() {
  window.innerWidth = frameWidth // first-render viewport source before the observer fires
  const sidebar = createSnapshotStore<PanelState>({ open: true, width: 300 })
  const details = createSnapshotStore<PanelState>({ open: true, width: 360 })
  const utils = render(
    <AppFrame
      useSidebar={sidebar.useSelector}
      useDetails={details.useSelector}
      setSidebarWidth={(px) => { sidebar.update((d) => { d.width = clampWidth(px, 240, 420) }) }}
      setDetailsWidth={(px) => { details.update((d) => { d.width = clampWidth(px, 300, 520) }) }}
      sidebar={<div data-testid="sidebar-content" />}
    >
      <CenterColumn><div data-testid="center-content" /></CenterColumn>
      <DetailsColumn><div data-testid="details-content" /></DetailsColumn>
    </AppFrame>,
  )
  const frame = utils.container.firstElementChild as HTMLElement
  return { sidebar, details, frame, ...utils }
}

function tracks(frame: HTMLElement): number[] {
  const m = /^(\d+)px minmax\(0, 1fr\) (\d+)px$/.exec(frame.style.gridTemplateColumns)
  if (m === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return [Number(m[1]), Number(m[2])]
}

function drag(handle: Element, fromX: number, toX: number): void {
  const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: fromX, bubbles: true })
  const move = new PointerEvent('pointermove', { pointerId: 1, clientX: toX, bubbles: true })
  const up = new PointerEvent('pointerup', { pointerId: 1, clientX: toX, bubbles: true })
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

beforeEach(() => {
  frameWidth = 1920
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  Element.prototype.getBoundingClientRect = function () {
    return { width: frameWidth, height: 1080, top: 0, left: 0, right: frameWidth, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  // jsdom lacks pointer capture: emulate per-element so hasPointerCapture gates pass.
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AppFrame', () => {
  it('renders three tracks from panel state', () => {
    const { frame } = mountFrame()
    expect(tracks(frame)).toEqual([300, 360])
  })

  it('sidebar drag widens through rAF-batched pointer moves', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[0]!, 300, 350)
    expect(tracks(frame)[0]).toBe(350)
  })

  it('details drag widens leftward (negative dx grows the panel)', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 1560, 1500)
    expect(tracks(frame)[1]).toBe(420)
  })

  it('drag base is the rendered (concession-clamped) width, not the preference', () => {
    frameWidth = 1250 // step-2 squeeze: details renders 310 while preference is 360
    const { frame, details } = mountFrame()
    expect(tracks(frame)).toEqual([300, 310])
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 940, 950) // shrink by 10 from the rendered width
    expect(details.getSnapshot().width).toBe(300)
  })

  it('details column stays mounted at zero width', () => {
    const { frame, details, getByTestId } = mountFrame()
    act(() => { details.update((d) => { d.open = false }) })
    expect(tracks(frame)).toEqual([300, 0])
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
  })

  it('viewport shrink triggers the concession chain via ResizeObserver', () => {
    const { frame } = mountFrame()
    frameWidth = 1250
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([300, 310])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([300, 360])
  })

  it('drag handles disappear for collapsed columns', () => {
    const { frame, details, sidebar } = mountFrame()
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { details.update((d) => { d.open = false }) })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { sidebar.update((d) => { d.open = false }) })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })
})

describe('AppFrame — guard branches', () => {
  it('pointer moves without capture are ignored (no width write)', () => {
    const { frame, sidebar } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = sidebar.getSnapshot().width
    // Move + up without a preceding pointerdown: hasPointerCapture is false.
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 500, bubbles: true }))
      vi.advanceTimersByTime(20)
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: 500, bubbles: true }))
    })
    expect(sidebar.getSnapshot().width).toBe(before)
  })

  it('two moves inside one frame coalesce through the pending rAF', () => {
    const { frame, sidebar } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 300, bubbles: true })) })
    act(() => {
      // Two moves before the frame flushes: the second must ride the pending
      // rAF (frame.current ??= guard), and the flush sees the latest x.
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 320, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 340, bubbles: true })) })
    expect(sidebar.getSnapshot().width).toBe(340)
  })

  it('pointerup with a pending rAF cancels it and commits the final position', () => {
    const { frame, sidebar } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 300, bubbles: true })) })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 360, bubbles: true }))
      // No timer advance: the rAF is still pending when pointerup arrives.
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 360, bubbles: true }))
    })
    expect(sidebar.getSnapshot().width).toBe(360)
  })

  it('zero-width resize reports are ignored (display:none window)', () => {
    const { frame } = mountFrame()
    frameWidth = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    // Track template still reflects the last non-zero viewport.
    expect(tracks(frame)).toEqual([300, 360])
  })
})

describe('AppFrame — unmount with an in-flight resize frame', () => {
  it('cancels the pending rAF on unmount (no post-unmount setState)', () => {
    const { unmount } = mountFrame()
    frameWidth = 800
    act(() => { fireResize?.() }) // rAF scheduled, NOT flushed
    unmount()
    // Flushing after unmount must be a no-op (the frame was cancelled).
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
  })

  it('double resize inside one frame rides the pending rAF (?"?= guard)', () => {
    const { frame } = mountFrame()
    frameWidth = 1250
    act(() => { fireResize?.(); fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([300, 310])
  })
})
