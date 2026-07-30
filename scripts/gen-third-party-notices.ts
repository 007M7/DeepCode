/**
 * Generate `THIRD_PARTY_NOTICES.md` from the workspace manifests: every
 * external dependency named by a workspace `package.json`, the vendored-package
 * manifest in `vendor/README.md`, the Python `pyproject.toml` files, and the
 * pnpm patch list. License and repository metadata come from the installed
 * store, so the tree must be installed. `--check` verifies the committed
 * artifact. Tier policy and ownership live in
 * `.agents/notes/implemented/process/2026-07-30-generated-third-party-notices.md`.
 */

import { existsSync, globSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'

const root = resolve(import.meta.dirname, '..')
const OUT = 'THIRD_PARTY_NOTICES.md'

/** Dependency-declaration kinds a consumer resolves at runtime. */
const RUNTIME_KINDS = ['dependencies', 'optionalDependencies'] as const
/** All manifest sections that name an external package this file must disclose. */
const ALL_KINDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/**
 * Workspace areas that never reach a user: repository tooling and gates (the
 * root manifest), test infrastructure, the documentation site, the runnable
 * demo leaves, and the native launcher's build workspace. A runtime
 * declaration by anything outside these areas is a disclosure-relevant
 * runtime dependency, because `scripts/install.sh` installs the repository
 * itself and any plugin package can be mounted from a user's `cordis.yml`.
 */
const DEV_ONLY_AREAS = [
  'package.json',
  'packages/support/',
  'packages/client/test-runtime/',
  'website/',
  'examples/',
  'native/',
] as const

/**
 * First-party packages released from sibling repositories under the project's
 * own license: reachable from workspace manifests but not third-party.
 */
const FIRST_PARTY = new Set([
  'node-addon-landlock-run',
  'node-addon-landlock-run-linux-arm64',
  'node-addon-landlock-run-linux-x64',
])

/**
 * Metadata overrides where the installed manifest is wrong or unreachable.
 * Each entry documents why the store cannot answer.
 */
const OVERRIDES: Record<string, { license?: string; repo?: string }> = {
  // Rust workspaces publishing npm bins without `license` in package.json.
  'oxlint': { license: 'MIT', repo: 'https://github.com/oxc-project/oxc' },
  'oxlint-tsgolint': { license: 'MIT', repo: 'https://github.com/oxc-project/tsgolint' },
  // `license: SEE LICENSE IN LICENSE`: the servers repo is mid MIT→Apache-2.0
  // relicensing, so the effective terms are per-contribution.
  '@modelcontextprotocol/server-everything': { license: 'MIT / Apache-2.0', repo: 'https://github.com/modelcontextprotocol/servers' },
  '@modelcontextprotocol/server-filesystem': { license: 'MIT / Apache-2.0', repo: 'https://github.com/modelcontextprotocol/servers' },
  // No repository field in the published manifest.
  'node-addon-require-builtin': { repo: 'https://www.npmjs.com/package/node-addon-require-builtin' },
}

/**
 * Python dependencies are few and named directly in `pyproject.toml` files
 * without installed metadata to harvest, so license/repo are recorded here and
 * the generator fails when a manifest names a package this map misses.
 */
const PYTHON_METADATA: Record<string, { license: string; repo: string; role: string }> = {
  pydantic: { license: 'MIT', repo: 'https://github.com/pydantic/pydantic', role: 'runtime dependency of `deepseek-harness`' },
  hatchling: { license: 'MIT', repo: 'https://github.com/pypa/hatch', role: 'build backend' },
  pytest: { license: 'MIT', repo: 'https://github.com/pytest-dev/pytest', role: 'test-only' },
}

/** Tools fetched by scripts at build time, keyed by the pin the script owns. */
const BUILD_TIME_TOOLS = [
  {
    name: '@yao-pkg/pkg',
    license: 'MIT',
    repo: 'https://github.com/yao-pkg/pkg',
    role: 'invoked by `scripts/build-exe-for-python-sdk.ts` to assemble the single-file SDK runtime executable',
    pinSource: 'scripts/build-exe-for-python-sdk.ts',
  },
]

/** The `package.json` fields this generator reads. */
export interface Manifest {
  name?: string
  private?: boolean
  license?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** One disclosed external npm dependency. */
interface ExternalDep {
  name: string
  license: string
  repo: string
  /** True when some shipped workspace consumer reaches it through runtime dependency edges. */
  runtime: boolean
}

/** Read and parse a workspace-relative `package.json`. */
function readManifest(rel: string): Manifest {
  return JSON.parse(readFileSync(resolve(root, rel), 'utf8')) as Manifest
}

/** Every workspace manifest, keyed by path, plus the set of workspace package names. */
function loadWorkspaceManifests(): { manifests: Map<string, Manifest>; names: Set<string> } {
  // `native/landlock-run` is a nested workspace with its own lock file; its
  // leaf manifests live one level deeper than this repository's own tiers.
  const patterns = ['package.json', 'vendor/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json', 'website/package.json', 'examples/package.json', 'python/sdk-runtime/package.json', 'native/landlock-run/package.json', 'native/landlock-run/packages/*/package.json']
  const manifests = new Map<string, Manifest>()
  const names = new Set<string>()
  for (const pattern of patterns) {
    for (const path of globSync(pattern, { cwd: root })) {
      const manifest = readManifest(path)
      manifests.set(path, manifest)
      if (manifest.name !== undefined) names.add(manifest.name)
    }
  }
  if (manifests.size < 100) throw new Error(`gen-third-party-notices: only ${manifests.size} workspace manifests found; the glob set is stale.`)
  return { manifests, names }
}

/** License and repository URL for an installed external package, from the pnpm store. */
function installedMetadata(name: string): { license: string; repo: string } {
  const override = OVERRIDES[name]
  let manifest: (Manifest & { license?: string; repository?: string | { url?: string }; homepage?: string }) | undefined
  const direct = resolve(root, 'node_modules', name, 'package.json')
  if (existsSync(direct)) {
    manifest = JSON.parse(readFileSync(direct, 'utf8')) as typeof manifest
  } else {
    const prefix = `${name.replace('/', '+')}@`
    const entry = readdirSync(resolve(root, 'node_modules/.pnpm')).find(dir => dir.startsWith(prefix))
    if (entry !== undefined) {
      manifest = JSON.parse(readFileSync(resolve(root, 'node_modules/.pnpm', entry, 'node_modules', name, 'package.json'), 'utf8')) as typeof manifest
    }
  }
  const license = override?.license ?? manifest?.license
  const rawRepo = typeof manifest?.repository === 'string' ? manifest.repository : manifest?.repository?.url ?? manifest?.homepage
  const repo = override?.repo ?? normalizeRepo(rawRepo)
  if (license === undefined || repo === undefined) {
    throw new Error(`gen-third-party-notices: cannot resolve ${license === undefined ? 'license' : 'repository'} for ${name}; install the tree or add an OVERRIDES entry.`)
  }
  return { license, repo }
}

/** Normalize a manifest repository/homepage value to a browsable https URL. */
function normalizeRepo(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  let url = raw
    .replace(/^git\+ssh:\/\/git@/, 'https://')
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
  if (!url.startsWith('http')) url = `https://github.com/${url}`
  return url
}

/**
 * External npm dependencies, tiered by which workspace area declares them at
 * runtime: a package is runtime when any manifest outside `DEV_ONLY_AREAS`
 * names it in `dependencies`/`optionalDependencies`. A package declared only
 * by tooling, test infrastructure, the website, or the demo leaves — whatever
 * the declaring section is called — is development-only.
 */
function collectNpmDeps(): ExternalDep[] {
  const { manifests, names } = loadWorkspaceManifests()
  return [...tierExternalDeps(manifests, names)]
    .filter(([name]) => !FIRST_PARTY.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, runtime]) => ({ name, ...installedMetadata(name), runtime }))
}

