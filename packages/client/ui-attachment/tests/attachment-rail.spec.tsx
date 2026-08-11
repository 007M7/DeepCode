// @vitest-environment jsdom
// AttachmentRail behavior in the jsdom lane: item rendering and callbacks,
// arrow paging over stubbed scroll geometry (jsdom lays nothing out), the
// vertical-wheel pan, and the new-item end reveal.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AttachmentRail } from '../src/AttachmentRail.tsx'
import type { AttachmentRailItem, AttachmentRailLabels } from '../src/AttachmentRail.tsx'

afterEach(cleanup)

const labels: AttachmentRailLabels = {
  group: '待发送图片',
  open: '查看原图',
  scrollLeft: '向左滚动图片',
  scrollRight: '向右滚动图片',
}

function item(id: string): AttachmentRailItem {
  return { id, previewUrl: `blob:${id}`, alt: `${id}.png`, removeLabel: `移除图片 ${id}.png` }
}

/** Stub the rail's scroll geometry (jsdom reports 0 for every metric). */
function stubGeometry(rail: HTMLElement, { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(rail, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(rail, 'clientWidth', { value: clientWidth, configurable: true })
  let scrollLeft = 0
  Object.defineProperty(rail, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => { scrollLeft = value },
  })
  const scrollBy = vi.fn((options: { left: number }) => {
    scrollLeft = Math.max(0, Math.min(scrollWidth - clientWidth, scrollLeft + options.left))
  })
  rail.scrollBy = scrollBy as unknown as typeof rail.scrollBy
  return { scrollBy, setScrollLeft: (value: number) => { scrollLeft = value } }
}

describe('AttachmentRail', () => {
  it('renders thumbnails in order and routes open and remove clicks', () => {
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    const items = [item('a'), item('b')]
    const view = render(<AttachmentRail items={items} labels={labels} onOpen={onOpen} onRemove={onRemove} />)
    const rail = view.getByRole('group', { name: '待发送图片' })
    expect([...rail.querySelectorAll('img')].map(img => img.getAttribute('alt'))).toEqual(['a.png', 'b.png'])
    fireEvent.click(view.getAllByTitle('查看原图')[0]!)
    expect(onOpen).toHaveBeenCalledWith(items[0])
    fireEvent.click(view.getByRole('button', { name: '移除图片 b.png' }))
    expect(onRemove).toHaveBeenCalledWith(items[1])
  })

  it('shows edge arrows from scroll geometry and pages a viewport at a time', () => {
    const view = render(
      <AttachmentRail items={[item('a'), item('b'), item('c')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    const rail = view.getByRole('group', { name: '待发送图片' })
    const { scrollBy } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    // No arrows until geometry is observed (mount saw jsdom's zero metrics).
    expect(view.queryByLabelText('向右滚动图片')).toBeNull()
    fireEvent.scroll(rail)
    // Same-edges scroll takes the memoized-state path.
    fireEvent.scroll(rail)
    expect(view.queryByLabelText('向左滚动图片')).toBeNull()
    const right = view.getByLabelText('向右滚动图片')
    // clientWidth 200 - 64 < the 200 floor: pages by the floor.
    fireEvent.click(right)
    expect(scrollBy).toHaveBeenCalledWith({ left: 200, behavior: 'smooth' })
    fireEvent.scroll(rail)
    // Scrolled to the far edge: only the left arrow remains.
    expect(view.queryByLabelText('向右滚动图片')).toBeNull()
    fireEvent.click(view.getByLabelText('向左滚动图片'))
    expect(scrollBy).toHaveBeenCalledWith({ left: -200, behavior: 'smooth' })
    fireEvent.scroll(rail)
    expect(view.queryByLabelText('向左滚动图片')).toBeNull()
    expect(view.getByLabelText('向右滚动图片')).toBeTruthy()
  })

  it('shows both arrows mid-scroll and recomputes on window resize', () => {
    const view = render(
      <AttachmentRail items={[item('a'), item('b'), item('c')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    const rail = view.getByRole('group', { name: '待发送图片' })
    const { setScrollLeft } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    setScrollLeft(100)
    fireEvent(window, new Event('resize'))
    expect(view.getByLabelText('向左滚动图片')).toBeTruthy()
    expect(view.getByLabelText('向右滚动图片')).toBeTruthy()
  })

  it('pans horizontally on a vertical wheel with clamped travel', () => {
    const view = render(
      <AttachmentRail items={[item('a'), item('b')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    const rail = view.getByRole('group', { name: '待发送图片' })
    const { scrollBy } = stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    fireEvent.wheel(rail, { deltaY: 30 })
    expect(scrollBy).toHaveBeenCalledWith({ left: 30, behavior: 'auto' })
    fireEvent.wheel(rail, { deltaY: 500 })
    expect(scrollBy).toHaveBeenCalledWith({ left: 60, behavior: 'auto' })
    fireEvent.wheel(rail, { deltaY: -500 })
    expect(scrollBy).toHaveBeenCalledWith({ left: -60, behavior: 'auto' })
    // A trackpad pan (deltaX) and a zero-delta wheel keep native behavior.
    fireEvent.wheel(rail, { deltaX: 12, deltaY: 30 })
    fireEvent.wheel(rail, { deltaY: 0 })
    expect(scrollBy).toHaveBeenCalledTimes(3)
  })

  it('reveals the rail end when an item is added, not when one is removed', () => {
    const first = [item('a'), item('b')]
    const view = render(
      <AttachmentRail items={first} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    const rail = view.getByRole('group', { name: '待发送图片' })
    stubGeometry(rail, { scrollWidth: 400, clientWidth: 200 })
    view.rerender(
      <AttachmentRail items={[...first, item('c')]} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    expect(rail.scrollLeft).toBe(200)
    view.rerender(
      <AttachmentRail items={first} labels={labels} onOpen={vi.fn()} onRemove={vi.fn()} />,
    )
    // Removal keeps the position; only growth jumps to the end.
    expect(rail.scrollLeft).toBe(200)
  })
})
