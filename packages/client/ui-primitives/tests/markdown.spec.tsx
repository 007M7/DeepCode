// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonBlock, MarkdownText, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('MessageText', () => {
  it('renders the text verbatim', () => {
    const { container } = render(<MessageText text={'# line1\n`line2`'} />)
    expect(container.textContent).toBe('# line1\n`line2`')
    expect(container.querySelector('h1')).toBeNull()
  })
})

describe('MarkdownText', () => {
  it('renders CommonMark and GFM elements as semantic DOM', () => {
    const markdown = [
      '# Heading',
      '',
      'Paragraph with **strong**, *emphasis*, ~~deleted~~, `inline`, and [safe](https://example.com).  ',
      'Hard break.',
      '',
      '> Quote',
      '',
      '- parent',
      '  - child',
      '',
      '1. first',
      '2. second',
      '',
      '- [x] done',
      '- [ ] pending',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| alpha | beta |',
      '',
      '---',
      '',
      '```ts',
      'const answer = 42',
      '```',
      '',
      '<https://deepseek.com>',
    ].join('\n')
    const { container } = render(<MarkdownText text={markdown} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toBeTruthy()
    expect(container.querySelector('strong')?.textContent).toBe('strong')
    expect(container.querySelector('em')?.textContent).toBe('emphasis')
    expect(container.querySelector('del')?.textContent).toBe('deleted')
    expect(container.querySelector('blockquote')?.textContent?.trim()).toBe('Quote')
    expect(container.querySelectorAll('ul')).toHaveLength(3)
    expect(container.querySelector('ol')).not.toBeNull()
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    expect(container.querySelector('table')?.textContent).toContain('alphabeta')
    expect(container.querySelector('hr')).not.toBeNull()
    expect(container.querySelector('pre code')?.textContent).toContain('const answer = 42')
    // The ts fence routed through the shared CodeBlock: shiki token spans present.
    expect(container.querySelector('pre.shiki')).not.toBeNull()
    expect(container.querySelector('br')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'safe' }).getAttribute('target')).toBe('_blank')
    expect(screen.getByRole('link', { name: 'https://deepseek.com' })).toBeTruthy()
  })

  it('a fence labeled with an inherited object key renders plain, never crashing shiki', () => {
    for (const label of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const { container, unmount } = render(<MarkdownText text={'```' + label + '\ncode body\n```'} />)
      expect(container.querySelector('pre.shiki')).toBeNull()
      expect(container.querySelector('pre code')?.textContent).toContain('code body')
      unmount()
    }
  })

  it('an empty fence keeps the stock pre; a language-less fence renders the plain CodeBlock arm', () => {
    const empty = render(<MarkdownText text={'```\n```'} />)
    expect(empty.container.querySelector('pre')?.outerHTML).toBe('<pre><code></code></pre>')

    const plain = render(<MarkdownText text={'```\nno language here\n```'} />)
    expect(plain.container.querySelector('pre.shiki')).toBeNull()
    expect(plain.container.querySelector('pre code')?.textContent).toContain('no language here')
  })

  it('streaming renders fences plain; the finalize swap highlights them', () => {
    const fence = '```ts\nconst answer = 42\n```'
    const live = render(<MarkdownText text={fence} streaming />)
    expect(live.container.querySelector('pre.shiki')).toBeNull()
    expect(live.container.querySelector('pre code')?.textContent).toContain('const answer = 42')
    live.unmount()
    const done = render(<MarkdownText text={fence} />)
    expect(done.container.querySelector('pre.shiki')).not.toBeNull()
  })

  it('neutralizes raw HTML, unsafe or relative links, and remote images', () => {
    const markdown = [
      '<script>globalThis.compromised = true</script>',
      '<img src="x" onerror="globalThis.compromised = true">',
      '[script](javascript:alert(1)) [relative](/settings)',
      '[mail](mailto:dev@example.com) [web](http://example.com) [upper](HTTPS://example.com)',
      '![remote diagram](https://example.com/private.png)',
    ].join('\n\n')
    const { container } = render(<MarkdownText text={markdown} />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    const neutralized = [...container.querySelectorAll('p')]
      .find(paragraph => paragraph.textContent === 'script relative')
    expect(neutralized?.querySelector('a')).toBeNull()
    expect(screen.getByRole('link', { name: 'mail' }).getAttribute('target')).toBeNull()
    expect(screen.getByRole('link', { name: 'web' }).getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('link', { name: 'upper' }).getAttribute('target')).toBe('_blank')
    expect(screen.getByText('remote diagram')).toBeTruthy()
  })

  it('keeps incomplete streaming Markdown renderable', () => {
    const { container } = render(<MarkdownText text={'## Streaming\n\n- first\n- **unfinished'} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Streaming' })).toBeTruthy()
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByText('**unfinished')).toBeTruthy()
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