/**
 * Tier every external dependency the workspace declares.
 * @param manifests - workspace manifests keyed by repository-relative path.
 * @param names - every workspace package name, which never counts as external.
 * @returns each external package mapped to whether it is a runtime dependency.
 */
export function tierExternalDeps(manifests: Map<string, Manifest>, names: Set<string>): Map<string, boolean> {
  const tiers = new Map<string, boolean>()
  // `tsx` is runtime by fiat: `bin/dsh` execs the CLI through its ESM hook.
  tiers.set('tsx', true)
  for (const [path, manifest] of manifests) {
    const devOnly = DEV_ONLY_AREAS.some(area => (area.endsWith('/') ? path.startsWith(area) : path === area))
    for (const kind of ALL_KINDS) {
      for (const [dep, range] of Object.entries(manifest[kind] ?? {})) {
        if (names.has(dep) || range.startsWith('workspace:')) continue
        const runtime = !devOnly && (RUNTIME_KINDS as readonly string[]).includes(kind)
        tiers.set(dep, (tiers.get(dep) ?? false) || runtime)
      }
    }
  }
  return tiers
}

/** A vendored package row parsed out of the `vendor/README.md` manifest table. */
export interface VendoredRow {
  npmName: string
  upstream: string
}

/**
 * Parse the vendored-package manifest table out of `vendor/README.md`.
 * @param text - the complete `vendor/README.md` contents.
 * @returns one row per manifest-table entry, in table order.
 */
