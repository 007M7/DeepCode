/**
 * Generate `docs/tool-catalog.md` from schemas collected by booting each tool
 * plugin. Runtime registration is the source of truth for computed schemas;
 * the manifest is checked against every on-disk `tool-*` package. `--check`
 * verifies the committed artifact. Rationale and ownership live in
 * `.agents/notes/implemented/process/2026-07-02-tool-schema-catalog.md`.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Context } from 'cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import { BashExecutor } from '@deepseek-ai/dsh-bash'
import type { BashExecRequest, BashExecSpec, BashProcess, BashRunResult } from '@deepseek-ai/dsh-bash'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import WebService from '@deepseek-ai/dsh-web'
import * as WebSearchExa from '@deepseek-ai/dsh-web-search-exa'
import * as WebFetchLocal from '@deepseek-ai/dsh-web-fetch-local'
import SubagentService from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import SkillService from '@deepseek-ai/dsh-skill'
import * as SkillLocal from '@deepseek-ai/dsh-skill-local'
import TaskService from '@deepseek-ai/dsh-tasks'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as ToolTasks from '@deepseek-ai/dsh-tool-tasks'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import VmWorkflowEngine from '@deepseek-ai/dsh-workflow-workerthread'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/tool-catalog.md'
const CATALOG_RG_PROBE_COMMAND = 'command -v rg >/dev/null 2>&1'

/**
 * Minimal bash service for harvesting `dsh-tool-fs-search` schemas. The search
 * plugin now probes `rg` at registration time, but the generated catalog must
 * remain independent of the host PATH and never execute a real search.
 */
class CatalogSearchBashExecutor extends BashExecutor {
  override resolve(request: BashExecRequest): BashExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? root,
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      signal: request.signal,
      sandboxMode: request.sandboxMode,
    }
  }

  override run(spec: BashExecSpec): Promise<BashRunResult> {
    if (spec.command !== CATALOG_RG_PROBE_COMMAND) {
      throw new Error(`gen-tool-catalog: unexpected search bash command during schema harvest: ${spec.command}`)
    }
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    })
  }

  override start(): BashProcess {
    throw new Error('gen-tool-catalog: search schema harvest must not start background processes')
  }
}

/** Register the descriptor needed to mount schema-producing consumers. */
function registerCatalogSubagentProvider(ctx: Context, name: string): void {
  const provider: SubagentProvider = {
    name,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start: () => Promise.reject(new Error('tool-catalog provider cannot start a child')),
  }
  ctx.subagents.registerProvider(provider)
}

/**
 * Tool package plus its hand-maintained boot recipe. The caller mounts the
 * prompt and registry; each recipe supplies only package-specific seams and
 * config, while `dir` participates in the completeness check.
 */
interface ToolPackage {
  /** The npm package name, used as the catalog section heading. */
  pkg: string
  /** The `packages/<group>/<dir>` leaf name — matched by the completeness guard. */
  dir: string
  /** Repo-relative source path linked from the catalog entry. */
  source: string
  /** Services or owning runtime surfaces the package requires at execution time. */
  requires: string[]
  /** Session events or other visible state the tools write or affect. */
  writes: string[]
  /** Additional model-visible names shipped by example/app config. */
  shippedNames?: string[]
  /** Plug the injected seams + the tool plugin onto a context that already
   * carries `systemPrompt` + `tools`. */
  mount: (ctx: Context) => Promise<void>
  /**
   * Config for the caller's `ToolRegistry` mount. The registry itself ships a
   * model-facing tool (`run_code`, registered under a non-native `mode`), so
   * ITS catalog entry boots the registry in the mode that surfaces it;
   * every other entry uses the default (native) registry.
   */
  toolsConfig?: ToolsConfig
  /**
   * A deployment note rendered after the package's tools, for a fact that
   * booting the package alone cannot show. The registered tool NAME can be a
   * load-time config (`tool-subagent`'s `toolName`), so one package may surface
   * under several names across deployments — the boot yields the package
   * DEFAULT, and this note records the shipped alternatives the model sees.
   */
  note?: string
}

