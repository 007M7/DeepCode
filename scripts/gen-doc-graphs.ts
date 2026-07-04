/**
 * Generate (and verify) the documentation graph atlas in docs/graphs/.
 *
 * This is the relationship layer above the existing catalogs:
 * - module-graph.md answers "which packages depend on which packages?"
 * - cordis-catalog/ answers "which events and services exist?"
 * - tool-catalog/ answers "which tools does the model see?"
 * - docs/graphs/ answers "how do those pieces fit together?"
 *
 * Generated pages discover the enumerable facts from source. Hybrid pages use
 * discovered inventory plus small manifests for policy that source cannot infer
 * (for example, whether a package is an implementation or consumer in a seam).
 * Curated pages are still emitted here so the atlas is one regenerated unit,
 * but their diagrams intentionally explain flow and ownership rather than
 * pretending to enumerate every source edge.
 *
 *   `tsx scripts/gen-doc-graphs.ts`          -> write docs/graphs/*.md
 *   `tsx scripts/gen-doc-graphs.ts --check`  -> exit 1 if any file is stale
 */

import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { collectEvents, collectServices } from './gen-cordis-catalog.ts'
import { collectToolCatalog } from './gen-tool-catalog.ts'

const root = resolve(import.meta.dirname, '..')
const OUT_DIR = 'docs/graphs'
const SCOPE = '@deepseek-ai/dsh-'

interface PkgJson {
  name: string
  peerDependencies?: Record<string, string>
}

interface Pkg {
  short: string
  name: string
  group: string
  rel: string
  deps: string[]
}

interface GraphDoc {
  rel: string
  content: string
}

interface ServiceRole {
  key: string
  pkg: string
  title: string
  mode: 'core' | 'seam' | 'bundle'
  implementations?: string[]
  consumers?: string[]
  companions?: string[]
  note: string
}

interface ExamplePlugin {
  id: string
  name: string
}

interface EventRelation {
  dispatchers: Map<string, Set<string>>
  listeners: Set<string>
}

