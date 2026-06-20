/**
 * Negative-path tests for the cordis catalog generator (`scripts/gen-cordis-catalog.ts`).
 *
 * The generated catalog is frozen by a regenerate-and-diff freshness gate, so
 * the freshness half is exercised by `pnpm run verify-cordis-catalog` in CI.
 * What a freshness diff CANNOT prove is that the generator REJECTS malformed
 * source the way it promises to — a missing `@mode` tag, or a tag that
 * contradicts the signature shape. These tests drive `collectEvents()` against
 * synthetic fixture packages to prove each guard fires (and that a well-formed
 * event passes), mirroring the drift-guard negative tests for verify-type-equiv.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectEvents } from '../../../scripts/gen-cordis-catalog.ts'

/** Write a fixture package exposing one `interface Events` block and return the
 * scan root to hand `collectEvents`. */
function fixtureRoot(eventsBlock: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cordis-catalog-'))
  const dir = join(root, 'packages', 'fix', 'src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'index.ts'),
    `declare module 'cordis' {\n  interface Events {\n${eventsBlock}\n  }\n}\n`,
  )
  return root
}

const roots: string[] = []
const make = (block: string): string => {
  const r = fixtureRoot(block)
  roots.push(r)
  return r
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('gen-cordis-catalog collectEvents', () => {
  it('extracts a well-formed event with its @mode and JSDoc', () => {
    const events = collectEvents(make(
      '    /**\n     * A thing happened.\n     * @mode emit\n     */\n    \'fix/happened\'(id: string): void',
    ))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'fix/happened', scope: 'fix', mode: 'emit', doc: 'A thing happened.' })
  })

  it('classifies a trailing-next signature as a waterfall', () => {
    const events = collectEvents(make(
      '    /**\n     * Intercept it.\n     * @mode waterfall\n     */\n    \'fix/intercept\'(x: number, next: () => Promise<number>): Promise<number>',
    ))
    expect(events[0]?.mode).toBe('waterfall')
  })

  it('accepts a parallel (awaited, no next) event by trusting the tag', () => {
    const events = collectEvents(make(
      '    /**\n     * Flush.\n     * @mode parallel\n     */\n    \'fix/flush\'(): Promise<void> | void',
    ))
    expect(events[0]?.mode).toBe('parallel')
  })

  it('hard-errors when an event is missing its @mode tag', () => {
    expect(() => collectEvents(make(
      '    /** No mode here. */\n    \'fix/untagged\'(id: string): void',
    ))).toThrow(/missing an @mode tag/)
  })

  it('hard-errors when @mode contradicts a trailing-next (waterfall) shape', () => {
    expect(() => collectEvents(make(
      '    /**\n     * Mislabeled.\n     * @mode emit\n     */\n    \'fix/wrong\'(x: number, next: () => Promise<number>): Promise<number>',
    ))).toThrow(/trailing 'next' parameter .* tagged '@mode emit'/)
  })

  it('hard-errors when @mode waterfall has no trailing next to delegate to', () => {
    expect(() => collectEvents(make(
      '    /**\n     * Not actually a waterfall.\n     * @mode waterfall\n     */\n    \'fix/nonext\'(id: string): void',
    ))).toThrow(/tagged '@mode waterfall' but has no trailing 'next'/)
  })
})