/**
 * The boot manifest: every shipped tool package (a `tool-*` leaf under
 * `packages/`). Ordered by package name (the render order); the completeness
 * guard proves it is exhaustive against the on-disk glob.
 */
const TOOL_PACKAGES: ToolPackage[] = [
  {
    pkg: '@deepseek-ai/dsh-tool-ask-user',
    dir: 'tool-ask-user',
    source: 'packages/ui/tool-ask-user/src/index.ts',
    requires: ['ctx.tools', 'ctx.userInteraction'],
    writes: ['tool/call', 'tool/result after a UI/provider answers the question'],
    async mount(ctx) {
      await ctx.plugin(UserInteractionService)
      await ctx.plugin(ToolAskUser)
    },
    note:
      'ask_user_question pauses the tool call until the active UI provider returns a human answer.',
  },
  {
    pkg: '@deepseek-ai/dsh-tools',
    dir: 'tools',
    source: 'packages/core/tools/src/code-mode.ts',
    requires: ['ctx.tools', 'ctx.codeRuntime (execution time)', 'ctx.systemPrompt'],
    writes: ['tool/call', 'one tool/code-dispatch per bridged sub-call', 'tool/result'],
    // The registry's OWN tool: run_code exists only under a non-native mode
    // (the registry registers it in its constructor; the code runtime is read
    // at assembly/execution time, so the schema harvest needs none mounted).
    toolsConfig: { mode: 'code' },
    async mount() {},
    note:
      'Owned by the tool registry as a reserved transport outside filterable capability layers under `mode: code` / `mode: both` (see the Code Mode Agent Note). Under `code` it is the registry\'s only wire contribution; the other visible capabilities are declared in a generated TypeScript SDK section, and a program calls them through serialized bindings that re-enter the complete guarded tool pipeline and link each nested execution to this outer result.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-bash',
    dir: 'tool-bash',
    source: 'packages/bash/tool-bash/src/index.ts',
    requires: ['ctx.tools', 'ctx.bash', 'ctx.tasks at call time for run_in_background'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(LocalBashExecutor)
      await ctx.plugin(ToolBash)
    },
    note:
      'The bash tool is the model-facing consumer of the bash executor seam. A `run_in_background` run registers with the generic `ctx.tasks` runtime and is collected/stopped through the `task_*` tools from `@deepseek-ai/dsh-tool-tasks`; the `enableRunInBackground` config (default true) removes the parameter entirely when disabled.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-cordis',
    dir: 'tool-cordis',
    source: 'packages/cordis/tool-cordis/src/index.ts',
    requires: ['ctx.tools'],
    writes: ['tool/call', 'tool/result', 'live plugin-tree mutations (mount/unmount)'],
    async mount(ctx) {
      await ctx.plugin(ToolCordis)
    },
    note:
      'Ships in examples/cordis-agent only (a deliberate opt-in — mounted code gets the real ctx, see .agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md). Plugins the model mounts may register ADDITIONAL model-visible tools at runtime; a full changed request header logs those tool-set changes.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-fs',
    dir: 'tool-fs',
    source: 'packages/fs/tool-fs/src/index.ts',
    requires: ['ctx.tools', 'ctx.fs', 'ctx.systemPrompt'],
    writes: ['tool/call', 'fs/write-intent or fs/edit-intent for mutations', 'fs/observed after successful file operations', 'tool/result'],
    async mount(ctx) {
      // The tool needs `fs`; the bare provider is sufficient because policy
      // changes behavior, not schema shape.
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(ToolFs)
    },
    note:
      'The read-before-write/edit policy is added by `@deepseek-ai/dsh-fs-policy` (an `fs/*` event-gate plugin, no schema change); a deployment that loads these tools is expected to also load it. The tool schemas above are identical with or without the policy plugin.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-fs-search',
    dir: 'tool-fs-search',
    source: 'packages/fs/tool-fs-search/src/index.ts',
    requires: ['ctx.tools', 'ctx.bash', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The tools inject `bash` (search executes fixed `rg` commands through
      // the executor seam, not ctx.fs). Use a catalog-only executor so the
      // registration-time `rg` probe stays deterministic and the generator
      // never depends on the host PATH. `ctx.spillStore` is optional (read via
      // ctx.get) and does not affect the schemas, so no spill backend is mounted.
      await ctx.plugin(CatalogSearchBashExecutor)
      await ctx.plugin(ToolFsSearch)
    },
    note:
      'glob and grep are conditional bash-backed discovery tools: they register only when ctx.bash can find `rg`, then run fixed ripgrep commands through ctx.bash as ordinary foreground calls (never background tasks). Capped results save the complete formatted list through the optional ctx.spillStore backend; returned locators are follow-up-readable/searchable when the backend exposes local paths in co-located deployments.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-skill',
    dir: 'tool-skill',
    source: 'packages/skill/tool-skill/src/index.ts',
    requires: ['ctx.tools', 'ctx.skills'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(SkillService)
      await ctx.plugin(SkillLocal, {
        dshHome: resolve(root, '.tmp/tool-catalog/.dsh'),
        agentsHome: resolve(root, '.tmp/tool-catalog/.agents'),
      })
      await ctx.plugin(ToolSkill)
    },
  },
  {
    pkg: '@deepseek-ai/dsh-tool-subagent',
    dir: 'tool-subagent',
    source: 'packages/subagent/tool-subagent/src/index.ts',
    requires: ['ctx.tools', 'ctx.subagents'],
    writes: ['tool/call', 'tool/result', 'child session events through the chosen provider'],
    shippedNames: ['subagent', 'subagent_fork'],
    async mount(ctx) {
      await ctx.plugin(SubagentService)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(ToolSubagent, { provider: 'mock' })
    },
    note:
      'The registered tool name is the load-time `toolName` config (default `subagent`); the schema above is that default. The shipped example agents load this package once per subagent backend, so the model additionally sees `subagent_fork` (bound to the fork backend) with an identical schema — see `examples/repl-agent/cordis.yml` and `examples/acp-agent/cordis.yml`.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-tasks',
    dir: 'tool-tasks',
    source: 'packages/tasks/tool-tasks/src/index.ts',
    requires: ['ctx.tools', 'ctx.tasks', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result', 'context/message via agent.inject() for background completion notices'],
    async mount(ctx) {
      await ctx.plugin(TaskService)
      await ctx.plugin(ToolTasks)
    },
    note:
      'The kind-agnostic background-task control surface: a background bash command and a background subagent are read, listed, and killed through the same three tools. Loading the plugin attaches the control surface that arms producers\' `ctx.tasks.start()`.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-todo',
    dir: 'tool-todo',
    source: 'packages/todo/tool-todo/src/index.ts',
    requires: ['ctx.tools', 'owning Agent session'],
    writes: ['tool/call', 'todo/write', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolTodo)
    },
    note:
      'todo_write is session-owned state; UIs render the latest todo/write event as a checklist or ACP plan.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-workflow',
    dir: 'tool-workflow',
    source: 'packages/workflow/tool-workflow/src/index.ts',
    requires: ['ctx.tools', 'ctx.workflows', 'ctx.systemPrompt', 'a calling Agent (exec.agent parents the script children)'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The tool injects `workflows`; boot the vm engine over a scripted
      // subagent provider to satisfy it. The schema does not depend on which
      // provider backs the engine.
      await ctx.plugin(SubagentService)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(VmWorkflowEngine, { provider: 'mock' })
      await ctx.plugin(ToolWorkflow)
    },
  },
  {
    pkg: '@deepseek-ai/dsh-tool-web',
    dir: 'tool-web',
    source: 'packages/web/tool-web/src/index.ts',
    requires: ['ctx.tools', 'ctx.web', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Mount search and fetch providers so both tools register. Their schemas
      // do not depend on provider identity or availability.
      await ctx.plugin(WebService)
      await ctx.plugin(WebSearchExa)
      await ctx.plugin(WebFetchLocal)
      await ctx.plugin(ToolWeb)
    },
    note:
      'web_search and web_fetch keep provider selection behind ctx.web so model-visible schemas stay stable across backend swaps.',
  },
]

/** One package's contribution to the catalog: its schemas plus attribution. */
interface CatalogPackage {
  pkg: string
  source: string
  requires: string[]
  writes: string[]
  shippedNames?: string[]
  schemas: ToolSchema[]
  /** A deployment note (see {@link ToolPackage.note}), rendered after the tools. */
  note?: string
}

/** The whole catalog: one entry per booted tool package, in manifest order. */
export type ToolCatalog = CatalogPackage[]

/**
 * Assert the boot manifest covers every shipped tool package on disk (a
 * `tool-*` leaf under `packages/`).
 * Booting has no source declaration to enumerate, so this glob restores the
 * "a new tool cannot be silently undocumented" guarantee: an unlisted package
 * fails the generator (and the freshness gate) until it is added to
 * {@link TOOL_PACKAGES}. Exported for a direct negative test.
 *
 * `scanRoot` defaults to the repo root; a test may point it at a fixture tree.
 */
export function assertManifestComplete(packages: ToolPackage[] = TOOL_PACKAGES, scanRoot: string = root): void {
  const onDisk = globSync('packages/*/tool-*', { cwd: scanRoot }).map(p => basename(p)).sort()
  const listed = new Set(packages.map(p => p.dir))
  const missing = onDisk.filter(dir => !listed.has(dir))
  if (missing.length > 0) {
    throw new Error(
      `gen-tool-catalog: ${missing.length} tool package(s) not in the boot manifest: ${missing.join(', ')}. `
      + 'Add each to TOOL_PACKAGES in scripts/gen-tool-catalog.ts so its schema is catalogued.',
    )
  }
}

/**
 * Boot each tool package on a fresh Context and harvest its model-facing
 * schemas. A fresh Context per package keeps attribution clean (each entry's
 * schemas come from exactly that package) and isolates a boot failure to its
 * own entry. Disposed after harvest so no executor/provider outlives the run.
 */
export async function collectToolCatalog(packages: ToolPackage[] = TOOL_PACKAGES): Promise<ToolCatalog> {
  assertManifestComplete(packages)
  const catalog: ToolCatalog = []
  for (const entry of packages) {
    const ctx = new Context()
    // Dispose in `finally` so a throw from `mount`/`schemas()` after earlier
    // plugins mounted still tears the context down (no leaked executor/provider
    // fiber) — the repo's "dispose must reach quiescence" rule.
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRegistry, entry.toolsConfig ?? {})
      await entry.mount(ctx)
      const schemas = ctx.tools.schemas().sort((a, b) => a.name.localeCompare(b.name))
      catalog.push({
        pkg: entry.pkg,
        source: entry.source,
        requires: entry.requires,
        writes: entry.writes,
        schemas,
        ...entry.shippedNames !== undefined ? { shippedNames: entry.shippedNames } : {},
        ...entry.note !== undefined ? { note: entry.note } : {},
      })
    } finally {
      await ctx.fiber.dispose()
    }
  }
  return catalog
}

