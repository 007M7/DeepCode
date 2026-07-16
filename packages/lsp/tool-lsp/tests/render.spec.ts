import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import {
  DEFAULT_MAX_HOVER_CHARS,
  DEFAULT_MAX_LOCATIONS,
  formatHover,
  formatLocations,
  LSP_OPERATIONS,
  parseLspArgs,
  presentLspCall,
  renderUri,
} from '@deepseek-ai/dsh-tool-lsp'
import type { LspLocation } from '@deepseek-ai/dsh-lsp'

const WS = '/home/u/proj'

function loc(uri: string, line: number, character = 0): LspLocation {
  return { uri, range: { start: { line, character }, end: { line, character: character + 1 } } }
}

describe('parseLspArgs', () => {
  it('accepts the four operations and converts one-based to zero-based', () => {
    for (const operation of LSP_OPERATIONS) {
      const input = parseLspArgs({ operation, file_path: 'a.ts', line: 3, character: 5 })
      expect(input.operation).toBe(operation)
      expect(input.position).toEqual({ line: 2, character: 4 })
    }
  })

  it('rejects an unknown operation', () => {
    expect(() => parseLspArgs({ operation: 'rename', file_path: 'a.ts', line: 1, character: 1 }))
      .toThrow(/operation must be one of/)
  })

  it('rejects a blank file_path', () => {
    expect(() => parseLspArgs({ operation: 'hover', file_path: '   ', line: 1, character: 1 }))
      .toThrow(/file_path/)
  })

  it('rejects non-positive or non-integer coordinates', () => {
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 0, character: 1 })).toThrow(/line/)
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 1, character: 0 })).toThrow(/character/)
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 1.5, character: 1 })).toThrow(/line/)
  })
})

describe('renderUri', () => {
  it('relativizes a file: URI inside the workspace with forward slashes', () => {
    const uri = pathToFileURL(join(WS, 'src', 'a.ts')).href
    expect(renderUri(uri, WS)).toBe('src/a.ts')
  })

  it('returns an absolute path for a file: URI outside the workspace', () => {
    const uri = pathToFileURL('/other/lib/b.ts').href
    expect(renderUri(uri, WS)).toBe('/other/lib/b.ts')
  })

  it('renders the workspace root itself as "."', () => {
    expect(renderUri(pathToFileURL(WS).href, WS)).toBe('.')
  })

  it('keeps a non-file URI verbatim', () => {
    expect(renderUri('untitled:Untitled-1', WS)).toBe('untitled:Untitled-1')
    expect(renderUri('jdt://contents/Foo.class', WS)).toBe('jdt://contents/Foo.class')
  })

  it('keeps a malformed file: URI verbatim when it cannot be parsed to a path', () => {
    // A file: URI with a host that fileURLToPath rejects falls through to the verbatim path.
    expect(renderUri('file://host/notlocal', WS)).toBe('file://host/notlocal')
  })
})

describe('formatLocations', () => {
  it('renders a no-result line for an empty list', () => {
    expect(formatLocations([], WS, DEFAULT_MAX_LOCATIONS)).toBe('No results.')
  })

  it('renders one-based path:line:character grouped by file', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatLocations([loc(a, 0, 0), loc(a, 4, 2)], WS, DEFAULT_MAX_LOCATIONS)
    expect(text).toBe('a.ts:1:1\na.ts:5:3')
  })

  it('caps at maxLocations and marks the omission', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const many = Array.from({ length: 5 }, (_, i) => loc(a, i))
    const text = formatLocations(many, WS, 2)
    expect(text).toContain('a.ts:1:1')
    expect(text).toContain('3 more locations omitted (limit 2).')
  })

  it('uses the singular omission marker for exactly one extra', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatLocations([loc(a, 0), loc(a, 1)], WS, 1)
    expect(text).toContain('1 more location omitted (limit 1).')
  })
})

describe('formatHover', () => {
  it('renders a no-result line for null', () => {
    expect(formatHover(null, DEFAULT_MAX_HOVER_CHARS)).toBe('No hover information.')
  })

  it('returns short hover verbatim', () => {
    expect(formatHover({ contents: '```ts\nx: number\n```' }, DEFAULT_MAX_HOVER_CHARS)).toBe('```ts\nx: number\n```')
  })

  it('caps hover at maxHoverChars and marks truncation', () => {
    const text = formatHover({ contents: 'a'.repeat(50) }, 10)
    expect(text.startsWith('aaaaaaaaaa\n')).toBe(true)
    expect(text).toContain('hover truncated (limit 10 characters).')
  })
})

describe('presentLspCall', () => {
  it('is a generic search card with an operation/cursor title and a line location', () => {
    expect(presentLspCall({ operation: 'references', file_path: 'a.ts', line: 3, character: 7 })).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'LSP references a.ts:3:7',
      locations: [{ path: 'a.ts', line: 3 }],
    })
  })
})
