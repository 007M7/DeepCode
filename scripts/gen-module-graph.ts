/**
 * Generate (and verify) the module dependency graph in docs/module-graph.md.
 *
 * The architectural shape of the harness lives implicitly in each package's
 * `peerDependencies` — the canonical runtime-dependency signal (devDeps mirror
 * these as `workspace:^` plus test-only extras, which would add noise). This
 * script reads every `packages/* /* /package.json`, keeps only the
 * `@deepseek-ai/dsh-*` peer edges (dropping the `cordis` peer), and renders a
 * GitHub-viewable Mermaid graph grouped by `packages/<group>/` plus a
 * dependency table.
 *
 * The file is fully generated — never hand-edit it. Output is deterministic
 * (packages and edges sorted) so a regenerate-and-diff freshness check is
 * stable.
 *
 *   `tsx scripts/gen-module-graph.ts`          → write docs/module-graph.md
 *   `tsx scripts/gen-module-graph.ts --check`  → exit 1 if the committed file
 *                                                is stale (CI / pre-push gate)
 */

import { dirname, resolve } from 'node:path'
import { globSync, readFileSync, writeFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/module-graph.md'
const SCOPE = '@deepseek-ai/dsh-'

interface Pkg {
  /** Short name, `@deepseek-ai/dsh-` prefix stripped (e.g. `agent-loop`). */
  short: string
  /** Package group from `packages/<group>/<pkg>`. */
  group: string
  /** Repo-relative package directory. */
  rel: string
  /** Short names of this package's in-repo peer dependencies, sorted. */
  deps: string[]
}

const GROUP_ORDER = [
  'util',
  'llm',
  'core',
  'bash',
  'fs',
  'compact',
  'subagent',
  'web',
  'todo',
  'hooks',
  'session-persistence',
  'support',
  'ui',
]

/** Read every workspace package and its `@deepseek-ai/dsh-*` peer edges. */
function collect(): Pkg[] {
  const pkgs: Pkg[] = []
  for (const rel of globSync('packages/*/*/package.json', { cwd: root })) {
    const json = JSON.parse(readFileSync(resolve(root, rel), 'utf8')) as {
      name: string
      peerDependencies?: Record<string, string>
    }
    if (!json.name.startsWith(SCOPE)) continue
    const deps = Object.keys(json.peerDependencies ?? {})
      .filter(d => d.startsWith(SCOPE))
      .map(d => d.slice(SCOPE.length))
      .sort()
    const [, group, leaf] = rel.split('/')
    if (group === undefined || leaf === undefined) throw new Error(`gen-module-graph: unexpected package path ${rel}`)
    pkgs.push({ short: json.name.slice(SCOPE.length), group, rel: dirname(rel), deps })
  }
  return topoSort(pkgs)
}

/**
 * Order packages low-level → high-level: a package appears only after every
 * package it depends on. Kahn-style layering with an alphabetical tiebreak
 * within each layer, so the output stays deterministic (the freshness check
 * compares whole-file). The graph is a DAG, so this always terminates; a cycle
 * would leave nodes unplaced and throw.
 */
function topoSort(pkgs: Pkg[]): Pkg[] {
  const remaining = new Map(pkgs.map(p => [p.short, p]))
  const placed = new Set<string>()
  const out: Pkg[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter(p => p.deps.every(d => placed.has(d)))
      .sort(comparePackages)
    if (ready.length === 0) throw new Error(`gen-module-graph: dependency cycle among ${[...remaining.keys()].join(', ')}`)
    for (const p of ready) {
      out.push(p)
      placed.add(p.short)
      remaining.delete(p.short)
    }
  }
  return out
}

function comparePackages(a: Pkg, b: Pkg): number {
  const groupA = GROUP_ORDER.indexOf(a.group)
  const groupB = GROUP_ORDER.indexOf(b.group)
  const normA = groupA === -1 ? Number.MAX_SAFE_INTEGER : groupA
  const normB = groupB === -1 ? Number.MAX_SAFE_INTEGER : groupB
  return normA - normB || a.group.localeCompare(b.group) || a.short.localeCompare(b.short)
}

function nodeId(prefix: string, value: string): string {
  return `${prefix}_${value.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

function escLabel(value: string): string {
  return value.replace(/"/g, '\\"')
}

function packageLink(pkg: Pkg): string {
  return `[\`${pkg.short}\`](../${pkg.rel})`
}

/** Render the full docs/module-graph.md content (pure, deterministic). */
function render(pkgs: Pkg[]): string {
  const edges: string[] = []
  for (const p of pkgs) {
    for (const d of p.deps) edges.push(`  ${nodeId('pkg', p.short)} --> ${nodeId('pkg', d)}`)
  }
  const byShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  const groups = [...new Set(pkgs.map(pkg => pkg.group))].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a)
    const ib = GROUP_ORDER.indexOf(b)
    const na = ia === -1 ? Number.MAX_SAFE_INTEGER : ia
    const nb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib
    return na - nb || a.localeCompare(b)
  })
  const groupBlocks: string[] = []
  for (const group of groups) {
    groupBlocks.push(`  subgraph ${nodeId('group', group)}["packages/${escLabel(group)}"]`)
    for (const pkg of pkgs.filter(p => p.group === group).sort((a, b) => a.short.localeCompare(b.short))) {
      groupBlocks.push(`    ${nodeId('pkg', pkg.short)}["${escLabel(pkg.short)}"]`)
    }
    groupBlocks.push('  end')
  }
  const rows = pkgs.map((p) => {
    const deps = p.deps.length ? p.deps.map((d) => {
      const dep = byShort.get(d)
      return dep ? packageLink(dep) : `\`${d}\``
    }).join(', ') : '—'
    return `| ${packageLink(p)} | \`${p.group}\` | ${deps} |`
  })
  return [
    '<!-- Generated by scripts/gen-module-graph.ts — do not edit by hand.',
    '     Run `pnpm run gen-module-graph` to regenerate. -->',
    '',
    '# Module dependency graph',
    '',
    'Inter-package dependencies among the `@deepseek-ai/dsh-*` harness packages, derived from each package\'s `peerDependencies` (the canonical runtime-dependency signal) and grouped by the `packages/<group>/<pkg>` hierarchy. An edge `a --> b` means package `a` depends on package `b`. Names have the `@deepseek-ai/dsh-` prefix stripped.',
    '',
    '```mermaid',
    'flowchart TD',
    ...groupBlocks,
    ...edges,
    '```',
    '',
    '| Package | Group | Depends on |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

const content = render(collect())

if (process.argv.includes('--check')) {
  let committed: string | null = null
  try {
    committed = readFileSync(resolve(root, OUT), 'utf8')
  } catch {
    // Only an ENOENT (file not yet generated) is expected here; readFileSync of
    // a present-but-unreadable file is not a state this repo produces. Either
    // way the remedy is the same — regenerate — so we treat a read failure as
    // "stale" and fall through to the failure branch below.
    committed = null
  }
  if (committed === content) {
    console.log(`gen-module-graph: ${OUT} is up to date.`)
    process.exit(0)
  }
  console.error(`gen-module-graph: ${OUT} is stale. Run \`pnpm run gen-module-graph\` and commit ${OUT}.`)
  process.exit(1)
}

writeFileSync(resolve(root, OUT), content)
console.log(`gen-module-graph: wrote ${OUT}.`)