interface ToolPackageMeta {
  requires: string[]
  writes: string[]
  shippedNames?: string[]
  note: string
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

const SERVICE_ROLES: ServiceRole[] = [
  {
    key: 'llm',
    pkg: 'llm',
    title: 'LLM adapter registry',
    mode: 'seam',
    implementations: ['llm-deepseek', 'llm-pi-ai', 'llm-replay'],
    consumers: ['agent-loop', 'compact-basic'],
    note: 'Adapters register provider implementations; the loop and compaction call the provider-neutral stream service.',
  },
  {
    key: 'sessions',
    pkg: 'session',
    title: 'In-memory session store',
    mode: 'core',
    consumers: ['agent-loop', 'agent', 'session-persistence', 'subagent-inprocess', 'invariants'],
    note: 'Owns append-only Session instances and emits the durable session event feed.',
  },
  {
    key: 'sessionPersistence',
    pkg: 'session-persistence',
    title: 'Durable session persistence seam',
    mode: 'seam',
    implementations: ['session-persistence-jsonl', 'session-persistence-sqlite'],
    consumers: ['agent-loop', 'acp'],
    note: 'Backends persist the same SessionEvent vocabulary; apps choose a backend at composition time.',
  },
  {
    key: 'systemPrompt',
    pkg: 'system-prompt',
    title: 'System prompt assembly registry',
    mode: 'core',
    consumers: ['agent-loop', 'tools', 'tool-fs', 'tool-web'],
    note: 'Collects prompt sections and model-facing tool schemas for each step.',
  },
  {
    key: 'tools',
    pkg: 'tools',
    title: 'Tool registry and execution waterfall',
    mode: 'core',
    consumers: ['agent-loop', 'tool-bash', 'tool-fs', 'tool-subagent', 'tool-todo', 'tool-web', 'acp'],
    note: 'Registers tool definitions, exposes schemas to the prompt, and routes calls through tools/pre-execute and tools/post-execute.',
  },
  {
    key: 'agents',
    pkg: 'agent',
    title: 'Agent registry',
    mode: 'core',
    consumers: ['agent-loop', 'acp', 'subagent-inprocess', 'stdio-agent', 'invariants'],
    note: 'Owns live Agent handles and the create/resume factory seam.',
  },
  {
    key: 'agentLoop',
    pkg: 'agent-loop',
    title: 'Concrete loop driver',
    mode: 'bundle',
    consumers: ['agent-core'],
    note: 'The one concrete loop plugin; extension packages depend on dsh-agent events and services, not on this package.',
  },
  {
    key: 'bash',
    pkg: 'bash',
    title: 'Bash executor seam',
    mode: 'seam',
    implementations: ['bash-local'],
    consumers: ['tool-bash', 'hooks-claude', 'hooks-codex'],
    note: 'The model-facing bash tools and hook bridges consume this seam; sandboxed or remote executors can replace bash-local.',
  },
  {
    key: 'fs',
    pkg: 'fs',
    title: 'Filesystem provider seam',
    mode: 'seam',
    implementations: ['fs-local'],
    consumers: ['tool-fs'],
    companions: ['fs-policy'],
    note: 'tool-fs executes read/write/edit through ctx.fs; fs-policy contributes observed-state checks through the fs/* event gate.',
  },
  {
    key: 'compact',
    pkg: 'compact',
    title: 'Compaction seam',
    mode: 'seam',
    implementations: ['compact-basic'],
    consumers: ['compact-basic'],
    note: 'The basic backend currently consumes the pre-step event directly; a model-facing compact tool remains deferred.',
  },
  {
    key: 'subagents',
    pkg: 'subagent',
    title: 'Subagent provider registry',
    mode: 'seam',
    implementations: ['subagent-spawn', 'subagent-fork', 'subagent-acp', 'subagent-mock'],
    consumers: ['tool-subagent'],
    note: 'Providers implement transports; tool-subagent exposes one configured provider as a model-facing tool name.',
  },
  {
    key: 'web',
    pkg: 'web',
    title: 'Web access provider registry',
    mode: 'seam',
    implementations: ['web-search-exa', 'web-search-perplexity', 'web-search-deepseek', 'web-fetch-local'],
    consumers: ['tool-web'],
    note: 'Search and fetch providers register into one ctx.web seam; tool-web owns the stable model-facing names.',
  },
]

const TOOL_PACKAGE_META: Record<string, ToolPackageMeta> = {
  '@deepseek-ai/dsh-tool-bash': {
    requires: ['ctx.tools', 'ctx.bash'],
    writes: ['tool/call', 'tool/result', 'context/message via agent.inject() for background completion notices'],
    note: 'The bash/bash_output/bash_kill tools are model-facing consumers of the bash executor seam.',
  },
  '@deepseek-ai/dsh-tool-fs': {
    requires: ['ctx.tools', 'ctx.fs', 'ctx.systemPrompt'],
    writes: ['tool/call', 'fs/write-intent or fs/edit-intent for mutations', 'fs/observed after successful file operations', 'tool/result'],
    note: 'read/write/edit are the model-facing filesystem tools; read windowing lives here, while read-before-edit policy is supplied by fs-policy through fs/* events.',
  },
  '@deepseek-ai/dsh-tool-subagent': {
    requires: ['ctx.tools', 'ctx.subagents'],
    writes: ['tool/call', 'tool/result', 'child session events through the chosen provider'],
    shippedNames: ['subagent', 'subagent_fork'],
    note: 'The default package schema registers subagent; shipped coding/acp configs load it twice to expose spawn and fork backends.',
  },
  '@deepseek-ai/dsh-tool-todo': {
    requires: ['ctx.tools', 'owning Agent session'],
    writes: ['tool/call', 'todo/write', 'tool/result'],
    note: 'todo_write is session-owned state; UIs render the latest todo/write event as a checklist or ACP plan.',
  },
  '@deepseek-ai/dsh-tool-web': {
    requires: ['ctx.tools', 'ctx.web', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    note: 'web_search and web_fetch keep provider selection behind ctx.web so model-visible schemas stay stable across backend swaps.',
  },
}

const DYNAMIC_EVENT_DISPATCHERS: Array<{ event: string; pkg: string; method: string }> = [
  // Subagent lifecycle events intentionally bypass ctx.emit and call
  // ctx.events.dispatch directly so one throwing listener cannot starve later
  // listeners or strand an already-started child run.
  { event: 'subagent/start', pkg: 'subagent', method: 'events.dispatch' },
  { event: 'subagent/end', pkg: 'subagent', method: 'events.dispatch' },
]

function generatedHeader(title: string, source: string): string[] {
  return [
    '<!-- Generated by scripts/gen-doc-graphs.ts - do not edit by hand.',
    '     Run `pnpm run gen-doc-graphs` to regenerate. -->',
    '',
    `# ${title}`,
    '',
    `Maintenance mode: ${source}.`,
    '',
  ]
}

function collectPackages(): Pkg[] {
  const pkgs: Pkg[] = []
  for (const rel of globSync('packages/*/*/package.json', { cwd: root }).sort()) {
    const json = JSON.parse(readFileSync(resolve(root, rel), 'utf8')) as PkgJson
    if (!json.name.startsWith(SCOPE)) continue
    const [, group, leaf] = rel.split('/')
    if (group === undefined || leaf === undefined) throw new Error(`gen-doc-graphs: unexpected package path ${rel}`)
    const deps = Object.keys(json.peerDependencies ?? {})
      .filter(dep => dep.startsWith(SCOPE))
      .map(dep => dep.slice(SCOPE.length))
      .sort()
    pkgs.push({
      short: json.name.slice(SCOPE.length),
      name: json.name,
      group,
      rel: dirname(rel),
      deps,
    })
  }
  return topoSort(pkgs)
}

function topoSort(pkgs: Pkg[]): Pkg[] {
  const remaining = new Map(pkgs.map(p => [p.short, p]))
  const placed = new Set<string>()
  const out: Pkg[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter(pkg => pkg.deps.every(dep => placed.has(dep)))
      .sort(comparePackages)
    if (ready.length === 0) throw new Error(`gen-doc-graphs: dependency cycle among ${[...remaining.keys()].join(', ')}`)
    for (const pkg of ready) {
      out.push(pkg)
      placed.add(pkg.short)
      remaining.delete(pkg.short)
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

function pkgLink(pkg: Pkg | undefined, fallback: string): string {
  return pkg ? `[\`${pkg.short}\`](../../${pkg.rel})` : `\`${fallback}\``
}

function pkgList(names: string[] | undefined, pkgsByShort: Map<string, Pkg>): string {
  if (!names || names.length === 0) return '-'
  return names.map(name => pkgLink(pkgsByShort.get(name), name)).join(', ')
}

function codeList(values: string[]): string {
  return values.length ? values.map(v => `\`${v}\``).join(', ') : '-'
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function renderMermaidPackageNode(pkg: Pkg): string {
  return `    ${nodeId('pkg', pkg.short)}["${escLabel(pkg.short)}"]`
}

function renderPackageTopology(pkgs: Pkg[]): string {
  const lines = generatedHeader('Package Topology By Group', 'generated from `packages/*/*/package.json` peer dependencies plus package group paths')
  lines.push(
    'This graph complements [module-graph.md](../module-graph.md): it keeps the same canonical peer-dependency edge source, but clusters packages by the `packages/<group>/<pkg>` hierarchy so layering and capability families are easier to scan.',
    '',
    '```mermaid',
    'flowchart TD',
  )
  const groups = [...new Set(pkgs.map(pkg => pkg.group))].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a)
    const ib = GROUP_ORDER.indexOf(b)
    const na = ia === -1 ? Number.MAX_SAFE_INTEGER : ia
    const nb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib
    return na - nb || a.localeCompare(b)
  })
  for (const group of groups) {
    lines.push(`  subgraph ${nodeId('group', group)}["packages/${escLabel(group)}"]`)
    for (const pkg of pkgs.filter(p => p.group === group).sort((a, b) => a.short.localeCompare(b.short))) {
      lines.push(renderMermaidPackageNode(pkg))
    }
    lines.push('  end')
  }
  for (const pkg of pkgs) {
    for (const dep of pkg.deps) lines.push(`  ${nodeId('pkg', pkg.short)} --> ${nodeId('pkg', dep)}`)
  }
  lines.push('```', '', '| Package | Group | Depends on |', '| --- | --- | --- |')
  const byShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  for (const pkg of pkgs) {
    lines.push(`| ${pkgLink(pkg, pkg.short)} | \`${pkg.group}\` | ${pkg.deps.length ? pkg.deps.map(dep => pkgLink(byShort.get(dep), dep)).join(', ') : '-'} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function assertServiceRolesComplete(): void {
  const discovered = new Set(collectServices().map(service => service.key))
  const classified = new Set(SERVICE_ROLES.map(role => role.key))
  const missing = [...discovered].filter(key => !classified.has(key)).sort()
  const stale = [...classified].filter(key => !discovered.has(key)).sort()
  if (missing.length || stale.length) {
    throw new Error([
      missing.length ? `missing service role classification: ${missing.join(', ')}` : '',
      stale.length ? `stale service role classification: ${stale.join(', ')}` : '',
    ].filter(Boolean).join('; '))
  }
}

function renderCapabilitySeams(pkgs: Pkg[]): string {
  assertServiceRolesComplete()
  const pkgsByShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  const nodes = new Map<string, string>()
  const edges = new Set<string>()
  const companionEdges = new Set<string>()
  const addNode = (id: string, label: string): void => {
    if (!nodes.has(id)) nodes.set(id, `  ${id}["${escLabel(label)}"]`)
  }
  const addEdge = (from: string, to: string): void => { edges.add(`  ${from} --> ${to}`) }
  const lines = generatedHeader('Capability Seams And Core Services', 'hybrid: services are discovered from Cordis declarations; interface/implementation/consumer roles are classified in `scripts/gen-doc-graphs.ts` with a completeness guard')
  lines.push(
    'A service can be a core spine service, a swappable capability seam, or a bundle/composition point. The graph shows the package that owns the service declaration, known implementation packages, and packages that consume the service directly.',
    '',
    '```mermaid',
    'flowchart LR',
  )
  for (const role of SERVICE_ROLES) {
    const svc = nodeId('svc', role.key)
    const owner = nodeId('pkg', role.pkg)
    addNode(owner, role.pkg)
    addNode(svc, `ctx.${role.key}<br/>${role.title}`)
    addEdge(owner, svc)
    for (const impl of role.implementations ?? []) {
      addNode(nodeId('pkg', impl), impl)
      addEdge(nodeId('pkg', impl), svc)
    }
    for (const consumer of role.consumers ?? []) {
      addNode(nodeId('pkg', consumer), consumer)
      addEdge(svc, nodeId('pkg', consumer))
    }
    for (const companion of role.companions ?? []) {
      addNode(nodeId('pkg', companion), companion)
      companionEdges.add(`  ${svc} -. event gate .-> ${nodeId('pkg', companion)}`)
    }
  }
  lines.push(...nodes.values(), ...[...edges].sort(), ...[...companionEdges].sort())
  lines.push('```', '', '| ctx key | Role | Owner | Implementations | Direct consumers | Companion plugins | Note |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const role of SERVICE_ROLES) {
    lines.push(`| \`ctx.${role.key}\` | \`${role.mode}\` | ${pkgLink(pkgsByShort.get(role.pkg), role.pkg)} | ${pkgList(role.implementations, pkgsByShort)} | ${pkgList(role.consumers, pkgsByShort)} | ${pkgList(role.companions, pkgsByShort)} | ${tableCell(role.note)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function parseExampleCordis(rel: string): ExamplePlugin[] {
  const text = readFileSync(resolve(root, rel), 'utf8')
  const plugins: ExamplePlugin[] = []
  let current: { id: string; name?: string } | null = null
  const flush = (): void => {
    if (current?.name) plugins.push({ id: current.id, name: current.name })
  }
  for (const line of text.split('\n')) {
    const id = /^-\s+id:\s+(.+?)\s*$/.exec(line)
    if (id?.[1] !== undefined) {
      flush()
      current = { id: stripYamlScalar(id[1]) }
      continue
    }
    const name = /^\s+name:\s+(.+?)\s*$/.exec(line)
    if (name?.[1] !== undefined && current) current.name = stripYamlScalar(name[1])
  }
  flush()
  return plugins
}

function stripYamlScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function renderAppComposition(): string {
  const examples = [
    { id: 'echo', label: 'examples/echo-agent', config: 'examples/echo-agent/cordis.yml' },
    { id: 'coding', label: 'examples/coding-agent', config: 'examples/coding-agent/cordis.yml' },
    { id: 'acp', label: 'examples/acp-agent', config: 'examples/acp-agent/cordis.yml' },
  ]
  const lines = generatedHeader('App Composition', 'hybrid: leaf plugin lists are parsed from `examples/*/cordis.yml`; bundle expansions are curated from app package source')
  lines.push(
    'This graph is for SDK users asking which pieces a runnable agent loads. Leaf configs choose adapters and optional product tools; app packages provide the front door; `dsh-agent-core` bundles the providerless spine.',
    '',
    '```mermaid',
    'flowchart LR',
  )
  const bundleTargets: Record<string, string> = {
    '@deepseek-ai/dsh-stdio-agent': nodeId('bundle', 'stdio'),
    '@deepseek-ai/dsh-acp-agent': nodeId('bundle', 'acp_agent'),
  }
  for (const example of examples) {
    lines.push(`  subgraph ${nodeId('example', example.id)}["${escLabel(example.label)}"]`)
    lines.push(`    ${nodeId('cfg', example.id)}["cordis.yml"]`)
    for (const plugin of parseExampleCordis(example.config)) {
      const pluginNode = nodeId(`plugin_${example.id}`, plugin.id)
      lines.push(`    ${pluginNode}["${escLabel(plugin.id)}<br/>${escLabel(plugin.name)}"]`)
      lines.push(`    ${nodeId('cfg', example.id)} --> ${pluginNode}`)
      const bundle = bundleTargets[plugin.name]
      if (bundle !== undefined) lines.push(`    ${pluginNode} --> ${bundle}`)
    }
    lines.push('  end')
  }
  lines.push(
    `  ${nodeId('bundle', 'stdio')}["@deepseek-ai/dsh-stdio-agent"] --> ${nodeId('bundle', 'agent_core')}["@deepseek-ai/dsh-agent-core"]`,
    `  ${nodeId('bundle', 'stdio')} --> ${nodeId('bundle', 'jsonl')}["@deepseek-ai/dsh-session-persistence-jsonl"]`,
    `  ${nodeId('bundle', 'stdio')} --> ${nodeId('bundle', 'ui_stdio')}["@deepseek-ai/dsh-ui-stdio"]`,
    `  ${nodeId('bundle', 'acp_agent')}["@deepseek-ai/dsh-acp-agent"] --> ${nodeId('bundle', 'agent_core')}`,
    `  ${nodeId('bundle', 'acp_agent')} --> ${nodeId('bundle', 'jsonl')}`,
    `  ${nodeId('bundle', 'acp_agent')} --> ${nodeId('bundle', 'acp')}["@deepseek-ai/dsh-acp"]`,
    `  ${nodeId('bundle', 'agent_core')} --> ${nodeId('spine', 'llm')}["ctx.llm"]`,
    `  ${nodeId('bundle', 'agent_core')} --> ${nodeId('spine', 'sessions')}["ctx.sessions"]`,
    `  ${nodeId('bundle', 'agent_core')} --> ${nodeId('spine', 'tools')}["ctx.tools + tool-bash"]`,
    `  ${nodeId('bundle', 'agent_core')} --> ${nodeId('spine', 'loop')}["ctx.agents + ctx.agentLoop"]`,
    '```',
    '',
    '| Example | Parsed plugin ids | Config |',
    '| --- | --- | --- |',
  )
  for (const example of examples) {
    const plugins = parseExampleCordis(example.config)
    lines.push(`| \`${example.label}\` | ${plugins.map(plugin => `\`${plugin.id}\``).join(', ')} | [\`${example.config}\`](../../${example.config}) |`)
  }
  lines.push('')
  return lines.join('\n')
}

function collectEventRelations(): Map<string, EventRelation> {
  const out = new Map<string, EventRelation>()
  const ensure = (event: string): EventRelation => {
    const existing = out.get(event)
    if (existing) return existing
    const next = { dispatchers: new Map<string, Set<string>>(), listeners: new Set<string>() }
    out.set(event, next)
    return next
  }
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: root }).sort()) {
    const [, , leaf] = rel.split('/')
    if (leaf === undefined) continue
    const text = readFileSync(resolve(root, rel), 'utf8')
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        if (!isCordisContextReceiver(node.expression, sf)) {
          ts.forEachChild(node, visit)
          return
        }
        if (method === 'on') {
          const event = eventArg(node.arguments, method)
          if (event) ensure(event).listeners.add(leaf)
        } else if (method === 'emit' || method === 'parallel' || method === 'serial' || method === 'waterfall') {
          const event = eventArg(node.arguments, method)
          if (event) {
            const relation = ensure(event)
            const methods = relation.dispatchers.get(leaf) ?? new Set<string>()
            methods.add(method)
            relation.dispatchers.set(leaf, methods)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  for (const entry of DYNAMIC_EVENT_DISPATCHERS) {
    const relation = ensure(entry.event)
    const methods = relation.dispatchers.get(entry.pkg) ?? new Set<string>()
    methods.add(entry.method)
    relation.dispatchers.set(entry.pkg, methods)
  }
  return out
}

function isCordisContextReceiver(expr: ts.PropertyAccessExpression, sf: ts.SourceFile): boolean {
  const target = expr.expression.getText(sf)
  return target === 'ctx' || target === 'this.ctx'
}

function eventArg(args: ts.NodeArray<ts.Expression>, method: string): string | undefined {
  if (method === 'waterfall') {
    const arg = args.find(ts.isStringLiteralLike)
    return arg?.text
  }
  const first = args[0]
  return first && ts.isStringLiteralLike(first) ? first.text : undefined
}

function relationPackages(map: Map<string, Set<string>>, pkgsByShort: Map<string, Pkg>): string {
  if (map.size === 0) return '-'
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, methods]) => `${pkgLink(pkgsByShort.get(pkg), pkg)} (${[...methods].sort().map(m => `\`${m}\``).join(', ')})`)
    .join(', ')
}

function listenerPackages(listeners: Set<string>, pkgsByShort: Map<string, Pkg>): string {
  if (listeners.size === 0) return '-'
  return [...listeners].sort().map(pkg => pkgLink(pkgsByShort.get(pkg), pkg)).join(', ')
}

function renderEventRelations(pkgs: Pkg[]): string {
  const events = collectEvents()
  const relations = collectEventRelations()
  const pkgsByShort = new Map(pkgs.map(pkg => [pkg.short, pkg]))
  const lines = generatedHeader('Event Producer And Consumer Matrix', 'hybrid generated: Cordis event declarations and most producer/listener edges are AST-scanned; dynamic dispatch sites are classified in `scripts/gen-doc-graphs.ts`')
  lines.push(
    'This matrix shows which packages dispatch each harness-owned event and which packages listen to it. It is intentionally a table rather than one large graph: events are many-to-many, and dense relation data is easier to review in rows. Dynamic dispatch overrides cover sites that deliberately bypass `ctx.emit`, such as subagent lifecycle containment.',
    '',
    '| Event | Mode | Declared in | Dispatchers | Listeners |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const event of [...events].sort((a, b) => a.name.localeCompare(b.name))) {
    const relation = relations.get(event.name) ?? { dispatchers: new Map<string, Set<string>>(), listeners: new Set<string>() }
    lines.push(`| \`${event.name}\` | \`${event.mode}\` | [\`${event.source}\`](../../${event.source.split(':')[0]}) | ${relationPackages(relation.dispatchers, pkgsByShort)} | ${listenerPackages(relation.listeners, pkgsByShort)} |`)
  }
  const declared = new Set(events.map(event => event.name))
  const extra = [...relations.keys()].filter(event => !declared.has(event)).sort()
  if (extra.length > 0) {
    lines.push('', '## Non-harness or undeclared event strings seen in package source', '', '| Event string | Dispatchers | Listeners |', '| --- | --- | --- |')
    for (const event of extra) {
      const relation = relations.get(event)
      if (!relation) continue
      lines.push(`| \`${event}\` | ${relationPackages(relation.dispatchers, pkgsByShort)} | ${listenerPackages(relation.listeners, pkgsByShort)} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

async function renderToolAffordance(): Promise<string> {
  const catalog = await collectToolCatalog()
  const lines = generatedHeader('Tool Affordance Map', 'hybrid: tool names/schemas are boot-harvested from shipped tool plugins; required services and shipped aliases are classified in `scripts/gen-doc-graphs.ts` with a completeness guard')
  for (const entry of catalog) {
    if (!TOOL_PACKAGE_META[entry.pkg]) {
      throw new Error(`gen-doc-graphs: tool package ${entry.pkg} is missing TOOL_PACKAGE_META classification`)
    }
  }
  lines.push(
    'This page connects the model-visible tools to the plugin packages and service seams behind them. For exact JSON Schemas, see [tool-catalog/tools.md](../tool-catalog/tools.md).',
    '',
    '```mermaid',
    'flowchart LR',
    '  model["Model request tools[]"]',
  )
  const requirementNodes = new Set<string>()
  for (const entry of catalog) {
    const meta = TOOL_PACKAGE_META[entry.pkg]
    if (!meta) continue
    const packageNode = nodeId('toolpkg', entry.pkg)
    const names = entry.schemas.map(schema => schema.name).join(', ')
    lines.push(`  ${packageNode}["${escLabel(entry.pkg.replace(SCOPE, ''))}<br/>${escLabel(names)}"]`)
    lines.push(`  model --> ${packageNode}`)
    for (const req of meta.requires) {
      const reqNode = nodeId('requires', req)
      if (!requirementNodes.has(reqNode)) {
        lines.push(`  ${reqNode}["${escLabel(req)}"]`)
        requirementNodes.add(reqNode)
      }
      lines.push(`  ${packageNode} --> ${reqNode}`)
    }
  }
  lines.push('```', '', '| Tool package | Model-visible names | Requires | Writes / affects | Shipped aliases | Note |', '| --- | --- | --- | --- | --- | --- |')
  for (const entry of catalog) {
    const meta = TOOL_PACKAGE_META[entry.pkg]
    if (!meta) continue
    lines.push(`| \`${entry.pkg}\` | ${codeList(entry.schemas.map(schema => schema.name))} | ${codeList(meta.requires)} | ${codeList(meta.writes)} | ${codeList(meta.shippedNames ?? [])} | ${tableCell(meta.note)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderLifecycle(): string {
  return [
    ...generatedHeader('Agent Turn And Step Lifecycle', 'curated Mermaid sequence; exact event signatures live in the generated Cordis catalog'),
    'This sequence is the visual companion to [architecture.md](../architecture.md#loop-lifecycle-session--turn--step). It keeps durable replay facts on `session/event` and live control/status on `agent/*`.',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant User',
    '  participant Agent',
    '  participant Driver',
    '  participant Hooks as hook listeners',
    '  participant Prompt as ctx.systemPrompt',
    '  participant LLM as ctx.llm',
    '  participant Tools as ctx.tools',
    '  participant Session',
    '  participant Persistence',
    '  participant SDK as UI or SDK listener',
    '  User->>Agent: send(content)',
    '  Agent-->>SDK: agent/queued',
    '  Agent->>Driver: queued work wakes driver',
    '  Driver-->>SDK: agent/status running',
    '  Driver->>Session: turn/start',
    '  Driver->>Hooks: agent/prompt-submit waterfall',
    '  Hooks-->>Driver: allow, block, or add context',
    '  Driver->>Session: user/message or rejected turn/end',
    '  Driver->>Prompt: system-prompt/assemble waterfall',
    '  Driver-->>Driver: agent/pre-step serial checkpoint',
    '  Driver->>Session: step/start',
    '  Driver->>LLM: agent/request waterfall, then llm/stream waterfall',
    '  LLM-->>Driver: StreamChunk*',
    '  Driver->>Session: assistant/chunk*',
    '  Session-->>SDK: session/event assistant/chunk*',
    '  Driver->>Hooks: agent/step-result waterfall',
    '  Driver->>Session: assistant/message',
    '  Driver->>Session: tool/call',
    '  Driver->>Tools: execute through pre and post waterfalls',
    '  Tools-->>Session: tool-owned events when applicable',
    '  Driver->>Session: tool/result and step/end',
    '  Driver->>Hooks: agent/turn-continuation waterfall',
    '  Driver->>Session: turn/end',
    '  Driver->>Persistence: session/flush parallel checkpoint',
    '  Driver-->>SDK: agent/status idle',
    '```',
    '',
    'SDK users that need replayable transcript data should consume `session/event`; `agent/*` is the live coordination surface for queue/status, prompt interception, request shaping, steering, continuation, and errors.',
    '',
  ].join('\n')
}

function renderToolPipeline(): string {
  return [
    ...generatedHeader('Tool Execution Pipeline', 'curated Mermaid flow; exact tool schemas and event signatures live in generated catalogs'),
    'This graph shows where policy, hooks, sandboxing, filesystem guards, result rewriting, and UI rendering fit without changing the loop. The key extension points are the `tools/pre-execute` and `tools/post-execute` waterfalls.',
    '',
    '```mermaid',
    'flowchart TD',
    '  model["Assistant message contains tool-call block"]',
    '  toolCall["Session event: tool/call<br/>logged before execution"]',
    '  presentCall["UI pending card<br/>presentCall(args)"]',
    '  pre["tools/pre-execute waterfall<br/>hooks, permission, sandbox"]',
    '  denied["deny or ask<br/>tool body skipped"]',
    '  toolBody["Registered tool execute() body"]',
    '  fsGate["fs/write-intent or fs/edit-intent<br/>tool-fs mutations only"]',
    '  owned["Tool-owned session events<br/>todo/write, fs/observed, hook/invoked, hook/result"]',
    '  post["tools/post-execute waterfall<br/>accept, block, replace, add context"]',
    '  context["Buffered additionalContext<br/>context/message after all tool results"]',
    '  toolResult["Session event: tool/result<br/>single model-facing outcome"]',
    '  presentResult["UI completed card<br/>presentResult(args, result)"]',
    '  model --> toolCall',
    '  toolCall --> presentCall',
    '  toolCall --> pre',
    '  pre -->|allow| toolBody',
    '  pre -->|deny or ask| denied',
    '  denied --> post',
    '  toolBody --> fsGate',
    '  fsGate --> toolBody',
    '  toolBody --> owned',
    '  toolBody --> post',
    '  post --> context',
    '  post --> toolResult',
    '  toolResult --> presentResult',
    '```',
    '',
    'Filesystem read-before-edit checks live below `tool-fs` on the `fs/*` event gate, while hook bridges and future permission prompts live on the generic tool waterfalls. That split lets the same hooks observe bash, fs, web, todo, and subagent calls without coupling those tools to one policy service.',
    '',
  ].join('\n')
}

function renderSessionSurface(): string {
  return [
    ...generatedHeader('Session Surface And Message Projection', 'curated Mermaid dataflow; exact event/type shapes live in core-data-structures'),
    'This graph separates the append-only log from the derived message surface the next model request sees.',
    '',
    '```mermaid',
    'flowchart LR',
    '  append["Session.append(type, data)"]',
    '  log["Append-only SessionEvent log"]',
    '  surface["SurfaceManager linked list<br/>surfaceOp + sourceEventSeqs"]',
    '  derive["deriveMessages()"]',
    '  model["GenerateOptions.messages"]',
    '  persist["JSONL / SQLite persistence"]',
    '  replay["load / replay / fork seed"]',
    '  append --> log',
    '  log --> surface',
    '  surface --> derive --> model',
    '  log --> persist --> replay --> log',
    '```',
    '',
    'See [core-data-structures/session.md](../core-data-structures/session.md) for the full `SessionEventMap`, surface operations, and turn-enclosure invariant.',
    '',
  ].join('\n')
}

function renderSubagentLineage(): string {
  return [
    ...generatedHeader('Subagent And Session Lineage', 'curated Mermaid flow; provider inventory is visible in the generated capability seam graph'),
    'This graph keeps delegation semantics separate from hook observation. A subagent backend creates an ordinary child agent/session through the shared provider registry.',
    '',
    '```mermaid',
    'flowchart TD',
    '  parent["Parent Agent + Session"]',
    '  tool["tool-subagent<br/>model-facing name"]',
    '  registry["ctx.subagents provider registry"]',
    '  spawn["spawn provider<br/>fresh child session"]',
    '  fork["fork provider<br/>seeded from completed-turn prefix"]',
    '  acp["ACP provider<br/>out-of-process child"]',
    '  child["Child AgentHandle<br/>ordinary Agent lifecycle"]',
    '  result["SubagentResult returned to tool"]',
    '  parent --> tool --> registry',
    '  registry --> spawn --> child',
    '  registry --> fork --> child',
    '  registry --> acp --> child',
    '  child --> result --> parent',
    '```',
    '',
    'The hooks stack adds richer lifecycle observation around child runs; the core ownership rule stays the same: the provider owns the child handle and must dispose it.',
    '',
  ].join('\n')
}

function renderHotReload(): string {
  return [
    ...generatedHeader('Plugin Disposal And Hot Reload Ownership', 'curated Mermaid flow based on Cordis fiber/effect conventions'),
    'This graph is a maintainer checklist for plugin authors: registrations are effects, service injection gates activation, and owned handles must be disposed by their owner.',
    '',
    '```mermaid',
    'flowchart TD',
    '  plugin["ctx.plugin(plugin) creates fiber"]',
    '  inject["static inject gates activation"]',
    '  service["ctx.provide / Service constructor"]',
    '  effects["ctx.effect registrations<br/>events, tools, adapters, timers"]',
    '  reload["HMR / fiber.dispose()"]',
    '  disposers["Run disposers in owner fiber"]',
    '  quiescence["Owned AgentHandle.dispose()<br/>or service teardown awaits quiescence"]',
    '  plugin --> inject --> service',
    '  inject --> effects',
    '  reload --> disposers --> quiescence',
    '```',
    '',
    'Hook bridges and SDK plugins increase the number of long-lived listeners, so this ownership graph should stay small and visible.',
    '',
  ].join('\n')
}

function renderSnapshotReplay(): string {
  return [
    ...generatedHeader('ACP Snapshot Replay', 'curated Mermaid sequence based on the snapshot test harness'),
    'This graph explains what a snapshot scenario proves: recorded real-model session logs are replayed keylessly, ACP stdout is normalized and diffed, and scenario workspaces preserve tool side effects that the UI stream alone cannot prove.',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant Recorder as Real API recording',
    '  participant Fixture as snapshot fixture',
    '  participant Workspace',
    '  participant Replay as llm-replay adapter',
    '  participant ACP as acp-agent subprocess',
    '  participant Golden as stdout golden',
    '  Recorder->>Fixture: session.jsonl + workspace inputs',
    '  Fixture->>Workspace: seed files and hook configs',
    '  Fixture->>Replay: recorded StreamChunk script',
    '  Replay->>ACP: deterministic llm/stream chunks',
    '  ACP->>Workspace: bash, fs, and hook side effects',
    '  ACP->>Golden: normalized sessionUpdate stream',
    '  Golden-->>ACP: diff must be empty',
    '```',
    '',
    'The fs and hook snapshot matrix is valuable because it proves world state, hook decisions, and failed tool-card rendering, not just that replay returns text.',
    '',
  ].join('\n')
}

async function renderDocs(): Promise<GraphDoc[]> {
  const pkgs = collectPackages()
  const docs: GraphDoc[] = [
    { rel: `${OUT_DIR}/package-topology.md`, content: renderPackageTopology(pkgs) },
    { rel: `${OUT_DIR}/capability-seams.md`, content: renderCapabilitySeams(pkgs) },
    { rel: `${OUT_DIR}/app-composition.md`, content: renderAppComposition() },
    { rel: `${OUT_DIR}/event-producer-consumer.md`, content: renderEventRelations(pkgs) },
    { rel: `${OUT_DIR}/tool-affordance-map.md`, content: await renderToolAffordance() },
    { rel: `${OUT_DIR}/agent-lifecycle.md`, content: renderLifecycle() },
    { rel: `${OUT_DIR}/tool-execution-pipeline.md`, content: renderToolPipeline() },
    { rel: `${OUT_DIR}/session-surface.md`, content: renderSessionSurface() },
    { rel: `${OUT_DIR}/subagent-lineage.md`, content: renderSubagentLineage() },
    { rel: `${OUT_DIR}/hot-reload-disposal.md`, content: renderHotReload() },
    { rel: `${OUT_DIR}/snapshot-replay.md`, content: renderSnapshotReplay() },
  ]
  docs.unshift({ rel: `${OUT_DIR}/README.md`, content: renderIndex(docs) })
  return docs
}

function renderIndex(docs: GraphDoc[]): string {
  const labels: Record<string, string> = {
    'package-topology.md': 'package topology by group',
    'capability-seams.md': 'capability seams and core services',
    'app-composition.md': 'app composition',
    'event-producer-consumer.md': 'event producer/consumer matrix',
    'tool-affordance-map.md': 'tool affordance map',
    'agent-lifecycle.md': 'agent turn and step lifecycle',
    'tool-execution-pipeline.md': 'tool execution pipeline',
    'session-surface.md': 'session surface and message projection',
    'subagent-lineage.md': 'subagent and session lineage',
    'hot-reload-disposal.md': 'plugin disposal and hot reload ownership',
    'snapshot-replay.md': 'ACP snapshot replay',
  }
  const modes: Record<string, string> = {
    'package-topology.md': 'generated',
    'capability-seams.md': 'hybrid generated',
    'app-composition.md': 'hybrid generated',
    'event-producer-consumer.md': 'hybrid generated',
    'tool-affordance-map.md': 'hybrid generated',
    'agent-lifecycle.md': 'curated',
    'tool-execution-pipeline.md': 'curated',
    'session-surface.md': 'curated',
    'subagent-lineage.md': 'curated',
    'hot-reload-disposal.md': 'curated',
    'snapshot-replay.md': 'curated',
  }
  return [
    ...generatedHeader('Documentation Graph Atlas', 'mixed: each linked page declares generated, hybrid, or curated mode'),
    'The graph atlas is the relationship layer above the generated catalogs. Use it to navigate package topology, capability seams, event flow, model-facing tools, and runtime lifecycle paths. Exact signatures and type shapes still live in [cordis-catalog/](../cordis-catalog/events-and-services.md), [tool-catalog/](../tool-catalog/tools.md), and [core-data-structures/](../core-data-structures/core.md).',
    '',
    'The process decision behind this atlas is recorded in [the documentation graph atlas RFC](../rfc/implemented/process/2026-07-03-documentation-graph-atlas.md).',
    '',
    '| Graph | Mode |',
    '| --- | --- |',
    ...docs.map((doc) => {
      const file = doc.rel.split('/').at(-1) ?? doc.rel
      return `| [${labels[file] ?? file}](${file}) | \`${modes[file] ?? 'generated'}\` |`
    }),
    '',
    'Regenerate with `pnpm run gen-doc-graphs`; verify freshness with `pnpm run verify-doc-graphs`.',
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  const docs = await renderDocs()
  if (process.argv.includes('--check')) {
    const stale: string[] = []
    for (const doc of docs) {
      const abs = resolve(root, doc.rel)
      const committed = existsSync(abs) ? readFileSync(abs, 'utf8') : null
      if (committed !== doc.content) stale.push(doc.rel)
    }
    if (stale.length === 0) {
      console.log(`gen-doc-graphs: ${docs.length} graph doc(s) are up to date.`)
      return
    }
    console.error(`gen-doc-graphs: stale graph doc(s): ${stale.join(', ')}. Run \`pnpm run gen-doc-graphs\` and commit the result.`)
    process.exit(1)
  }

  mkdirSync(resolve(root, OUT_DIR), { recursive: true })
  for (const doc of docs) writeFileSync(resolve(root, doc.rel), doc.content)
  console.log(`gen-doc-graphs: wrote ${docs.length} graph doc(s).`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
