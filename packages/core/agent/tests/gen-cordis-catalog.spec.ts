/**
 * Negative-path tests for the cordis catalog generator (`scripts/gen-cordis-catalog.ts`).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectEvents, collectServices } from '../../../../scripts/gen-cordis-catalog.ts'

/** Write a fixture package exposing one `interface Events` block and return the
 * scan root to hand `collectEvents`. */
function fixtureRoot(eventsBlock: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cordis-catalog-'))
  const dir = join(root, 'packages', 'group', 'fix', 'src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'index.ts'),
    `declare module 'cordis' {\n  interface Events {\n${eventsBlock}\n  }\n}\n`,
  )
  return root
}

/** Write a fixture package exposing one `interface Context` entry (`ctx.fix` →
 * `FixService`) plus the class source, and return the scan root to hand
 * `collectServices`. */
function serviceFixtureRoot(classSource: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cordis-catalog-'))
  const dir = join(root, 'packages', 'group', 'fix', 'src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'index.ts'),
    `declare module 'cordis' {\n  interface Context {\n    fix: FixService\n  }\n}\n\n${classSource}\n`,
  )
  return root
}

const roots: string[] = []
const make = (block: string): string => {
  const r = fixtureRoot(block)
  roots.push(r)
  return r
}
const makeService = (classSource: string): string => {
  const r = serviceFixtureRoot(classSource)
  roots.push(r)
  return r
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('gen-cordis-catalog collectEvents', () => {
  it('extracts a well-formed event with its @mode and JSDoc', () => {
    const events = collectEvents(make(
      '    /**\n     * A thing happened.\n     * @param id - which thing.\n     * @mode emit\n     */\n    \'fix/happened\'(id: string): void',
    ))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'fix/happened', scope: 'fix', mode: 'emit', doc: 'A thing happened.' })
  })

  it('classifies a trailing-next signature as a waterfall', () => {
    const events = collectEvents(make(
      '    /**\n     * Intercept it.\n     * @param x - the value under interception.\n     * @mode waterfall\n     */\n    \'fix/intercept\'(x: number, next: () => Promise<number>): Promise<number>',
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
      '    /** No mode here. */\n    \'fix/untagged\'(): void',
    ))).toThrow(/missing an @mode tag/)
  })

  it('hard-errors when @mode contradicts a trailing-next (waterfall) shape', () => {
    expect(() => collectEvents(make(
      '    /**\n     * Mislabeled.\n     * @param x - the value.\n     * @mode emit\n     */\n    \'fix/wrong\'(x: number, next: () => Promise<number>): Promise<number>',
    ))).toThrow(/trailing 'next' parameter .* tagged '@mode emit'/)
  })

  it('hard-errors when @mode waterfall has no trailing next to delegate to', () => {
    expect(() => collectEvents(make(
      '    /**\n     * Not actually a waterfall.\n     * @param id - which thing.\n     * @mode waterfall\n     */\n    \'fix/nonext\'(id: string): void',
    ))).toThrow(/tagged '@mode waterfall' but has no trailing 'next'/)
  })

  it('hard-errors on an undocumented payload parameter', () => {
    expect(() => collectEvents(make(
      '    /**\n     * A thing happened.\n     * @mode emit\n     */\n    \'fix/happened\'(id: string): void',
    ))).toThrow(/is missing @param id/)
  })

  it('hard-errors on a stale @param naming no real parameter', () => {
    expect(() => collectEvents(make(
      '    /**\n     * A thing happened.\n     * @param id - which thing.\n     * @param ghost - not a parameter.\n     * @mode emit\n     */\n    \'fix/happened\'(id: string): void',
    ))).toThrow(/@param ghost does not match any parameter/)
  })

  it('hard-errors on an @param with an empty description', () => {
    expect(() => collectEvents(make(
      '    /**\n     * A thing happened.\n     * @param id\n     * @mode emit\n     */\n    \'fix/happened\'(id: string): void',
    ))).toThrow(/@param id has an empty description/)
  })

  it('hard-errors on an event whose JSDoc has no description prose', () => {
    expect(() => collectEvents(make(
      '    /**\n     * @param id - which thing.\n     * @mode emit\n     */\n    \'fix/happened\'(id: string): void',
    ))).toThrow(/no description prose/)
  })

  it('exempts the `this` receiver and the trailing waterfall `next` from @param', () => {
    const events = collectEvents(make(
      '    /**\n     * Scoped interception.\n     * @param x - the value under interception.\n     * @mode waterfall\n     */\n    \'fix/scoped\'(this: object, x: number, next: () => Promise<number>): Promise<number>',
    ))
    expect(events).toHaveLength(1)
  })

  it('hard-errors on a binding-pattern parameter @param cannot name', () => {
    expect(() => collectEvents(make(
      '    /**\n     * A thing happened.\n     * @mode emit\n     */\n    \'fix/destructured\'({ id }: { id: string }): void',
    ))).toThrow(/is a binding pattern/)
  })

  it('aggregates every violation into one error instead of failing fast', () => {
    expect(() => collectEvents(make(
      '    /** First. */\n    \'fix/one\'(): void\n    /** Second. */\n    \'fix/two\'(): void',
    ))).toThrow(/2 JSDoc completeness violation\(s\)[\s\S]*fix\/one[\s\S]*fix\/two/)
  })
})

