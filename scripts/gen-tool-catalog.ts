/**
 * Generate (and verify) the tool-schema catalog in docs/tool-catalog.md.
 *
 * The catalog is the MODEL-FACING TOOL reference: every tool a shipped plugin
 * contributes to `ctx.tools`, with the exact `name` / `description` / JSON-Schema
 * `parameters` the model receives via the system-prompt assembly. It complements
 * the cordis events/services catalog (the wiring a plugin author works against)
 * and the core-data-structures catalog (the vocabulary those signatures move):
 * this page is the TOOLS the agent is offered.
 *
 *   `tsx scripts/gen-tool-catalog.ts`          → write the catalog
 *   `tsx scripts/gen-tool-catalog.ts --check`  → exit 1 if the committed file
 *                                                 is stale (CI / pre-push gate)
 *
 * Why this generator BOOTS PLUGINS instead of parsing source (unlike its AST
 * sibling `gen-cordis-catalog.ts`): a tool's schema is not statically knowable.
 * `tool-todo` writes `enum: [...STATUSES]` (a runtime spread), descriptions are
 * built by string concatenation, `tool-subagent`'s tool name is `config.toolName`,
 * and an MCP plugin can register RAW JSON Schema without `defineTool` at all. The
 * faithful source of truth is therefore the SHIPPED schema: mount each tool
 * plugin on a real cordis Context and read `ctx.tools.schemas()` — exactly the
 * `ToolSchema[]` the model is sent. See
 * docs/rfc/implemented/process/2026-07-02-tool-schema-catalog.md.
 *
 * Booting sacrifices the AST pass's structural "nothing can be silently omitted"
 * property (there is no source declaration to enumerate), so a COMPLETENESS GUARD
 * restores it: the generator globs every `tool-*` package under `packages/` and
 * hard-errors if any such package is absent from the boot manifest below. A new
 * tool package fails the generator — and thus the freshness gate — until it is
 * registered here, mirroring how a new event appears in the cordis regenerate.
 *
 * Schema blocks use a plain ` ```json ` fence: doc-typecheck only extracts `ts*`
 * fences, so no BlockKind wiring is needed there.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Context } from 'cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import UserInteractionService from '@deepseek-ai/dsh-user-interaction'
import WebService from '@deepseek-ai/dsh-web'
import * as WebSearchExa from '@deepseek-ai/dsh-web-search-exa'
import * as WebFetchLocal from '@deepseek-ai/dsh-web-fetch-local'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentMock from '@deepseek-ai/dsh-subagent-mock'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/tool-catalog.md'

/**
 * One tool-plugin package to boot. `mount` is a per-entry recipe (async): it
 * plugs the injected seams the plugin's `apply` reads (an executor for
 * `ctx.bash`, a provider for `ctx.subagents`) BEFORE the tool plugin itself.
 * `SystemPrompt` + `ToolRegistry` are mounted for every entry by the caller
 * (`ToolRegistry` injects `systemPrompt`), so `mount` only handles the extras.
 *
 * The recipe is irreducible policy — WHICH seams a given tool needs and with
 * WHAT config is not derivable from the package layout — so it stays a hand-
 * maintained closure. The `dir` field is what the completeness guard matches
 * against the on-disk `tool-*` package glob, so a NEW tool package cannot be
 * silently omitted (see the module doc).
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
      'Registered by the tool registry itself under `mode: code` / `mode: both` (see the Code Mode RFC). Under `code` it is the ONLY wire tool; the other registered tools are declared to the model as a generated TypeScript SDK prompt section instead, and a program calls them through port-bridged bindings that dispatch through the ordinary tools/pre-execute → tools/post-execute pipeline, one at a time.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-bash',
    dir: 'tool-bash',
    source: 'packages/bash/tool-bash/src/index.ts',
    requires: ['ctx.tools', 'ctx.bash'],
    writes: ['tool/call', 'tool/result', 'context/message via agent.inject() for background completion notices'],
    async mount(ctx) {
      await ctx.plugin(LocalBashExecutor)
      await ctx.plugin(ToolBash)
    },
    note:
      'The bash/bash_output/bash_kill tools are model-facing consumers of the bash executor seam.',
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
      'Ships in examples/cordis-agent only (a deliberate opt-in — mounted code gets the real ctx, see docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md). Plugins the model mounts may register ADDITIONAL model-visible tools at runtime; the request-header ToolsDelta logs those tool-set changes.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-fs',
    dir: 'tool-fs',
    source: 'packages/fs/tool-fs/src/index.ts',
    requires: ['ctx.tools', 'ctx.fs', 'ctx.systemPrompt'],
    writes: ['tool/call', 'fs/write-intent or fs/edit-intent for mutations', 'fs/observed after successful file operations', 'tool/result'],
    async mount(ctx) {
      // The tool injects `fs`; boot the local backend to satisfy it. The schemas
      // do not depend on the policy plugin (an event gate that changes behavior,
      // not tool shape), so the bare provider is enough to harvest them.
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(ToolFs)
    },
    note:
      'The read-before-write/edit policy is added by `@deepseek-ai/dsh-fs-policy` (an `fs/*` event-gate plugin, no schema change); a deployment that loads these tools is expected to also load it. The tool schemas above are identical with or without the policy plugin.',
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
      // Register a scripted provider under the name the tool delegates to.
      await ctx.plugin(SubagentMock, { name: 'mock' })
      await ctx.plugin(ToolSubagent, { provider: 'mock' })
    },
    note:
      'The registered tool name is the load-time `toolName` config (default `subagent`); the schema above is that default. The shipped example agents load this package once per subagent backend, so the model additionally sees `subagent_fork` (bound to the fork backend) with an identical schema — see `examples/coding-agent/cordis.yml` and `examples/acp-agent/cordis.yml`.',
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
    pkg: '@deepseek-ai/dsh-tool-web',
    dir: 'tool-web',
    source: 'packages/web/tool-web/src/index.ts',
    requires: ['ctx.tools', 'ctx.web', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The tools inject `web`; boot the seam plus one search and one fetch
      // provider so both `web_search` and `web_fetch` register. The schemas do
      // not depend on which provider backs the seam (or on it being available),
      // so any registered provider is enough to harvest them.
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
    'This file is GENERATED and verified fresh by `pnpm run verify-tool-catalog` (part of `doc-sync`) — do not edit it by hand. Unlike the cordis catalog (a pure source-AST pass), this generator BOOTS each tool plugin on a real context and reads `ctx.tools.schemas()`, because a tool schema is not statically knowable (runtime-spread enums, concatenated descriptions, config-driven names, raw-JSON-Schema MCP tools). A completeness guard globs `packages/*/tool-*` and fails if any package is missing from the generator\'s boot manifest, so a new tool cannot be silently undocumented. See [the tool-schema-catalog RFC](rfc/implemented/process/2026-07-02-tool-schema-catalog.md).',
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