export function parseVendoredRows(text: string): VendoredRow[] {
  const rows: VendoredRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\| \x60\S+\/\x60 \| \x60([^\x60]+)\x60 \| \S+ \| (https:\/\/\S+?)(?: \([^)]*\))? \| \x60[0-9a-f]+\x60 \|$/.exec(line)
    if (match === null) continue
    const [, npmName, upstream] = match
    if (npmName === undefined || upstream === undefined) continue
    rows.push({ npmName, upstream })
  }
  return rows
}

/**
 * Parse the vendored manifest table and confirm it accounts for every vendored
 * directory. The `vendor/` tree — not the table — is the set that must be
 * disclosed, so a row that stops matching the table format is a hard error
 * rather than a package that quietly vanishes from the notices.
 */
function collectVendored(): VendoredRow[] {
  const rows = parseVendoredRows(readFileSync(resolve(root, 'vendor/README.md'), 'utf8'))
  const onDisk = new Map<string, string>()
  for (const entry of readdirSync(resolve(root, 'vendor'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = readManifest(`vendor/${entry.name}/package.json`)
    if (manifest.name !== undefined) onDisk.set(manifest.name, entry.name)
  }

  const parsed = new Set(rows.map(row => row.npmName))
  const missing = [...onDisk.keys()].filter(name => !parsed.has(name))
  if (missing.length > 0) {
    throw new Error(`gen-third-party-notices: vendor/README.md has no manifest-table row for ${missing.join(', ')}; its table format changed or the sync is incomplete.`)
  }
  for (const row of rows) {
    const dir = onDisk.get(row.npmName)
    if (dir === undefined) throw new Error(`gen-third-party-notices: vendored package ${row.npmName} from vendor/README.md has no vendor/ directory.`)
    const license = readManifest(`vendor/${dir}/package.json`).license
    if (license !== 'MIT') {
      throw new Error(`gen-third-party-notices: vendored ${row.npmName} declares license ${JSON.stringify(license)}; the vendored section assumes MIT throughout.`)
    }
  }
  return rows
}

/**
 * Extract the distribution names from one `pyproject.toml` requirement array.
 * PEP 508 makes every part after the name optional, so a bare `"requests"` and
 * a marker-only `"requests; python_version < '3.11'"` must both be found.
 * @param block - the bracketed array text of a requirement list.
 * @returns each requirement's distribution name, in file order.
 */
export function parsePythonRequirements(block: string): string[] {
  const names: string[] = []
  for (const match of block.matchAll(/"\s*([a-zA-Z][a-zA-Z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@].*?)?"/g)) {
    const name = match[1]
    if (name !== undefined) names.push(name)
  }
  return names
}

/** Direct Python dependencies named by the `pyproject.toml` manifests under `python/`. */
function collectPython(): { name: string; license: string; repo: string; role: string }[] {
  const found = new Set<string>()
  for (const path of ['python/sdk/pyproject.toml', 'python/sdk-runtime/pyproject.toml']) {
    const text = readFileSync(resolve(root, path), 'utf8')
    // Requirement arrays only: `[project] name`/`readme` and `[tool.*]` string
    // values would otherwise read as dependencies.
    for (const block of text.matchAll(/(?:^|\n)\s*(?:requires|dependencies|test|dev|lint)\s*=\s*\[([^\]]*)\]/g)) {
      const body = block[1]
      if (body === undefined) continue
      for (const name of parsePythonRequirements(body)) {
        if (name.startsWith('deepseek')) continue
        found.add(name)
      }
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b)).map((name) => {
    const metadata = PYTHON_METADATA[name]
    if (metadata === undefined) throw new Error(`gen-third-party-notices: python dependency ${name} is missing from PYTHON_METADATA.`)
    return { name, ...metadata }
  })
}

/** pnpm-patched external packages, from `pnpm-workspace.yaml`. */
function collectPatched(): { spec: string; patch: string }[] {
  const workspace = yaml.load(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')) as { patchedDependencies?: Record<string, string> }
  return Object.entries(workspace.patchedDependencies ?? {}).map(([spec, patch]) => ({ spec, patch }))
}

/** Verify each build-time tool pin still appears in its owning script. */
function verifyBuildTimePins(): void {
  for (const tool of BUILD_TIME_TOOLS) {
    const text = readFileSync(resolve(root, tool.pinSource), 'utf8')
    if (!text.includes(tool.name)) {
      throw new Error(`gen-third-party-notices: ${tool.pinSource} no longer references ${tool.name}; update BUILD_TIME_TOOLS.`)
    }
  }
}

/** Render one npm dependency table. */
function renderNpmTable(deps: ExternalDep[]): string {
  const lines = ['| Package | License |', '| --- | --- |']
  for (const dep of deps) lines.push(`| [\`${dep.name}\`](${dep.repo}) | ${dep.license} |`)
  return lines.join('\n')
}

/**
 * Render the complete notices document.
 * @returns the exact bytes `THIRD_PARTY_NOTICES.md` must hold.
 */
export function render(): string {
  verifyBuildTimePins()
  const npm = collectNpmDeps()
  const runtimeDeps = npm.filter(dep => dep.runtime)
  const devDeps = npm.filter(dep => !dep.runtime)
  const vendored = collectVendored()
  const python = collectPython()
  const patched = collectPatched()

  const nonPermissiveDev = devDeps.filter(dep => dep.license.startsWith('LGPL') || dep.license.startsWith('MPL'))
  const patchedLines = patched.map(({ spec, patch }) => `- \`${spec}\` — [\`${patch}\`](${patch})`)

  return `<!-- Generated by scripts/gen-third-party-notices.ts — do not edit by hand.
     Run \`pnpm run gen-third-party-notices\` to regenerate. -->

# Third-Party Notices

DeepSeek Harness is licensed under [BSD 3-Clause](LICENSE). It depends on the third-party open-source software listed below. Each project remains under its own license; nothing in this file changes those terms.

This file lists **direct** dependencies declared by the workspace. It is generated from the workspace manifests by \`scripts/gen-third-party-notices.ts\`: a pre-commit hook regenerates it whenever a manifest changes, and \`scripts/gen-third-party-notices.spec.ts\` asserts in the test lane that the committed bytes match. Run \`pnpm run verify-third-party-notices\` for the standalone check.

The complete npm transitive closure, with exact pinned versions, is recorded in [\`pnpm-lock.yaml\`](pnpm-lock.yaml) — inspect it with \`pnpm licenses list\`. The Python closure is recorded in [\`python/sdk/uv.lock\`](python/sdk/uv.lock), and the Landlock launcher workspace keeps its own in [\`native/landlock-run/pnpm-lock.yaml\`](native/landlock-run/pnpm-lock.yaml).

## Vendored source (\`vendor/\`)

The Cordis framework and its foundation libraries are source-vendored into this repository rather than consumed from npm. All are MIT-licensed; each directory preserves its upstream \`LICENSE\` file. Exact upstream commits and local modifications are recorded in [\`vendor/README.md\`](vendor/README.md).

| Package | Upstream | License |
| --- | --- | --- |
${vendored.map(row => `| \`${row.npmName}\` | [${row.upstream.replace('https://', '')}](${row.upstream}) | MIT |`).join('\n')}

## Runtime npm dependencies

External packages that a workspace package resolves at runtime. \`scripts/install.sh\` installs this repository itself, so the tier covers every plugin a user can mount from \`cordis.yml\` — not only what the \`dsh\` CLI/TUI, the Web UI, and the Python SDK runtime load by default.

${renderNpmTable(runtimeDeps)}

pnpm applies local patches to the following packages at install time, so shipped artifacts carry modified copies; each patch file is the complete record of the modification:

${patchedLines.join('\n')}

## Development-only npm dependencies

External packages declared only by repository tooling, test infrastructure, the documentation site, the demo leaves, or the native launcher's build workspace. They are not part of any shipped runtime artifact.

${renderNpmTable(devDeps)}

${nonPermissiveDev.map(dep => `\`${dep.name}\` (${dep.license})`).join(' and ')} run only as development tooling; their code is not linked into or distributed with any DeepSeek Harness artifact.

