/**
 * Generate (and verify) the relationship-diagram docs.
 *
 * This is the relationship layer above the existing catalogs:
 * - module-graph.md answers "which packages depend on which packages?"
 * - cordis-catalog/ answers "which events and services exist?"
 * - tool-catalog.md answers "which tools does the model see?"
 * - generated relationship diagrams answer "how do those pieces fit together?"
 *
 * Generated pages discover the enumerable facts from source. Hybrid pages use
 * discovered inventory plus small manifests for policy that source cannot infer
 * (for example, whether a package is an implementation or consumer in a seam).
 * Curated pages are still emitted here so the graph docs are one regenerated unit,
 * but their diagrams intentionally explain flow and ownership rather than
 * pretending to enumerate every source edge.
 *
 *   `tsx scripts/gen-doc-graphs.ts`          -> write generated diagram docs
 *   `tsx scripts/gen-doc-graphs.ts --check`  -> exit 1 if any file is stale
 */

import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { collectEvents, collectServices } from './gen-cordis-catalog.ts'

const root = resolve(import.meta.dirname, '..')
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

const DYNAMIC_EVENT_DISPATCHERS: Array<{ event: string; pkg: string; method: string }> = [
  // Subagent lifecycle events intentionally bypass ctx.emit and call
  // ctx.events.dispatch directly so one throwing listener cannot starve later
  // listeners or strand an already-started child run.
  { event: 'subagent/start', pkg: 'subagent', method: 'events.dispatch' },
  { event: 'subagent/end', pkg: 'subagent', method: 'events.dispatch' },
]

function generatedHeader(title: string): string[] {
  return [
    '<!-- Generated by scripts/gen-doc-graphs.ts - do not edit by hand.',
    '     Run `pnpm run gen-doc-graphs` to regenerate. -->',
    '',
    `# ${title}`,
    '',
  ]
}

function maintenanceFooter(source: string): string[] {
  return [`Maintenance mode: ${source}.`, '']
}

function graphIndexLink(rel: string): string {
  return relative('docs', rel).replaceAll('\\', '/')
}

