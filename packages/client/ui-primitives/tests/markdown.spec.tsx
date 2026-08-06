// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Extension } from 'micromark-util-types'
import { JsonBlock, MarkdownText, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import { remarkMathCompatibility } from '../src/markdown/remarkMathCompatibility.ts'

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
    // The ts fence routed through the shared CodeBlock: shiki token spans + banner.
    expect(container.querySelector('pre.shiki')).not.toBeNull()
    expect(screen.getByText('ts')).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
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

  it('forwards localized labels to fenced code blocks', () => {
    render(<MarkdownText text={'```ts\nconst answer = 42\n```'} codeLabels={{ copyLabel: 'Copy code', copiedLabel: 'Copied' }} />)
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
  })

  it('renders absolute HTTP(S) images with bounded presentation', () => {
    const markdown = [
      '![secure diagram](https://example.com/secure.png)',
      '![plain diagram](http://example.com/plain.png)',
    ].join('\n\n')
    const { container } = render(<MarkdownText text={markdown} />)
    const images = [...container.querySelectorAll('img')]
    expect(images.map(image => image.getAttribute('src'))).toEqual([
      'https://example.com/secure.png',
      'http://example.com/plain.png',
    ])
    for (const image of images) {
      expect(image.getAttribute('loading')).toBe('lazy')
      expect(image.getAttribute('decoding')).toBe('async')
      expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    }
  })

  it('neutralizes raw HTML, unsafe or relative links, and unsupported images', () => {
    const markdown = [
      '<script>globalThis.compromised = true</script>',
      '<img src="x" onerror="globalThis.compromised = true">',
      '[script](javascript:alert(1)) [relative](/settings)',
      '[mail](mailto:dev@example.com) [web](http://example.com) [upper](HTTPS://example.com)',
      '![relative diagram](private.png)',
      '![absolute diagram](/workspace/private.png)',
      '![file diagram](file:///workspace/private.png)',
      '![script diagram](javascript:alert(1))',
      '![mail diagram](mailto:dev@example.com)',
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
    expect(screen.getByText('relative diagram')).toBeTruthy()
    expect(screen.getByText('absolute diagram')).toBeTruthy()
    expect(screen.getByText('file diagram')).toBeTruthy()
    expect(screen.getByText('script diagram')).toBeTruthy()
    expect(screen.getByText('mail diagram')).toBeTruthy()
  })

  it('keeps incomplete streaming Markdown renderable', () => {
    const { container } = render(<MarkdownText text={'## Streaming\n\n- first\n- **unfinished'} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Streaming' })).toBeTruthy()
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByText('**unfinished')).toBeTruthy()
  })

  it('renders inline and display TeX through KaTeX without enabling trusted commands', () => {
    const source = [
      'Einstein wrote $E = mc^2$.',
      '',
      '$$',
      '\\frac{\\partial \\mathbf{u}}{\\partial t} + (\\mathbf{u} \\cdot \\nabla)\\mathbf{u} = -\\frac{1}{\\rho}\\nabla p',
      '$$',
      '',
      '$\\href{javascript:alert(1)}{unsafe}$',
    ].join('\n')
    const { container } = render(<MarkdownText text={source} />)

    expect(container.querySelectorAll('.katex')).toHaveLength(3)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(container.querySelector('.katex-display annotation')?.textContent).toContain('\\frac{\\partial \\mathbf{u}}')
    expect(container.querySelector('a')).toBeNull()
  })

  it('renders common TeX delimiters and same-line tagged display blocks after the reply settles', () => {
    const source = [
      'Inline dollar $\\theta$ and backslash \\(\\frac{1}{5}\\).',
      '',
      '\\[\\frac{\\pi}{4} < \\theta < \\frac{\\pi}{2}\\]',
      '',
      '$$\\theta \\in \\left(\\frac{\\pi}{4}, \\frac{\\pi}{2}\\right). \\tag{1}$$',
      '',
      '| Symbol | Value |',
      '| --- | --- |',
      '| $\\theta$ | \\(\\frac{1}{5}\\) |',
    ].join('\n')
    const { container } = render(<MarkdownText text={source} />)

    expect(container.querySelectorAll('.katex')).toHaveLength(6)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(2)
    expect(container.querySelector('.katex-display annotation')?.textContent).toContain('\\frac{\\pi}{4}')
    expect([...container.querySelectorAll('.katex-display')].at(-1)?.querySelector('annotation')?.textContent)
      .toContain('\\tag{1}')
    expect(container.querySelector('.katex-error')).toBeNull()
    expect(container.querySelector('table .katex')).not.toBeNull()
  })

  it('keeps backslash delimiters correct across Markdown boundaries and malformed candidates', () => {
    const cases = [
      {
        source: '\\(\\alpha \\, \\beta\\)',
        math: 1,
        display: 0,
      },
      {
        source: String.raw`\\\(x\)`,
        math: 1,
        display: 0,
        value: 'x',
      },
      {
        source: '\\(\\frac{1}{5}\n+\\frac{1}{7}\\)',
        math: 1,
        display: 0,
        value: '\\frac{1}{5}\n+\\frac{1}{7}',
      },
      {
        source: '\\[a\\\\\nb\\]',
        math: 1,
        display: 1,
        value: 'a\\\\\nb',
      },
      {
        source: '> \\[\n> \\frac{1}{5}\n> \\]',
        math: 1,
        display: 1,
      },
      {
        source: '- \\[\n  \\frac{1}{5}\n  \\]',
        math: 1,
        display: 1,
      },
    ]

    for (const item of cases) {
      const rendered = render(<MarkdownText text={item.source} />)
      expect(rendered.container.querySelectorAll('.katex')).toHaveLength(item.math)
      expect(rendered.container.querySelectorAll('.katex-display')).toHaveLength(item.display)
      expect(rendered.container.querySelector('.katex-error')).toBeNull()
      if ('value' in item) {
        expect(rendered.container.querySelector('annotation')?.textContent).toBe(item.value)
      }
      rendered.unmount()
    }

    const literal = render(<MarkdownText text={'\\\\(x\\)\n\n\\[x'} />)
    expect(literal.container.querySelectorAll('.katex')).toHaveLength(0)
    expect(literal.container.querySelector('.katex-display')).toBeNull()
    expect(literal.container.textContent).toContain('[x')
  })

  it('keeps ordinary dollar blocks and incomplete delimiter candidates parseable', () => {
    const cases = [
      { source: '$$\n\\theta\n$$', math: 1, display: 1 },
      { source: '$$$\\theta$$$', math: 1, display: 0 },
      { source: '$$a$b\nc', math: 0, display: 0 },
      { source: '  \\[\n  \\theta\n  \\]', math: 1, display: 1 },
      { source: '\\(\\theta', math: 0, display: 0 },
      { source: String.raw`\(a\\)`, math: 0, display: 0 },
      { source: '\\[\n\\[', math: 0, display: 0 },
      { source: '> \\[\nnot a quoted continuation\n\\]', math: 0, display: 0 },
    ]

    for (const item of cases) {
      const rendered = render(<MarkdownText text={item.source} />)
      expect(rendered.container.querySelectorAll('.katex')).toHaveLength(item.math)
      expect(rendered.container.querySelectorAll('.katex-display')).toHaveLength(item.display)
      expect(rendered.container.querySelector('.katex-error')).toBeNull()
      rendered.unmount()
    }
  })

  it('lets display math interrupt an open paragraph', () => {
    for (const source of ['Prose line\n\\[x\\]', 'Prose line\n$$x$$']) {
      const rendered = render(<MarkdownText text={source} />)
      expect(rendered.container.querySelectorAll('p')).toHaveLength(1)
      expect(rendered.container.querySelectorAll('.katex-display')).toHaveLength(1)
      rendered.unmount()
    }
  })

  it('leaves a dollar block with trailing text to upstream inline math', () => {
    const { container } = render(<MarkdownText text="$$x$$ trailing" />)

    expect(container.querySelectorAll('.katex')).toHaveLength(1)
    expect(container.querySelector('.katex-display')).toBeNull()
    expect(container.querySelector('annotation')?.textContent).toBe('x')
    expect(container.textContent).toContain('trailing')
  })

  it('renders escaped dollars and even backslash pairs before closing fences', () => {
    const source = [
      String.raw`$$100\$$$`,
      '',
      String.raw`\(a\\\)`,
      '',
      String.raw`\[b\\\]`,
    ].join('\n')
    const { container } = render(<MarkdownText text={source} />)
    const values = [...container.querySelectorAll('annotation')].map(node => node.textContent)

    expect(values).toEqual([String.raw`100\$`, String.raw`a\\`, String.raw`b\\`])
    expect(container.querySelector('.katex-error')).toBeNull()
  })

  it('bounds fallback work for repeated unclosed backslash delimiters', () => {
    const startedAt = performance.now()
    const { container } = render(<MarkdownText text={'\\(x '.repeat(6_400)} />)

    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(container.querySelector('.katex')).toBeNull()
  })

  it('leaves TeX-looking fenced code literal', () => {
    const source = '```tex\n\\[\\frac{1}{5}\\]\n$$x \\tag{1}$$\n```'
    const { container } = render(<MarkdownText text={source} />)

    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('pre code')?.textContent).toContain('\\[\\frac{1}{5}\\]')
    expect(container.querySelector('pre code')?.textContent).toContain('$$x \\tag{1}$$')
  })

  it('registers the compatibility extension on a bare remark processor', () => {
    const data: { micromarkExtensions?: Extension[] } = {}
    remarkMathCompatibility.call({ data: () => data })

    expect(data.micromarkExtensions).toHaveLength(1)
  })

  it('defers TeX rendering while streaming so incomplete formulas never flash KaTeX errors', () => {
    const partial = '$$\n\\frac{\\partial \\mathbf{u}}{\\partial'
    const complete = '$$\n\\frac{\\partial \\mathbf{u}}{\\partial t}\n$$'
    const live = render(<MarkdownText text={partial} streaming />)

    expect(live.container.querySelector('.katex')).toBeNull()
    expect(live.container.querySelector('.katex-error')).toBeNull()
    expect(live.container.textContent).toContain('\\frac{\\partial \\mathbf{u}}{\\partial')

    live.rerender(<MarkdownText text={complete} />)
    expect(live.container.querySelectorAll('.katex')).toHaveLength(1)
    expect(live.container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(live.container.querySelector('.katex-error')).toBeNull()
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
    const body = container.querySelector('pre')!.textContent
    expect(body.length).toBeLessThan(30_000)
    expect(body).toContain('截断')
  })
})