/** Render one tool's entry: name, description, JSON-Schema parameters, source. */
function renderTool(schema: ToolSchema, source: string): string[] {
  const out = [`### \`${schema.name}\``, '']
  if (schema.description) out.push(schema.description, '')
  out.push('```json', JSON.stringify(schema.parameters, null, 2), '```', '')
  out.push(`Source: [\`${source}\`](../${source})`, '')
  return out
}

function codeList(values: string[] | undefined): string {
  return values?.length ? values.map(value => `\`${value}\``).join(', ') : '-'
}

function tableCell(value: string | undefined): string {
  return value ? value.replace(/\|/g, '\\|').replace(/\n/g, '<br>') : '-'
}

/** Render the full catalog (pure, deterministic given the manifest-ordered input). */
export function render(catalog: ToolCatalog): string {
  const lines: string[] = [
    '<!-- Generated by scripts/gen-tool-catalog.ts — do not edit by hand.',
    '     Run `pnpm run gen-tool-catalog` to regenerate. -->',
    '',
    '# Tool Schema Catalog',
    '',
    'Every model-facing tool a shipped plugin contributes to `ctx.tools`: the `name`, `description`, and JSON-Schema `parameters` the model receives via the system-prompt assembly. It complements the cordis [events](cordis-catalog/events.md) & [services](cordis-catalog/services.md) catalogs (the wiring a plugin listens to and calls) and [core-data-structures/](core-data-structures/core.md) (the types those signatures move) — this page is the *tools* the agent is offered.',
    '',
    'This file is GENERATED and verified fresh by `pnpm run verify-tool-catalog` (part of `doc-sync`) — do not edit it by hand. Unlike the cordis catalog (a pure source-AST pass), this generator BOOTS each tool plugin on a real context and reads `ctx.tools.schemas()`, because a tool schema is not statically knowable (runtime-spread enums, concatenated descriptions, config-driven names, raw-JSON-Schema MCP tools). A completeness guard globs `packages/*/tool-*` and fails if any package is missing from the generator\'s boot manifest, so a new tool cannot be silently undocumented. See [the tool-schema-catalog Agent Note](../.agents/notes/implemented/process/2026-07-02-tool-schema-catalog.md).',
    '',
    'Scope: shipped product tools under `packages/*/tool-*`, each booted with its DEFAULT config. The registered tool NAME can be a load-time config (e.g. `tool-subagent`\'s `toolName`), so a deployment may surface a package under a different or additional name — a per-package note records those shipped aliases where they exist. The `examples/` demo tools (e.g. `echo`) are excluded, matching the cordis catalog\'s packages-only scope.',
    '',
    '## Tool Package Map',
    '',
    'This table connects model-visible tool names to the plugin package and service seams behind them. Exact JSON Schemas follow in the package sections below.',
    '',
    '| Tool package | Model-visible names | Requires | Writes / affects | Shipped aliases | Deployment note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...catalog.map(entry => `| \`${entry.pkg}\` | ${codeList(entry.schemas.map(schema => schema.name))} | ${codeList(entry.requires)} | ${codeList(entry.writes)} | ${codeList(entry.shippedNames)} | ${tableCell(entry.note)} |`),
    '',
  ]
  for (const entry of catalog) {
    lines.push(`## \`${entry.pkg}\``, '')
    for (const schema of entry.schemas) lines.push(...renderTool(schema, entry.source))
    if (entry.note) lines.push(entry.note, '')
  }
  return lines.join('\n')
}

/** CLI entry: default writes the catalog, `--check` fails if the committed copy
 * is stale. Guarded behind an entry-point check so importing this module for
 * tests neither regenerates the committed file nor calls process.exit. */
async function main(): Promise<void> {
  const content = render(await collectToolCatalog())
  if (process.argv.includes('--check')) {
    let committed: string | null = null
    try {
      committed = readFileSync(resolve(root, OUT), 'utf8')
    } catch {
      // Only ENOENT (not yet generated) is expected; a present-but-unreadable
      // file is not a state this repo produces. Either way the remedy is the
      // same — regenerate — so treat a read failure as "stale".
      committed = null
    }
    if (committed === content) {
      console.log(`gen-tool-catalog: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-tool-catalog: ${OUT} is stale. Run \`pnpm run gen-tool-catalog\` and commit ${OUT}.`)
    process.exit(1)
  }

  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-tool-catalog: wrote ${OUT}.`)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