function linkFromDoc(docRel: string, targetRel: string): string {
  return relative(dirname(docRel), targetRel).replaceAll('\\', '/')
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

function mermaidCode(value: string): string {
  return `<code>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`
}

function repoLink(path: string, label: string, up = '..'): string {
  return `[${label}](${up}/${path})`
}

function sourceLink(source: string, up = '..'): string {
  return repoLink(source.split(':')[0] ?? source, `\`${source}\``, up)
}

function pkgLink(pkg: Pkg | undefined, fallback: string, up = '..'): string {
  return pkg ? repoLink(pkg.rel, `\`${pkg.short}\``, up) : `\`${fallback}\``
}

function pkgList(names: string[] | undefined, pkgsByShort: Map<string, Pkg>): string {
  if (!names || names.length === 0) return '-'
  return names.map(name => pkgLink(pkgsByShort.get(name), name)).join(', ')
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>')
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
  const maintenance = 'hybrid: services are discovered from Cordis declarations; interface/implementation/consumer roles are classified in `scripts/gen-doc-graphs.ts` with a completeness guard'
  const nodes = new Map<string, string>()
  const edges = new Set<string>()
  const companionEdges = new Set<string>()
  const addNode = (id: string, label: string): void => {
    if (!nodes.has(id)) nodes.set(id, `  ${id}["${escLabel(label)}"]`)
  }
  const addEdge = (from: string, to: string): void => { edges.add(`  ${from} --> ${to}`) }
  const lines = generatedHeader('Capability Seams And Core Services')
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
  lines.push('', ...maintenanceFooter(maintenance))
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

const APP_EXAMPLES = [
  {
    id: 'echo',
    rel: 'examples/echo-agent/composition.md',
    title: 'Echo Agent App Composition',
    label: 'examples/echo-agent',
    config: 'examples/echo-agent/cordis.yml',
    summary: 'The echo demo swaps in a local mock LLM and teaching echo tool, then loads the stdio app package for the shared spine and terminal front door.',
  },
  {
    id: 'coding',
    rel: 'examples/coding-agent/composition.md',
    title: 'Coding Agent App Composition',
    label: 'examples/coding-agent',
    config: 'examples/coding-agent/cordis.yml',
    summary: 'The coding REPL demo adds the real DeepSeek adapter, filesystem tools, todo_write, compaction, and both subagent transports on top of the stdio app package.',
  },
  {
    id: 'acp',
    rel: 'examples/acp-agent/composition.md',
    title: 'ACP Agent App Composition',
    label: 'examples/acp-agent',
    config: 'examples/acp-agent/cordis.yml',
    summary: 'The ACP demo exposes the same agent spine over JSON-RPC stdio, with no stdout logger and no pre-created agent; clients create sessions through the ACP bridge.',
  },
]

type AppExample = typeof APP_EXAMPLES[number]

function renderAppExpansion(lines: string[], appNode: string, pluginName: string): void {
  const agentCore = nodeId('bundle', 'agent_core')
  const jsonl = nodeId('bundle', 'jsonl')
  lines.push(`  ${appNode} --> ${agentCore}["@deepseek-ai/dsh-agent-core"]`)
  lines.push(`  ${appNode} --> ${jsonl}["@deepseek-ai/dsh-session-persistence-jsonl"]`)
  if (pluginName === '@deepseek-ai/dsh-stdio-agent') {
    lines.push(`  ${appNode} --> ${nodeId('frontdoor', 'stdio')}["readline UI<br/>console logger<br/>pre-created main agent"]`)
  } else if (pluginName === '@deepseek-ai/dsh-acp-agent') {
    lines.push(`  ${appNode} --> ${nodeId('frontdoor', 'acp')}["@deepseek-ai/dsh-acp<br/>JSON-RPC stdio bridge<br/>sessions created by client"]`)
  }
  lines.push(
    `  ${agentCore} --> ${nodeId('spine', 'llm')}["ctx.llm"]`,
    `  ${agentCore} --> ${nodeId('spine', 'sessions')}["ctx.sessions"]`,
    `  ${agentCore} --> ${nodeId('spine', 'tools')}["ctx.tools + tool-bash"]`,
    `  ${agentCore} --> ${nodeId('spine', 'loop')}["ctx.agents + ctx.agentLoop"]`,
  )
}

function renderAppComposition(example: AppExample): string {
  const plugins = parseExampleCordis(example.config)
  const maintenance = 'hybrid: the leaf plugin list is parsed from its `cordis.yml`; app package expansion is curated from package source'
  const lines = generatedHeader(example.title)
  lines.push(
    example.summary,
    '',
    '```mermaid',
    'flowchart LR',
    `  cfg["${escLabel(example.label)}<br/>cordis.yml"]`,
  )
  for (const plugin of plugins) {
    const pluginNode = nodeId(`plugin_${example.id}`, plugin.id)
    lines.push(`  ${pluginNode}["${escLabel(plugin.id)}<br/>${escLabel(plugin.name)}"]`)
    lines.push(`  cfg --> ${pluginNode}`)
    if (plugin.name === '@deepseek-ai/dsh-stdio-agent' || plugin.name === '@deepseek-ai/dsh-acp-agent') {
      renderAppExpansion(lines, pluginNode, plugin.name)
    }
  }
  lines.push(
    '```',
    '',
    '| Plugin id | Package / module |',
    '| --- | --- |',
    ...plugins.map(plugin => `| \`${plugin.id}\` | \`${plugin.name}\` |`),
    '',
    `Source config: [\`${example.config}\`](${linkFromDoc(example.rel, example.config)}).`,
  )
  lines.push('', ...maintenanceFooter(maintenance))
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
  const maintenance = 'hybrid generated: Cordis event declarations and most producer/listener edges are AST-scanned; dynamic dispatch sites are classified in `scripts/gen-doc-graphs.ts`'
  const lines = generatedHeader('Event Producer And Consumer Matrix')
  lines.push(
    'This matrix shows which packages dispatch each harness-owned event and which packages listen to it. It is intentionally a table rather than one large graph: events are many-to-many, and dense relation data is easier to review in rows. Dynamic dispatch overrides cover sites that deliberately bypass `ctx.emit`, such as subagent lifecycle containment.',
    '',
    '| Event | Mode | Declared in | Dispatchers | Listeners |',
    '| --- | --- | --- | --- | --- |',
  )
  for (const event of [...events].sort((a, b) => a.name.localeCompare(b.name))) {
    const relation = relations.get(event.name) ?? { dispatchers: new Map<string, Set<string>>(), listeners: new Set<string>() }
    lines.push(`| \`${event.name}\` | \`${event.mode}\` | ${sourceLink(event.source)} | ${relationPackages(relation.dispatchers, pkgsByShort)} | ${listenerPackages(relation.listeners, pkgsByShort)} |`)
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
  lines.push('', ...maintenanceFooter(maintenance))
  return lines.join('\n')
}

function renderLifecycle(): string {
  const maintenance = 'curated Mermaid sequence; exact event signatures live in the generated Cordis catalog'
  return [
    ...generatedHeader('Agent Turn And Step Lifecycle'),
    'This sequence is the visual companion to [architecture.md](architecture.md#loop-lifecycle-session--turn--step). It keeps durable replay facts on `session/event` and live control/status on `agent/*`.',
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
    `  Agent-->>SDK: ${mermaidCode('agent/queued')}`,
    '  Agent->>Driver: queued work wakes driver',
    `  Driver-->>SDK: ${mermaidCode('agent/status')} running`,
    `  Driver->>Session: ${mermaidCode('turn/start')}`,
    `  Driver->>Hooks: ${mermaidCode('agent/prompt-submit')} waterfall`,
    '  Hooks-->>Driver: allow, block, or add context',
    `  Driver->>Session: ${mermaidCode('user/message')} or rejected ${mermaidCode('turn/end')}`,
    `  Driver->>Prompt: ${mermaidCode('system-prompt/assemble')} waterfall`,
    `  Driver-->>Driver: ${mermaidCode('agent/pre-step')} serial checkpoint`,
    `  Driver->>Session: ${mermaidCode('step/start')}`,
    `  Driver->>LLM: ${mermaidCode('agent/request')} waterfall, then ${mermaidCode('llm/stream')} waterfall`,
    '  LLM-->>Driver: StreamChunk*',
    `  Driver->>Session: ${mermaidCode('assistant/chunk')}*`,
    `  Session-->>SDK: ${mermaidCode('session/event')} ${mermaidCode('assistant/chunk')}*`,
    `  Driver->>Hooks: ${mermaidCode('agent/step-result')} waterfall`,
    `  Driver->>Session: ${mermaidCode('assistant/message')}`,
    `  Driver->>Session: ${mermaidCode('tool/call')}`,
    '  Driver->>Tools: execute through pre and post waterfalls',
    '  Tools-->>Session: tool-owned events when applicable',
    `  Driver->>Session: ${mermaidCode('tool/result')} and ${mermaidCode('step/end')}`,
    `  Driver->>Hooks: ${mermaidCode('agent/turn-continuation')} waterfall`,
    `  Driver->>Session: ${mermaidCode('turn/end')}`,
    `  Driver->>Persistence: ${mermaidCode('session/flush')} parallel checkpoint`,
    `  Driver-->>SDK: ${mermaidCode('agent/status')} idle`,
    '```',
    '',
    'SDK users that need replayable transcript data should consume `session/event`; `agent/*` is the live coordination surface for queue/status, prompt interception, request shaping, steering, continuation, and errors.',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function renderToolPipeline(): string {
  const maintenance = 'curated Mermaid flow; exact tool schemas and event signatures live in generated catalogs'
  return [
    ...generatedHeader('Tool Execution Pipeline'),
    'This graph shows where policy, hooks, sandboxing, filesystem guards, result rewriting, and UI rendering fit without changing the loop. The key extension points are the `tools/pre-execute` and `tools/post-execute` waterfalls.',
    '',
    '```mermaid',
    'flowchart TD',
    '  model["Assistant message contains tool-call block"]',
    `  toolCall["Session event: ${mermaidCode('tool/call')}<br/>logged before execution"]`,
    '  presentCall["UI pending card<br/>presentCall(args)"]',
    `  pre["${mermaidCode('tools/pre-execute')} waterfall<br/>hooks, permission, sandbox"]`,
    '  denied["deny or ask<br/>tool body skipped"]',
    '  toolBody["Registered tool execute() body"]',
    `  fsGate["${mermaidCode('fs/write-intent')} or ${mermaidCode('fs/edit-intent')}<br/>tool-fs mutations only"]`,
    `  owned["Tool-owned session events<br/>${mermaidCode('todo/write')}, ${mermaidCode('fs/observed')}, ${mermaidCode('hook/invoked')}, ${mermaidCode('hook/result')}"]`,
    `  post["${mermaidCode('tools/post-execute')} waterfall<br/>accept, block, replace, add context"]`,
    '  context["Buffered additionalContext<br/>context/message after all tool results"]',
    `  toolResult["Session event: ${mermaidCode('tool/result')}<br/>single model-facing outcome"]`,
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
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function renderSnapshotReplay(): string {
  const maintenance = 'curated Mermaid sequence based on the snapshot test harness'
  return [
    ...generatedHeader('ACP Snapshot Replay'),
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
    `  Replay->>ACP: deterministic ${mermaidCode('llm/stream')} chunks`,
    '  ACP->>Workspace: bash, fs, and hook side effects',
    '  ACP->>Golden: normalized sessionUpdate stream',
    '  Golden-->>ACP: diff must be empty',
    '```',
    '',
    'The fs and hook snapshot matrix is valuable because it proves world state, hook decisions, and failed tool-card rendering, not just that replay returns text.',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function renderDocs(): GraphDoc[] {
  const pkgs = collectPackages()
  const docs: GraphDoc[] = [
    { rel: 'docs/capability-seams.md', content: renderCapabilitySeams(pkgs) },
    ...APP_EXAMPLES.map(example => ({ rel: example.rel, content: renderAppComposition(example) })),
    { rel: 'docs/event-producer-consumer.md', content: renderEventRelations(pkgs) },
    { rel: 'docs/agent-lifecycle.md', content: renderLifecycle() },
    { rel: 'docs/tool-execution-pipeline.md', content: renderToolPipeline() },
    { rel: 'packages/ui/acp/snapshot-replay.md', content: renderSnapshotReplay() },
  ]
  docs.unshift({ rel: 'docs/graph-atlas.md', content: renderIndex(docs) })
  return docs
}

function renderIndex(docs: GraphDoc[]): string {
  const labels: Record<string, string> = {
    'docs/capability-seams.md': 'capability seams and core services',
    'examples/echo-agent/composition.md': 'echo-agent app composition',
    'examples/coding-agent/composition.md': 'coding-agent app composition',
    'examples/acp-agent/composition.md': 'acp-agent app composition',
    'docs/event-producer-consumer.md': 'event producer/consumer matrix',
    'docs/agent-lifecycle.md': 'agent turn and step lifecycle',
    'docs/tool-execution-pipeline.md': 'tool execution pipeline',
    'packages/ui/acp/snapshot-replay.md': 'ACP snapshot replay',
  }
  const modes: Record<string, string> = {
    'docs/capability-seams.md': 'hybrid generated',
    'examples/echo-agent/composition.md': 'hybrid generated',
    'examples/coding-agent/composition.md': 'hybrid generated',
    'examples/acp-agent/composition.md': 'hybrid generated',
    'docs/event-producer-consumer.md': 'hybrid generated',
    'docs/agent-lifecycle.md': 'curated',
    'docs/tool-execution-pipeline.md': 'curated',
    'packages/ui/acp/snapshot-replay.md': 'curated',
  }
  const rows = [
    '| [module dependency graph](module-graph.md) | `generated` |',
    '| [tool schema catalog and package map](tool-catalog.md) | `generated` |',
    ...docs.map((doc) => {
      const link = graphIndexLink(doc.rel)
      return `| [${labels[doc.rel] ?? link}](${link}) | \`${modes[doc.rel] ?? 'generated'}\` |`
    }),
  ]
  const maintenance = 'mixed: each linked page declares generated, hybrid, or curated mode'
  return [
    ...generatedHeader('Documentation Graph Index'),
    'These diagrams are the relationship layer above the generated catalogs. Use them to navigate package topology, capability seams, event flow, model-facing tools, app composition, and runtime lifecycle paths. Exact signatures and type shapes still live in the generated [events](cordis-catalog/events.md) / [services](cordis-catalog/services.md) catalogs, [tool-catalog.md](tool-catalog.md), and [core-data-structures/](core-data-structures/core.md).',
    '',
    'The process decision behind this index is recorded in [the documentation graph RFC](rfc/implemented/process/2026-07-03-documentation-graph-atlas.md).',
    '',
    '| Graph | Mode |',
    '| --- | --- |',
    ...rows,
    '',
    'Regenerate with `pnpm run gen-doc-graphs`; verify freshness with `pnpm run verify-doc-graphs`.',
    '',
    ...maintenanceFooter(maintenance),
  ].join('\n')
}

function main(): void {
  const docs = renderDocs()
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

  for (const doc of docs) {
    mkdirSync(dirname(resolve(root, doc.rel)), { recursive: true })
    writeFileSync(resolve(root, doc.rel), doc.content)
  }
  console.log(`gen-doc-graphs: wrote ${docs.length} graph doc(s).`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
