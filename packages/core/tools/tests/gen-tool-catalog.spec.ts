/**
 * Guarantee tests for the tool-schema catalog generator
 * (`scripts/gen-tool-catalog.ts`).
 *
 * The generated catalog is frozen by a regenerate-and-diff freshness gate, so
 * the freshness half is exercised by `pnpm run verify-tool-catalog` in CI. What
 * a freshness diff CANNOT prove is (a) that BOOTING the tool plugins yields the
 * shipped schema — the whole reason this generator boots instead of parsing
 * source (a runtime-spread enum resolves to its literal members) — and (b) that
 * the completeness guard REJECTS a tool package missing from the boot manifest,
 * the property that replaces the AST pass's "nothing silently omitted". These
 * tests drive the exported `collectToolCatalog` / `assertManifestComplete` /
 * `render` directly, mirroring the negative-path style of the cordis-catalog
 * generator tests.
 */

import { describe, expect, it } from 'vitest'
import {
  assertManifestComplete,
  collectToolCatalog,
  render,
  type ToolCatalog,
} from '../../../../scripts/gen-tool-catalog.ts'

/** JSON Schema shape enough to reach the values AST extraction can't. */
interface JsonSchema {
  type: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: string[]
  required?: string[]
}

describe('gen-tool-catalog collectToolCatalog', () => {
  it('boots every shipped tool package and harvests its model-facing schemas', async () => {
    const catalog = await collectToolCatalog()
    const names = catalog.flatMap(entry => entry.schemas.map(s => s.name)).sort()
    expect(names).toEqual(['bash', 'bash_kill', 'bash_output', 'edit', 'read', 'subagent', 'todo_write', 'web_fetch', 'web_search', 'write'])
    // Every tool carries a JSON-Schema `parameters` object (what the model sees).
    for (const entry of catalog) {
      for (const schema of entry.schemas) {
        expect((schema.parameters as unknown as JsonSchema).type).toBe('object')
      }
    }
  })

  it('resolves a runtime-spread enum to its literal members (the payoff over AST)', async () => {
    const catalog = await collectToolCatalog()
    const todo = catalog
      .flatMap(entry => entry.schemas)
      .find(s => s.name === 'todo_write')
    // `todo-todo` writes `enum: [...STATUSES]` — a source AST would see the
    // spread, not the values. Booting yields the shipped enum literals.
    const status = (((todo?.parameters as unknown as JsonSchema).properties?.todos)?.items)?.properties?.status
    expect(status?.enum).toEqual(['pending', 'in_progress', 'completed'])
  })

  it('attributes each package with a source pointer that names its index', async () => {
    const catalog = await collectToolCatalog()
    const bash = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-tool-bash')
    expect(bash?.source).toBe('packages/bash/tool-bash/src/index.ts')
  })

  it('records the shipped `subagent_fork` alias in a note (config-driven tool name)', async () => {
    // `tool-subagent`'s registered name is the load-time `toolName` config, so
    // the shipped agents surface this one package as both `subagent` and
    // `subagent_fork`. Booting yields only the default name; the note is how a
    // reader learns the fork alias the model also sees. Without it the catalog
    // would silently under-report the shipped tool surface.
    const catalog = await collectToolCatalog()
    const subagent = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-tool-subagent')
    expect(subagent?.schemas.map(s => s.name)).toEqual(['subagent'])
    expect(subagent?.note).toMatch(/subagent_fork/)
  })
})

describe('gen-tool-catalog assertManifestComplete', () => {
  it('passes when the manifest lists every on-disk tool package (the default)', () => {
    expect(() => { assertManifestComplete() }).not.toThrow()
  })

  it('throws, naming the omitted package, when a tool package is missing from the manifest', () => {
    // An empty manifest scanned against the real tree: every `tool-*` package
    // is unlisted, so the guard must fire and name them.
    expect(() => { assertManifestComplete([]) }).toThrow(/not in the boot manifest/)
    expect(() => { assertManifestComplete([]) }).toThrow(/tool-bash/)
  })
})

describe('gen-tool-catalog render', () => {
  it('emits a package heading, a tool heading, and a json schema fence', () => {
    const catalog: ToolCatalog = [
      {
        pkg: '@deepseek-ai/dsh-tool-demo',
        source: 'packages/demo/tool-demo/src/index.ts',
        requires: ['ctx.tools'],
        writes: ['tool/result'],
        schemas: [{ name: 'demo', description: 'A demo tool.', parameters: { type: 'object', properties: {} } }],
      },
    ]
    const md = render(catalog)
    expect(md).toContain('| `@deepseek-ai/dsh-tool-demo` | `demo` | `ctx.tools` | `tool/result` |')
    expect(md).toContain('## `@deepseek-ai/dsh-tool-demo`')
    expect(md).toContain('### `demo`')
    expect(md).toContain('A demo tool.')
    expect(md).toContain('```json')
    expect(md).toContain('Source: [`packages/demo/tool-demo/src/index.ts`]')
  })
})