describe('gen-cordis-catalog collectServices', () => {
  const WELL_FORMED = `/** Fixture service. */
export class FixService {
  /**
   * Do the thing.
   * @param id - which thing to do.
   * @returns the outcome of doing it.
   */
  run(id: string): string { return id }

  /** Fire and forget (void needs no @returns). */
  poke(): void {}

  /** Flush (Promise<void> needs no @returns either). */
  flush(): Promise<void> { return Promise.resolve() }
}`

  it('extracts a well-formed service with its methods and class JSDoc', () => {
    const services = collectServices(makeService(WELL_FORMED))
    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({ key: 'fix', type: 'FixService', abstract: false, doc: 'Fixture service.' })
    expect(services[0]?.methods).toHaveLength(3)
  })

  it('hard-errors on a public method with no JSDoc at all', () => {
    expect(() => collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  run(id: string): string { return id }\n}',
    ))).toThrow(/ctx\.fix\.run .* has no JSDoc/)
  })

  it('hard-errors on an undocumented method parameter', () => {
    expect(() => collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  /**\n   * Do the thing.\n   * @returns the outcome.\n   */\n  run(id: string): string { return id }\n}',
    ))).toThrow(/ctx\.fix\.run .* is missing @param id/)
  })

  it('hard-errors on a missing @returns for a non-void return type', () => {
    expect(() => collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  /**\n   * Do the thing.\n   * @param id - which thing.\n   */\n  run(id: string): string { return id }\n}',
    ))).toThrow(/is missing @returns \(return type: string\)/)
  })

  it('hard-errors on an unannotated (inferred) return type', () => {
    expect(() => collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  /**\n   * Do the thing.\n   * @param id - which thing.\n   */\n  run(id: string) { return id }\n}',
    ))).toThrow(/no return type annotation/)
  })

  it('hard-errors on a service class with no JSDoc', () => {
    expect(() => collectServices(makeService(
      'export class FixService {\n  /** Fire and forget. */\n  poke(): void {}\n}',
    ))).toThrow(/class FixService has no JSDoc/)
  })

  it('hard-errors on a stale method @param', () => {
    expect(() => collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  /**\n   * Fire and forget.\n   * @param ghost - not a parameter.\n   */\n  poke(): void {}\n}',
    ))).toThrow(/@param ghost does not match any parameter/)
  })

  it('hard-errors on a method whose JSDoc is tags with no description prose', () => {
    expect(() => collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  /**\n   * @param id - which thing.\n   * @returns the outcome.\n   */\n  run(id: string): string { return id }\n}',
    ))).toThrow(/no description prose above its block tags/)
  })

  it('hard-errors on a method @param with an empty description', () => {
    expect(() => collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  /**\n   * Fire and forget.\n   * @param id\n   */\n  poke(id: string): void {}\n}',
    ))).toThrow(/@param id has an empty description/)
  })

  it('hard-errors on an @returns with an empty description', () => {
    expect(() => collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  /**\n   * Do the thing.\n   * @param id - which thing.\n   * @returns\n   */\n  run(id: string): string { return id }\n}',
    ))).toThrow(/@returns has an empty description/)
  })

  it('hard-errors on a binding-pattern method parameter @param cannot name', () => {
    expect(() => collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  /**\n   * Do the thing.\n   */\n  run({ id }: { id: string }): void {}\n}',
    ))).toThrow(/is a binding pattern/)
  })

  it('ignores private/protected/static members (not the ctx.<key> surface)', () => {
    const services = collectServices(makeService(
      '/** Fixture service. */\nexport class FixService {\n  private hidden(id: string): string { return id }\n  protected hook(): void {}\n  static helper(): void {}\n}',
    ))
    expect(services[0]?.methods).toHaveLength(0)
  })
})
