// @vitest-environment jsdom
// WebBlock: both kinds of the web card. The search card's answer, its citation
// list with the title-or-hostname label fallback and optional snippet/date, the
// source-list height cap and its expand control, and the truncated indicator;
// the fetch card's linked URL, status, and truncation. Safe-link attributes on
// both kinds: an http(s) URL becomes an external anchor (target/rel), any other
// URL renders as plain text with no href.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { DEFAULT_WEB_MAX_SOURCES, WebBlock } from '../src/index.ts'
import type { WebSourceView } from '../src/index.ts'

afterEach(cleanup)

/** `count` sources with sequential hostnames, so the cap slices read distinctly. */
function sources(count: number): WebSourceView[] {
  return Array.from({ length: count }, (_value, index) => ({
    url: `https://site-${index}.example.com/page`,
    title: `Source ${index}`,
  }))
}

describe('WebBlock search card', () => {
  it('renders the answer above the citation list', () => {
    const view = render(<WebBlock kind="search" answer="**Answer** text" sources={sources(2)} truncated={false} />)
    expect(view.getByText('Answer')).toBeTruthy()
    expect(view.getByText('Source 0')).toBeTruthy()
    expect(view.getByText('Source 1')).toBeTruthy()
  })

  it('omits the answer block when there is no answer', () => {
    const view = render(<WebBlock kind="search" sources={sources(1)} truncated={false} />)
    expect(view.container.querySelector('[class^="_answer_"]')).toBeNull()
    const empty = render(<WebBlock kind="search" answer="" sources={sources(1)} truncated={false} />)
    expect(empty.container.querySelector('[class^="_answer_"]')).toBeNull()
  })

  it('shows the empty-state note when a search returns no answer and no sources', () => {
    const view = render(<WebBlock kind="search" sources={[]} truncated={false} />)
    expect(view.getByText('未找到结果')).toBeTruthy()
    // The empty note replaces the source list, not an empty <ol>.
    expect(view.container.querySelector('ol')).toBeNull()
  })

  it('shows the source list, not the empty note, when a source is present', () => {
    const view = render(<WebBlock kind="search" sources={sources(1)} truncated={false} />)
    expect(view.container.querySelector('ol')).toBeTruthy()
    expect(view.queryByText('未找到结果')).toBeNull()
  })

  it('shows the source list when an empty source list still carries an answer', () => {
    const view = render(<WebBlock kind="search" answer="Just an answer" sources={[]} truncated={false} />)
    expect(view.getByText('Just an answer')).toBeTruthy()
    expect(view.queryByText('未找到结果')).toBeNull()
  })

  it('labels a source by its title, and by hostname when the title is absent', () => {
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'https://example.com/a', title: 'Titled' },
      { url: 'https://plain.example.org/b' },
      { url: 'https://empty.example.net/c', title: '' },
    ]} />)
    expect(view.getByText('Titled')).toBeTruthy()
    // No title / empty title: the hostname labels the link.
    expect(view.getByText('plain.example.org')).toBeTruthy()
    expect(view.getByText('empty.example.net')).toBeTruthy()
  })

  it('labels a source by the raw url when it parses to an empty hostname', () => {
    // file:/data:/javascript: URLs parse but have no hostname; the label must
    // fall back to the raw URL so it is never blank (and the link stays plain
    // text since the protocol is not http(s)).
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'file:///etc/passwd' },
    ]} />)
    expect(view.getByText('file:///etc/passwd')).toBeTruthy()
  })

  it('renders a source as a safe external anchor for an http(s) url', () => {
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'https://example.com/a', title: 'Titled' },
    ]} />)
    const anchor = view.getByText('Titled') as HTMLAnchorElement
    expect(anchor.tagName).toBe('A')
    expect(anchor.getAttribute('href')).toBe('https://example.com/a')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders a non-http url as plain text with no href, and its raw text label when unparseable', () => {
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'javascript:alert(1)', title: 'Dangerous' },
      { url: 'not a url' },
    ]} />)
    const unsafe = view.getByText('Dangerous')
    expect(unsafe.tagName).toBe('SPAN')
    expect(unsafe.getAttribute('href')).toBeNull()
    // An unparseable url is not a link and cannot yield a hostname, so its raw
    // text is the label.
    const raw = view.getByText('not a url')
    expect(raw.tagName).toBe('SPAN')
  })

  it('shows a source snippet and publication date when present, and omits them when absent or empty', () => {
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'https://a.example.com', title: 'A', snippet: 'excerpt', publishedAt: '2026-07-01' },
      { url: 'https://b.example.com', title: 'B', snippet: '', publishedAt: '' },
      { url: 'https://c.example.com', title: 'C' },
    ]} />)
    expect(view.getByText('excerpt')).toBeTruthy()
    expect(view.getByText('2026-07-01')).toBeTruthy()
    // The empty-string and absent arms both draw nothing beyond the link.
    expect(view.container.querySelectorAll('[class^="_snippet_"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[class^="_published_"]')).toHaveLength(1)
  })

  it('shows the truncated indicator only when the list was capped by the tool', () => {
    const on = render(<WebBlock kind="search" sources={sources(1)} truncated />)
    expect(on.getByText('来源列表已截断')).toBeTruthy()
    cleanup()
    const off = render(<WebBlock kind="search" sources={sources(1)} truncated={false} />)
    expect(off.queryByText('来源列表已截断')).toBeNull()
  })

  it('renders every source and no expand control under the cap', () => {
    const view = render(<WebBlock kind="search" sources={sources(4)} truncated={false} maxSources={4} />)
    expect(view.container.querySelectorAll('[class^="_source_"]')).toHaveLength(4)
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
  })

  it('slices head and tail over the cap and expands on click', () => {
    const view = render(<WebBlock kind="search" sources={sources(10)} truncated={false} maxSources={4} />)
    // maxSources 4: head = ceil(4/2) = 2, tail = 4 - 2 = 2, 6 hidden.
    expect([...view.container.querySelectorAll('[class^="_sourceLink_"]')].map(n => n.textContent))
      .toEqual(['Source 0', 'Source 1', 'Source 8', 'Source 9'])
    const toggle = view.getByRole('button', { name: '展开其余 6 条来源' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('… 其余 6 条来源')

    fireEvent.click(toggle)
    expect(view.container.querySelectorAll('[class^="_source_"]')).toHaveLength(10)
    const collapse = view.getByRole('button', { name: '收起来源' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(collapse.textContent).toBe('收起')

    fireEvent.click(collapse)
    expect(view.container.querySelectorAll('[class^="_source_"]')).toHaveLength(4)
  })

  it('numbers a collapsed tail by each source original position, not its visible slot', () => {
    // maxSources 4 over 10 sources: the tail is sources 8 and 9, which must read
    // as citations 9 and 10 (via <li value>), not renumbered 3 and 4.
    const view = render(<WebBlock kind="search" sources={sources(10)} truncated={false} maxSources={4} />)
    const items = [...view.container.querySelectorAll('li[class^="_source_"]')]
    expect(items.map(li => li.getAttribute('value'))).toEqual(['1', '2', '9', '10'])
  })

  it('keeps the expander out of the ordered-list numbering', () => {
    // The expander is a marker-less <li>, so it is valid inside <ol> and does not
    // consume a citation number between the head and tail sources.
    const view = render(<WebBlock kind="search" sources={sources(10)} truncated={false} maxSources={4} />)
    const ol = view.container.querySelector('ol')!
    // Every direct child is an <li> (no bare <button> child — invalid HTML).
    expect([...ol.children].every(child => child.tagName === 'LI')).toBe(true)
  })

  it('renders the head slice alone when the cap leaves no tail', () => {
    const view = render(<WebBlock kind="search" sources={sources(5)} truncated={false} maxSources={1} />)
    expect([...view.container.querySelectorAll('[class^="_sourceLink_"]')].map(n => n.textContent)).toEqual(['Source 0'])
    expect(view.getByRole('button', { name: '展开其余 4 条来源' })).toBeTruthy()
  })

  it('caps at the documented default when maxSources is absent', () => {
    const view = render(<WebBlock kind="search" sources={sources(DEFAULT_WEB_MAX_SOURCES + 1)} truncated={false} />)
    expect(view.container.querySelectorAll('[class^="_source_"]')).toHaveLength(DEFAULT_WEB_MAX_SOURCES)
    expect(view.getByRole('button', { name: '展开其余 1 条来源' })).toBeTruthy()
  })
})

describe('WebBlock fetch card', () => {
  it('renders the fetched url as a safe external anchor and its HTTP status', () => {
    const view = render(<WebBlock kind="fetch" url="https://example.com/page" statusCode={200} truncated={false} />)
    const anchor = view.getByText('https://example.com/page') as HTMLAnchorElement
    expect(anchor.tagName).toBe('A')
    expect(anchor.getAttribute('href')).toBe('https://example.com/page')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
    expect(view.getByText('HTTP 200')).toBeTruthy()
  })

  it('renders a non-http fetch url as plain text with no href', () => {
    const view = render(<WebBlock kind="fetch" url="file:///etc/passwd" statusCode={200} truncated={false} />)
    const label = view.getByText('file:///etc/passwd')
    expect(label.tagName).toBe('SPAN')
    expect(label.getAttribute('href')).toBeNull()
  })

  it('shows the truncated indicator only when the content was cut', () => {
    const on = render(<WebBlock kind="fetch" url="https://example.com" statusCode={200} truncated />)
    expect(on.getByText('内容已截断')).toBeTruthy()
    cleanup()
    const off = render(<WebBlock kind="fetch" url="https://example.com" statusCode={200} truncated={false} />)
    expect(off.queryByText('内容已截断')).toBeNull()
  })

  it('carries a non-200 status verbatim', () => {
    const view = render(<WebBlock kind="fetch" url="https://example.com/missing" statusCode={404} truncated={false} />)
    expect(view.getByText('HTTP 404')).toBeTruthy()
  })
})
