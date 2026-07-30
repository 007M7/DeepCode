/**
 * Unit tests for the search-card presentation layer (`src/presentation.ts`): the
 * canonical value → `presentationMeta` projections (`grepSearchMeta`,
 * `globSearchMeta`, `groupMatchesByFile`) and the defensive `meta` → view
 * narrowing (`searchViewFromMeta`). These pin the by-file grouping, the inline
 * cap and `truncated`/`total` honesty, and the malformed-metadata fallback a
 * replayed or hand-edited log can deliver.
 */

import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  globSearchMeta,
  grepSearchMeta,
  groupMatchesByFile,
  searchViewFromMeta,
} from '../src/presentation.ts'
import type { GrepMatch } from '../src/grep.ts'

const match = (path: string, lineNumber: number, line: string): GrepMatch => ({ path, lineNumber, line })

describe('groupMatchesByFile', () => {
  it('groups matches by first-seen file order, keeping line/lineNumber only', () => {
    expect(groupMatchesByFile([
      match('b.ts', 2, 'x'),
      match('a.ts', 1, 'y'),
      match('b.ts', 5, 'z'),
    ])).toEqual([
      { path: 'b.ts', matches: [{ lineNumber: 2, line: 'x' }, { lineNumber: 5, line: 'z' }] },
      { path: 'a.ts', matches: [{ lineNumber: 1, line: 'y' }] },
    ])
  })

  it('returns an empty list for no matches', () => {
    expect(groupMatchesByFile([])).toEqual([])
  })
})

describe('grepSearchMeta', () => {
  it('projects grouped matches with total and a false truncation flag within the cap', () => {
    const meta = grepSearchMeta([match('a.ts', 1, 'one'), match('a.ts', 2, 'two')], 10, 2000)
    expect(meta).toEqual({
      kind: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'one' }, { lineNumber: 2, line: 'two' }] }],
      truncated: false,
      total: 2,
    })
  })

  it('caps the retained matches and reports the pre-cap total when truncated', () => {
    const meta = grepSearchMeta([match('a.ts', 1, 'one'), match('a.ts', 2, 'two'), match('b.ts', 3, 'three')], 2, 2000)
    expect(meta).toEqual({
      kind: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'one' }, { lineNumber: 2, line: 'two' }] }],
      truncated: true,
      total: 3,
    })
  })

  it('applies the per-line preview budget (UTF-8 boundary) to the projected line', () => {
    const meta = grepSearchMeta([match('a.txt', 1, 'aéaéaéaé')], 10, 7)
    expect(meta).toMatchObject({ kind: 'matches', files: [{ path: 'a.txt', matches: [{ lineNumber: 1, line: 'aéaéa (line truncated)' }] }] })
  })
})

describe('globSearchMeta', () => {
  it('projects the path list with total and a false truncation flag within the cap', () => {
    expect(globSearchMeta(['a.ts', 'b.ts'], 10)).toEqual({ kind: 'paths', paths: ['a.ts', 'b.ts'], truncated: false, total: 2 })
  })

  it('caps the retained paths and reports the pre-cap total when truncated', () => {
    expect(globSearchMeta(['a.ts', 'b.ts', 'c.ts'], 2)).toEqual({ kind: 'paths', paths: ['a.ts', 'b.ts'], truncated: true, total: 3 })
  })
})

describe('searchViewFromMeta (defensive narrowing)', () => {
  // The narrowing accepts an opaque JsonValue; a malformed payload is not a
  // statically-valid JsonValue, so route every case through one cast helper that
  // mirrors how a hand-edited/older session log delivers arbitrary shapes.
  const m = (value: unknown): JsonValue | undefined => value as JsonValue | undefined

  it('narrows a well-formed matches payload into a matches view', () => {
    const meta = { kind: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'x' }] }], truncated: true, total: 5 }
    expect(searchViewFromMeta(m(meta))).toEqual({ card: 'search', ...meta })
  })

  it('narrows a well-formed paths payload into a paths view', () => {
    const meta = { kind: 'paths', paths: ['a.ts', 'b.ts'], truncated: false, total: 2 }
    expect(searchViewFromMeta(m(meta))).toEqual({ card: 'search', ...meta })
  })

  it('rejects undefined / non-object / array meta', () => {
    expect(searchViewFromMeta(undefined)).toBeUndefined()
    expect(searchViewFromMeta(null)).toBeUndefined()
    expect(searchViewFromMeta(m('nope'))).toBeUndefined()
    expect(searchViewFromMeta(m([]))).toBeUndefined()
  })

  it('rejects a payload with a missing / mistyped truncated or total field', () => {
    expect(searchViewFromMeta(m({ kind: 'paths', paths: [], total: 0 }))).toBeUndefined()
    expect(searchViewFromMeta(m({ kind: 'paths', paths: [], truncated: 'no', total: 0 }))).toBeUndefined()
    expect(searchViewFromMeta(m({ kind: 'paths', paths: [], truncated: false }))).toBeUndefined()
    expect(searchViewFromMeta(m({ kind: 'paths', paths: [], truncated: false, total: '0' }))).toBeUndefined()
  })

  it('rejects an unknown or missing kind discriminant', () => {
    expect(searchViewFromMeta(m({ kind: 'other', truncated: false, total: 0 }))).toBeUndefined()
    expect(searchViewFromMeta(m({ truncated: false, total: 0 }))).toBeUndefined()
  })

  it('rejects a matches payload with a malformed files array', () => {
    const base = { kind: 'matches', truncated: false, total: 1 }
    expect(searchViewFromMeta(m({ ...base, files: 'x' }))).toBeUndefined()
    expect(searchViewFromMeta(m({ ...base, files: [null] }))).toBeUndefined()
    expect(searchViewFromMeta(m({ ...base, files: ['x'] }))).toBeUndefined()
    expect(searchViewFromMeta(m({ ...base, files: [[]] }))).toBeUndefined()
    expect(searchViewFromMeta(m({ ...base, files: [{ path: 1, matches: [] }] }))).toBeUndefined()
    expect(searchViewFromMeta(m({ ...base, files: [{ path: 'a', matches: 'x' }] }))).toBeUndefined()
    expect(searchViewFromMeta(m({ ...base, files: [{ path: 'a', matches: [null] }] }))).toBeUndefined()
    expect(searchViewFromMeta(m({ ...base, files: [{ path: 'a', matches: [{ lineNumber: '1', line: 'x' }] }] }))).toBeUndefined()
    expect(searchViewFromMeta(m({ ...base, files: [{ path: 'a', matches: [{ lineNumber: 1, line: 2 }] }] }))).toBeUndefined()
  })

  it('rejects a paths payload with a non-array or non-string-element paths field', () => {
    const base = { kind: 'paths', truncated: false, total: 1 }
    expect(searchViewFromMeta(m({ ...base, paths: 'x' }))).toBeUndefined()
    expect(searchViewFromMeta(m({ ...base, paths: [1] }))).toBeUndefined()
  })
})