## Python SDK dependencies (\`python/\`)

Direct dependencies of the \`pyproject.toml\` manifests, plus \`uv\` as the development workflow tool.

| Package | License | Role |
| --- | --- | --- |
${python.map(dep => `| [\`${dep.name}\`](${dep.repo}) | ${dep.license} | ${dep.role} |`).join('\n')}
| [\`uv\`](https://github.com/astral-sh/uv) | MIT / Apache-2.0 | development workflow tool |

## Fetched at build time

| Package | License | Role |
| --- | --- | --- |
${BUILD_TIME_TOOLS.map(tool => `| [\`${tool.name}\`](${tool.repo}) | ${tool.license} | ${tool.role} |`).join('\n')}

## First-party sibling releases

\`node-addon-landlock-run\` (and its platform packages) is released from a DeepSeek Harness sibling repository under BSD 3-Clause. It is listed here for completeness; it is first-party, not third-party.
`
}

/** CLI entry: default writes the notices, `--check` fails if the committed copy
 * is stale. Guarded behind an entry-point check so importing this module for
 * tests neither regenerates the committed file nor calls process.exit. */
function main(): void {
  const content = render()
  if (process.argv.includes('--check')) {
    let committed: string | null = null
    try {
      committed = readFileSync(resolve(root, OUT), 'utf8')
    } catch {
      // Only ENOENT (not yet generated) is expected; a present-but-unreadable
      // file is not a state this repo produces, and the remedy is the same.
      committed = null
    }
    if (committed === content) {
      console.log(`gen-third-party-notices: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-third-party-notices: ${OUT} is stale. Run \`pnpm run gen-third-party-notices\` and commit ${OUT}.`)
    process.exit(1)
  }

  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-third-party-notices: wrote ${OUT}.`)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main()
}
