# RFC: Generated tool-schema catalog (boot-and-harvest)

Status: implemented

## Problem

A reader — a plugin author, a prompt engineer, someone auditing what the agent can do — has no single place that lists the model-facing tools the harness ships. The `name` / `description` / JSON-Schema `parameters` a tool contributes are what the model actually receives (via `ctx.systemPrompt.tools()` off `ctx.tools.schemas()`), but they are scattered across each `defineTool` call in each `packages/*/tool-*` package, buried in string concatenation and runtime spreads. The cordis [events](../../../cordis-catalog/events.md) & [services](../../../cordis-catalog/services.md) catalogs ([their RFC](2026-06-20-generated-cordis-catalog.md)) document the *wiring* a plugin works against and the [core-data-structures catalog](../../../core-data-structures/core.md) documents the *vocabulary* those signatures move — but neither documents the *tools* the agent is offered. This RFC adds that third reference surface, `docs/tool-catalog/tools.md`, and a freshness gate so it cannot drift.

## Decision

Generate the catalog by **booting each tool plugin and reading its registered schemas**, not by parsing source. `scripts/gen-tool-catalog.ts` mounts each shipped tool package on a fresh cordis `Context` (with `SystemPrompt` + `ToolRegistry` and the injected seams the plugin's `apply` reads), calls `ctx.tools.schemas()` — exactly the `ToolSchema[]` the model is sent — disposes the context, and renders one `## <package>` section per package with a ` ```json ` `parameters` block per tool. It mirrors the `gen-cordis-catalog` / `gen-module-graph` CLI shape: default `--write` regenerates, `--check` fails if the committed copy is stale, output is deterministic (manifest-ordered, tools sorted by name). `verify-tool-catalog` (the `--check`) runs inside `doc-sync`, so the freshness gate fires in the same lefthook pre-push and CI paths as every other doc gate.

### Why boot, not parse (the crux)

The cordis catalog is a pure TypeScript-AST pass because every event/service name is a string literal that round-trips to a static declaration — the AST is the whole truth. **Tool schemas are not statically knowable**, so the same technique would produce a doc that lies:

- `tool-todo` writes `enum: [...STATUSES]` — a spread of a runtime `const`. The AST sees the spread expression, not `["pending","in_progress","completed"]`.
- Every description is built by string **concatenation** (`'…' + '…'`). The AST sees concatenation nodes, not the final prose the model reads.
- `tool-subagent`'s tool name is `config.toolName ?? 'subagent'` — chosen at load, not a literal.
- An MCP plugin can register **raw JSON Schema** directly via `ctx.tools.register()` without `defineTool` at all, so enumerating `defineTool(` call sites structurally under-counts.

The only faithful source of truth is the schema the registry actually holds after the plugin loads. Booting is the [testing-policy discipline](../../../testing.md) "verify the world, not the self-report" applied to a doc generator: read the shipped artifact, not a re-derivation of it.

### Restoring "nothing silently omitted"

Booting has a cost the AST pass did not: there is no source declaration set to enumerate, so a new tool package could simply be forgotten. A **completeness guard** restores the guarantee — `assertManifestComplete` globs every `tool-*` package under `packages/` and hard-errors if any is absent from the generator's boot manifest. A new tool package fails the generator, and therefore `doc-sync`, until it is registered. This is the same structural property the cordis generator gets for free from enumerating source, re-created for a boot-based generator.

### A hand-maintained boot manifest is the irreducible policy

The boot manifest (`TOOL_PACKAGES`) is a hand-written list — in tension with the proposed [Discover package inventories instead of maintaining static lists](../../proposed/process/2026-06-20-discover-package-inventory.md). The tension is deliberate and resolved as follows: the *inventory* is discovered (the glob guard means no one maintains "the list of tool packages" — the filesystem is the source of truth, and drift fails the gate), but the *boot recipe* per package — which seams to plug (`bash-local` for `ctx.bash`, `subagent` + `subagent-mock` for `ctx.subagents`) and with what config (`{ provider: 'mock' }`) — is genuine policy that no layout fact encodes. Per that RFC's own "what we give up" ("stay boring: read manifests, filter on explicit fields, print the resolved list, and fail loud"), a recipe closure is the boring, explicit form; inferring seam wiring from injects would be the "too clever" path it warns against. So: discovered inventory, hand-written recipe, gate on completeness.

### Scope

Shipped product tool PACKAGES under `packages/*/tool-*`, each booted with its default config: `dsh-tool-bash` (`bash`, `bash_output`, `bash_kill`), `dsh-tool-todo` (`todo_write`), `dsh-tool-subagent` (`subagent`). The `examples/` demo tools (`echo`) are excluded, matching the cordis catalog's packages-only scope — a demo tool is not part of the product surface a reader is cataloguing.

The unit is the PACKAGE, not the deployed tool instance. A package's registered tool name can be a load-time config — `tool-subagent`'s `toolName` — so the same package surfaces as `subagent` (spawn backend) AND `subagent_fork` (fork backend) in the shipped `coding-agent` / `acp-agent` configs, with an identical schema. The generator boots each package once at its default and records such shipped aliases in a per-package note, rather than enumerating every deployment permutation. Cataloguing at the package level keeps the source of truth the package (what a plugin author reads) and avoids leaking example-app `cordis.yml` config into a packages-scoped generator; the note keeps the doc honest about the names a reader will actually see the model receive. The design deliberately does not attempt to catalog "every configured tool instance across every leaf config" — that is a deployment inventory, a different (and unbounded) surface.

### A plain `json` fence

Schema blocks use ` ```json `, not a bespoke `ts`-family fence. `doc-typecheck` only extracts `ts*` fences, so a JSON block is invisible to it — no `BlockKind` wiring is needed (unlike the cordis catalog's `ts cordis-catalog` fence, which had to be allowlisted so a bare signature fragment isn't compiled).

## Alternatives considered

- **A pure TypeScript-AST pass, like the cordis catalog** — tool schemas are not statically knowable (the crux above): runtime spreads, string concatenation, config-chosen names, and raw `ctx.tools.register()` registrations all make an AST-derived doc lie.
- **Inferring each package's boot recipe from its injects** — the "too clever" path [the discover-package-inventory proposal](../../proposed/process/2026-06-20-discover-package-inventory.md) warns against; the recipe stays hand-written policy while the inventory is discovered and completeness-guarded.
- **A bespoke `ts`-family fence for schema blocks** — unnecessary: a plain ` ```json ` fence is invisible to `doc-typecheck`, so no `BlockKind` allowlisting is needed.

## Consequences

- The catalog cannot drift: a tool schema change the committed file doesn't reflect fails `verify-tool-catalog` in the pre-push hook and CI. A new `tool-*` package not added to the manifest fails the completeness guard outright.
- Tool description prose has a single home — the `defineTool` `description` at the source — and the generated entry is only as good as it, the same forcing function the cordis catalog applies to event JSDoc.
- The generator imports and executes workspace packages (the first repo script to do so; the others only read text). It runs under `tsx` via the root `tsconfig` `paths` map, the same unbuilt-source path the demos and tests use, so it needs no build step.
- A new capability seam behind a future tool means a new manifest recipe entry (which seams to mount). This is the deliberate hand-written cost called out above; it changes only when a tool package is added.
