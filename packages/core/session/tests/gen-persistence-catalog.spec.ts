/**
 * Negative-path tests for the persistence log catalog generator
 * (`scripts/gen-persistence-catalog.ts`).
 *
 * The generated catalog is frozen by a regenerate-and-diff freshness gate, so
 * the freshness half is exercised by `pnpm run verify-persistence-catalog` in
 * CI. What a freshness diff CANNOT prove is that the generator REJECTS
 * malformed source the way it promises to — a member without description
 * prose, a forbidden `@mode` tag, a non-literal member name, a duplicate event
 * declaration, a missing or ambiguous `SurfaceEventType` union, a stale union
 * member. These tests drive the exported collectors against synthetic fixture
 * packages to prove each guard fires (and that well-formed declarations pass),
 * mirroring the gen-cordis-catalog negative tests.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  annotateSurface,
  collectLogEvents,
  collectSurfaceEventTypes,
  render,
} from '../../../../scripts/gen-persistence-catalog.ts'

/** Create a fixture scan root; `files` maps `packages/…`-relative paths to source. */
function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'persistence-catalog-'))
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, source)
  }
  return root
}

const roots: string[] = []
const make = (files: Record<string, string>): string => {
  const r = fixtureRoot(files)
  roots.push(r)
  return r
}

/** A merge-form declaration file wrapping `members` in the session module. */
const merge = (members: string): string =>
  `declare module '@deepseek-ai/dsh-session' {\n  interface SessionEventMap {\n${members}\n  }\n}\n`

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('gen-persistence-catalog collectLogEvents', () => {
  it('extracts a documented member of the owning top-level interface', () => {
    const events = collectLogEvents(make({
      'packages/core/fix/src/types.ts':
        'export interface SessionEventMap {\n  /** A thing was recorded. */\n  \'fix/happened\': { turn: number }\n}\n',
    }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'fix/happened',
      scope: 'fix',
      doc: 'A thing was recorded.',
      payload: '{ turn: number }',
      source: 'packages/core/fix/src/types.ts:3',
    })
  })

  it('extracts a member declaration-merged via the session module', () => {
    const events = collectLogEvents(make({
      'packages/group/fix/src/types.ts': merge('    /** Merged provenance. */\n    \'fix/merged\': { id: string }'),
    }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'fix/merged', doc: 'Merged provenance.' })
  })

  it('collapses a newline-separated multi-line payload to a valid one-line fragment', () => {
    const events = collectLogEvents(make({
      'packages/group/fix/src/types.ts': merge(
        '    /** Wide payload. */\n    \'fix/wide\': {\n      alpha: string[]\n      range: { start: number; end: number }\n      count: number\n    }',
      ),
    }))
    expect(events[0]?.payload).toBe('{ alpha: string[]; range: { start: number; end: number }; count: number }')
  })

  it('hard-errors on a member with no description prose', () => {
    expect(() => collectLogEvents(make({
      'packages/group/fix/src/types.ts': merge('    \'fix/undocumented\': { turn: number }'),
    }))).toThrow(/no description prose/)
  })

  it('hard-errors on an @mode tag (a log event has no dispatch mode)', () => {
    expect(() => collectLogEvents(make({
      'packages/group/fix/src/types.ts': merge('    /**\n     * Documented, but mistagged.\n     * @mode emit\n     */\n    \'fix/tagged\': { turn: number }'),
    }))).toThrow(/carries an @mode tag/)
  })

  it('hard-errors on a non-literal member name', () => {
    expect(() => collectLogEvents(make({
      'packages/group/fix/src/types.ts': merge('    /** Not a literal. */\n    unquoted: { turn: number }'),
    }))).toThrow(/non-literal name/)
  })

  it('hard-errors when the same event is declared twice', () => {
    expect(() => collectLogEvents(make({
      'packages/group/fix/src/a.ts': merge('    /** First. */\n    \'fix/dup\': { turn: number }'),
      'packages/group/fix/src/b.ts': merge('    /** Second. */\n    \'fix/dup\': { turn: number }'),
    }))).toThrow(/already declared at packages\/group\/fix\/src\/a\.ts/)
  })

  it('aggregates every violation into one error instead of failing fast', () => {
    expect(() => collectLogEvents(make({
      'packages/group/fix/src/types.ts': merge('    \'fix/one\': { turn: number }\n    \'fix/two\': { turn: number }'),
    }))).toThrow(/2 JSDoc completeness violation\(s\)[\s\S]*fix\/one[\s\S]*fix\/two/)
  })
})

describe('gen-persistence-catalog collectSurfaceEventTypes', () => {
  it('parses the literal union', () => {
    const types = collectSurfaceEventTypes(make({
      'packages/core/fix/src/types.ts': 'export type SurfaceEventType = \'fix/a\' | \'fix/b\'\n',
    }))
    expect(types).toEqual(['fix/a', 'fix/b'])
  })

  it('hard-errors when no union is declared', () => {
    expect(() => collectSurfaceEventTypes(make({
      'packages/core/fix/src/types.ts': 'export const unrelated = 1\n',
    }))).toThrow(/no SurfaceEventType union found/)
  })

  it('hard-errors when the union is declared more than once', () => {
    expect(() => collectSurfaceEventTypes(make({
      'packages/core/fix/src/a.ts': 'export type SurfaceEventType = \'fix/a\'\n',
      'packages/core/fix/src/b.ts': 'export type SurfaceEventType = \'fix/b\'\n',
    }))).toThrow(/declared more than once/)
  })

  it('hard-errors on a non-string-literal union member', () => {
    expect(() => collectSurfaceEventTypes(make({
      'packages/core/fix/src/types.ts': 'export type SurfaceEventType = \'fix/a\' | number\n',
    }))).toThrow(/non-string-literal member/)
  })
})

describe('gen-persistence-catalog annotateSurface + render', () => {
  const entry = (name: string) => ({
    name,
    scope: name.split('/')[0] ?? name,
    payload: '{ turn: number }',
    doc: `Records ${name}.`,
    source: 'packages/core/fix/src/types.ts:3',
  })

  it('badges union members surface and everything else log-only', () => {
    const annotated = annotateSurface([entry('fix/message'), entry('fix/marker')], ['fix/message'])
    expect(annotated.map(e => [e.name, e.surface])).toEqual([['fix/message', true], ['fix/marker', false]])
  })

  it('hard-errors on a union member naming no declared event', () => {
    expect(() => annotateSurface([entry('fix/marker')], ['fix/ghost']))
      .toThrow(/'fix\/ghost' name no declared log event/)
  })

  it('renders badges, payload fences, and the generated-file header', () => {
    const out = render(annotateSurface([entry('fix/message'), entry('fix/marker')], ['fix/message']))
    expect(out).toContain('Generated by scripts/gen-persistence-catalog.ts')
    expect(out).toContain('#### `fix/message` — surface')
    expect(out).toContain('#### `fix/marker` — log-only')
    expect(out).toContain('```ts persistence-catalog\n\'fix/marker\': { turn: number }\n```')
  })
})
