import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Manifest, parseVendoredRows, render, tierExternalDeps } from './gen-third-party-notices.ts'

const root = resolve(import.meta.dirname, '..')

describe('THIRD_PARTY_NOTICES.md', () => {
  // Freshness lives here rather than in its own doc-sync gate: this spec file
  // already runs in the test lane, so the check costs no extra CI process.
  // Pre-commit regenerates the file whenever a manifest is staged, so reaching
  // this assertion means the notices were committed without that hook.
  it('matches what the generator produces from the current manifests', () => {
    expect(readFileSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), 'stale notices — run `pnpm run gen-third-party-notices`').toBe(render())
  })
})

/** Build the (manifests, names) pair `tierExternalDeps` consumes. */
function workspace(entries: Record<string, Manifest>): { manifests: Map<string, Manifest>; names: Set<string> } {
  const manifests = new Map(Object.entries(entries))
  const names = new Set<string>()
  for (const manifest of manifests.values()) {
    if (manifest.name !== undefined) names.add(manifest.name)
  }
  return { manifests, names }
}

describe('tierExternalDeps', () => {
  it('tiers by declaring area, not by the declaring section name', () => {
    const { manifests, names } = workspace({
      // Root tooling and test infrastructure never ship, whichever section declares them.
      'package.json': { dependencies: { 'root-runtime-looking': '^1' }, devDependencies: { 'lint-tool': '^1' } },
      'packages/support/loader-smoke/package.json': { name: '@deepseek-ai/dsh-loader-smoke', dependencies: { 'smoke-helper': '^1' } },
      'packages/client/test-runtime/package.json': { name: '@deepseek-ai/dsh-client-test-runtime', dependencies: { 'test-lib': '^1' } },
      'website/package.json': { devDependencies: { 'site-tool': '^1' } },
      // A plugin package's runtime dependency ships even when no app mounts it by default.
      'packages/mcp/mcp-client/package.json': { name: '@deepseek-ai/dsh-mcp-client', dependencies: { 'protocol-sdk': '^1' }, devDependencies: { 'protocol-fixture-server': '^1' } },
      'apps/cli/package.json': { name: '@deepseek-ai/dsh-cli', dependencies: { 'cli-lib': '^1', '@deepseek-ai/dsh-mcp-client': 'workspace:^' } },
    })

    expect(tierExternalDeps(manifests, names)).toEqual(new Map([
      ['tsx', true],
      ['root-runtime-looking', false],
      ['lint-tool', false],
      ['smoke-helper', false],
      ['test-lib', false],
      ['site-tool', false],
      ['protocol-sdk', true],
      ['protocol-fixture-server', false],
      ['cli-lib', true],
    ]))
  })

  it('keeps a package runtime when any shipping area declares it, and excludes workspace links', () => {
    const { manifests, names } = workspace({
      'package.json': { devDependencies: { shared: '^1' } },
      'packages/ui/tui/package.json': { name: '@deepseek-ai/dsh-tui', dependencies: { shared: '^1', '@deepseek-ai/dsh-cli': 'workspace:^' } },
      'apps/cli/package.json': { name: '@deepseek-ai/dsh-cli' },
    })

    expect(tierExternalDeps(manifests, names).get('shared')).toBe(true)
    expect(tierExternalDeps(manifests, names).has('@deepseek-ai/dsh-cli')).toBe(false)
  })
})

describe('parseVendoredRows', () => {
  it('reads the committed vendor manifest table', () => {
    const rows = parseVendoredRows(readFileSync(resolve(root, 'vendor/README.md'), 'utf8'))

    expect(rows.length).toBeGreaterThan(0)
    expect(rows).toContainEqual({ npmName: 'cordis', upstream: 'https://github.com/cordiverse/cordis' })
    // The upstream column carries a trailing package path for some rows; it is not part of the URL.
    expect(rows.every(row => /^https:\/\/\S+$/.test(row.upstream))).toBe(true)
  })

  it('yields nothing when the table shape changes, so the generator fails loud', () => {
    expect(parseVendoredRows('| `cordis/` | cordis | 4.0.0 | https://example.com | `abc123` |\n')).toEqual([])
  })
})
