import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectPythonDependencies, isPermissive, type Manifest, manifestPatterns, parsePyprojectRequirements, parseVendoredRows, render, tierExternalDeps } from './gen-third-party-notices.ts'

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

  it('covers every vendored directory, so no package can drop out of the notices', () => {
    const parsed = new Set(parseVendoredRows(readFileSync(resolve(root, 'vendor/README.md'), 'utf8')).map(row => row.npmName))
    const onDisk = readdirSync(resolve(root, 'vendor'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => (JSON.parse(readFileSync(resolve(root, 'vendor', entry.name, 'package.json'), 'utf8')) as Manifest).name)

    expect([...onDisk].sort()).toEqual([...parsed].sort())
  })
})

describe('parsePyprojectRequirements', () => {
  it('reads the committed manifests', () => {
    expect(parsePyprojectRequirements(readFileSync(resolve(root, 'python/sdk/pyproject.toml'), 'utf8'))).toContain('pydantic')
  })

  it('locates requirement arrays by TOML table, so author-named groups are not missed', () => {
    expect(parsePyprojectRequirements([
      '[build-system]',
      'requires = ["hatchling>=1.24.0"]',
      '',
      '[project]',
      'name = "not-a-requirement"',
      'dependencies = ["pydantic>=2.12"]',
      '',
      '[project.optional-dependencies]',
      'cli = ["click"]',
      '',
      '[dependency-groups]',
      'docs = ["sphinx>=7"]',
      '',
      '[tool.hatch.build.targets.wheel]',
      'packages = ["src/deepseek_harness"]',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
    ].join('\n'))).toEqual(['hatchling', 'pydantic', 'click', 'sphinx'])
  })

  it('does not truncate an array at a bracket inside extras', () => {
    expect(parsePyprojectRequirements('[project]\ndependencies = ["httpx[http2]", "requests"]\n'))
      .toEqual(['httpx', 'requests'])
  })

  it('reads names whether or not requirements carry versions, extras, or markers', () => {
    expect(parsePyprojectRequirements("[project]\ndependencies = [\"pydantic>=2.12\", \"requests\", \"httpx[http2]\", \"tomli ; python_version < '3.11'\", \"hatchling >= 1.24.0\"]\n"))
      .toEqual(['pydantic', 'requests', 'httpx', 'tomli', 'hatchling'])
  })

  it('reads single-quoted TOML literals and rejects an unreadable requirement', () => {
    expect(parsePyprojectRequirements("[project]\ndependencies = ['requests', \"pydantic>=2\"]\n")).toEqual(['requests', 'pydantic'])
    expect(() => parsePyprojectRequirements('[project]\ndependencies = ["!!broken"]\n')).toThrow(/cannot read a distribution name/)
  })

  it('reads a multi-line array', () => {
    expect(parsePyprojectRequirements('[project]\ndependencies = [\n  "pydantic>=2.12",\n  "typing-extensions",\n]\n'))
      .toEqual(['pydantic', 'typing-extensions'])
  })

  it('obeys TOML comments, quoted keys, and escaped strings', () => {
    expect(parsePyprojectRequirements([
      '[project] # a legal header comment',
      'dependencies = [',
      '  "pydantic", # ] does not close the array',
      '  # "old-package" is not a dependency',
      '  "tomli; python_version < \'3.11\'",',
      ']',
      '',
      '[dependency-groups]',
      '"test.docs" = ["pytest"]',
    ].join('\n'))).toEqual(['pydantic', 'tomli', 'pytest'])
  })

  it('accepts dependency-group includes and rejects unsupported requirement shapes', () => {
    expect(parsePyprojectRequirements('[dependency-groups]\nbase = ["pytest"]\nall = [{ include-group = "base" }]\n'))
      .toEqual(['pytest'])
    expect(() => parsePyprojectRequirements('[project]\ndependencies = "pytest"\n')).toThrow(/must be an array/)
    expect(() => parsePyprojectRequirements('[dependency-groups]\ntest = [{ unknown = "pytest" }]\n')).toThrow(/unsupported requirement entry/)
  })
})

describe('collectPythonDependencies', () => {
  it('excludes normalized local project names without exempting a third-party prefix', () => {
    const pyprojects = [
      '[project]\nname = "deepseek-harness-runtime-bin"\ndependencies = ["pydantic"]\n',
      '[project]\nname = "deepseek-harness"\ndependencies = ["DeepSeek.Harness_Runtime-Bin", "deepseek-unrelated"]\n',
    ]
    expect(() => collectPythonDependencies(pyprojects)).toThrow(
      'python dependency deepseek-unrelated is missing from PYTHON_METADATA',
    )
  })
})

describe('isPermissive', () => {
  it('accepts the licenses this project ships and rejects copyleft or unknown ones', () => {
    expect(['MIT', 'ISC', 'BSD-3-Clause', 'Apache-2.0', 'MIT / Apache-2.0', '(MIT OR CC0-1.0)'].every(isPermissive)).toBe(true)
    expect(['LGPL-3.0-only', 'MPL-2.0', 'GPL-3.0-or-later', 'SEE LICENSE IN LICENSE'].some(isPermissive)).toBe(false)
  })

  it('requires every operand of an AND, so a copyleft conjunct cannot ride along', () => {
    expect(isPermissive('(MIT OR Apache-2.0) AND GPL-3.0-only')).toBe(false)
    expect(isPermissive('MIT AND ISC')).toBe(true)
    // An exception clause is not a recognized identifier, so it fails closed.
    expect(isPermissive('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(false)
  })

  it('honors grouping and SPDX precedence', () => {
    expect(isPermissive('MIT OR (GPL-3.0-only AND GPL-2.0-only)')).toBe(true)
    expect(isPermissive('(MIT OR Apache-2.0) AND ISC')).toBe(true)
  })

  it('fails closed for malformed expressions, additions, and exceptions', () => {
    expect(['MIT)', '((MIT', '(MIT OR GPL-3.0-only', 'MIT OR OR GPL-3.0-only'].some(isPermissive)).toBe(false)
    expect(isPermissive('MIT+')).toBe(false)
    expect(isPermissive('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(false)
  })
})

describe('manifestPatterns', () => {
  it('derives globs from the declared members, so a new member area is read', () => {
    expect(manifestPatterns(['packages/*/*', 'tools/*'], ['packages/*'])).toEqual([
      'package.json',
      'packages/*/*/package.json',
      'tools/*/package.json',
      'examples/*/package.json',
      'native/landlock-run/package.json',
      'native/landlock-run/packages/*/package.json',
    ])
  })
})
