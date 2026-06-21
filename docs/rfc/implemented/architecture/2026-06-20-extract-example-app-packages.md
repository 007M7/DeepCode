# RFC: Extract example apps into packages

Status: implemented

## Problem

An example folder is supposed to be *thin* — the variable wiring of a demo, not the demo's machinery. Before this change it was thick. Each example carried a hand-rolled `start.ts` boot bootstrap, an infra preamble (`timer`, and — for the stdio demos — `logger` + `hmr`), nested includes of three shared YAML fragments (`base.yml` / `base-core.yml` / `acp-agent/acp-tail.yml`), and per-example `agent-loop`/persistence/system-prompt config. The actual app — the spine of services every agent needs — was spread across the leaf and those includes.

The deeper problem was a **coupled front-door cluster** that lived at the leaf with nothing enforcing it. Choosing the ACP bridge over `ui-stdio` was not one swappable line: an ACP server must **drop the stdout console logger** (stdout is the JSON-RPC channel — a stray log corrupts the frames) and pre-create **no** agents (ACP `session/new` creates them on demand), whereas the stdio app needs a console logger and a pre-created `main`. (`timer` is the one infra plugin common to both — it writes nothing to stdout — so it belongs in the shared spine, not the cluster.) That coupling was enforced only by prose warnings in the leaf YAML. A leaf that wired a console logger into the ACP config was a one-line, comment-only mistake away — exactly the [stdout-purity footgun](../feature/2026-06-18-acp-terminal-and-tool-rendering.md) the examples guarded by hand. The three `start.ts` files also duplicated the Loader-boot tail, the `.env` loader, and (for ACP) snapshot-mode branching and the stdin-dispose lifecycle.

## What shipped

Each example is now **mostly an invocation of an app package**, splitting the wiring along the existing [interface / implementation / consumer seam](2026-06-13-capability-seams.md): the **app package owns the composition**, the leaf `cordis.yml` owns only the **swappable choices** (which LLM adapter, which bash executor, model, prompt, persistence root).

- **`@deepseek-ai/dsh-agent-core`** ([packages/core/agent-core](../../../../packages/core/agent-core)) — a Cordis bundle plugin for the providerless, executor-less, UI-less spine: `timer` + `llm` + sessions + system-prompt + tools + agents + invariants + `tool-bash` + `agent-loop`, mounted as child plugins inside its `apply(ctx)` via `ctx.plugin(...)`. This is the old `base-core.yml` **minus** `bash-local`, **plus** `timer` and the loop, as code instead of a YAML include. The bundle **forwards** `agent-loop`'s `agents` list as its own config (`export const Config = AgentLoop.Config`, default `[]`, the existing `AgentLoop.Config` shape in [packages/core/agent-loop/src/index.ts](../../../../packages/core/agent-loop/src/index.ts)) — so each app supplies its own pre-created agents. This is precisely the reason the old `base-core.yml` gave for keeping `agent-loop` *out* of the shared core ("the examples disagree — stdio needs a pre-created `main`, acp needs none"); forwarding the config dissolves that objection — the loop is shared, the agents list is per-app. The bundle children register into the root service store, so a leaf-mounted sibling (the adapter, the executor) sees them exactly as a nested `plugin-include` subtree's services were seen before. Depending on the CONCRETE `dsh-agent-loop` (not just the `dsh-agent` interface) is deliberate and is the sanctioned exception to the "extension plugins depend on interfaces, never on the concrete loop" rule (packages/README.md, docs/architecture.md § Layering): the rule constrains plugins that EXTEND the system, whereas this bundle's whole job is to COMPOSE the concrete spine. Swapping the loop means publishing a different bundle, not rewiring every extension.
- **`@deepseek-ai/dsh-stdio-agent`** ([packages/ui/stdio-agent](../../../../packages/ui/stdio-agent)) and **`@deepseek-ai/dsh-acp-agent`** ([packages/ui/acp-agent](../../../../packages/ui/acp-agent)) — app packages, each consuming `dsh-agent-core` and **baking in its coupled front-door cluster**: stdio = `ui-stdio` + console logger + a pre-created `main`; acp = the `acp` bridge + JSONL persistence + **no stdout logger** + no pre-created agents. The leaf no longer carries the cluster, so it has no logger entry to copy wrong by default — the common stdout-purity mistake loses its foothold. (A leaf can still *add* a sibling logger entry — a package cannot forbid what a leaf author writes — so the rule "never add a stdout logger to an ACP leaf" stays documented at the leaf; what changed is that the default leaf has nothing to get wrong.) They land under the existing `ui` group alongside `acp`, so no new package group (and no `tsconfig`/`packages/README` group plumbing) was needed.
- **`start.ts` is gone.** Each app package exposes a `bin` (`dsh-stdio-agent` / `dsh-acp-agent`); the `demo:*` scripts invoke it (e.g. `dsh-stdio-agent ./cordis.yml`). The Loader-boot tail, `.env` loading, snapshot-mode selection, and stdin-dispose lifecycle moved into that bin, owned by the app. The `bin.ts` files are coverage-excluded (a self-executing CLI entry, like the old `start.ts`) and driven by the keyless Loader-path tests.
- **Each leaf `cordis.yml` collapses** to backends + config: the LLM adapter (`llm-deepseek` with apiKey/models, or `llm-replay`), the bash executor (`bash-local`), `hmr` for the stdio demos (see the amendment below), and one app entry carrying the app's config (model, system prompt, persistence root — surfaced as the app package's own `Config`, which routes each value to wherever the app wires it: stdio onto its pre-created agent, acp onto the bridge plugin).
- **echo-agent folds onto `dsh-stdio-agent`**, swapping the LLM backend to the local `mock-llm` and adding the local `echo-tool` (plus `bash-local`, which the spine's `tool-bash` injects) at the leaf — the clean demonstration of "swap the backend, keep the app". `mock-llm.ts` / `echo-tool.ts` stay as example-local teaching plugins.
- **`base.yml`, `base-core.yml`, and `acp-agent/acp-tail.yml` are retired** — the spine they shared now lives in `dsh-agent-core`.

`bash-local` and the LLM adapter stay **leaf choices**: the bundle ships `tool-bash` (the consumer schema), the leaf picks the executor implementation, so a sandboxed executor or replay adapter swaps in without touching the app.

### Amendment on implementation: `hmr` stays a leaf entry

The proposal listed `hmr` among the stdio app's baked-in front-door cluster. Validating against the code, baking `hmr` into the `dsh-stdio-agent` package fights cordis in two ways, so it ships as a **leaf `cordis.yml` entry** instead:

1. `@cordisjs/plugin-hmr` is a Loader-only, subprocess-only dev plugin — its constructor throws without `node --expose-internals` + a live `loader` service, so it can only run in the real `demo:*`/bin subprocess, never in the in-process unit/coverage tier.
2. The in-process test tier (vitest) cannot even *import* the vendored `hmr` module (its class-decorator `@Inject` form fails under Vite's transform), so a package whose `apply` statically imported it could never satisfy the per-file 100% coverage gate on its headline function.

Crucially, `hmr` is **not** a stdout-purity footgun the way the console logger is — a stray `hmr` in the ACP config would not corrupt the JSON-RPC frames — so leaving it at the leaf costs none of the safety the coupling argument is about. The **logger** (the real coupling) stays baked in: the stdio app includes it, the ACP app omits it.

## Why not keep the wiring in shared YAML includes?

The old `base*.yml`/`acp-tail.yml` includes already deduped the *config*, but a YAML include cannot **encapsulate** the front-door coupling — it can only describe it in a comment and trust every leaf to obey. It also cannot own a `bin`, so the boot glue stayed copied across three `start.ts` files. A package turns "the ACP app never logs to stdout" from a prose warning into a property of the artifact: there is no logger entry in the leaf to get wrong.

## Verification

- Each example directory is `cordis.yml` (+ the acp `cordis.snapshot.yml`) + `README.md` + tests only — no `start.ts`, no infra preamble; `base.yml`/`base-core.yml`/`acp-tail.yml` are gone.
- `demo:echo` / `demo:coding` / `demo:acp` run via the app-package `bin`s.
- The new packages carry the per-file 100% coverage gate and a README like every `@deepseek-ai/dsh-*`. Each app package has a keyless **real-load-path** smoke that boots it through its `bin` + the cordis Loader (not a hand-built `ctx.plugin({...})` mount), guarding the `unwrapExports` export-shape bug class ([postmortem 0001](../../../postmortem/0001-acp-default-export-drops-inject.md)).
- The ACP snapshot **replay** transcript is unchanged: the boot restructuring preserved the plugin set + load order, so `pnpm run test:snapshot` stays green against the committed goldens with no re-record.

## What we give up

- **The bare-plugin-tree pedagogy.** echo-agent's inlined `cordis.yml` showed every plugin at once; the spine now lives behind a bundle, so seeing the whole tree means opening `dsh-agent-core`. The app package's README carries that teaching weight.
- **A layer of indirection.** "What does this demo load?" becomes a package read, not a single YAML scan.

## Related

- Supersedes [Make the shared example base providerless](../../rejected/architecture/2026-06-20-providerless-example-base.md): renaming `base.yml` to the providerless core is moot once the spine moves into `dsh-agent-core` and the `base*.yml` files are deleted.
- Builds on the [capability-seams](2026-06-13-capability-seams.md) interface/implementation/consumer split — backends and presentation stay leaf choices; the spine is the shared bundle.
- Complements [Reorganize packages into a modular hierarchy](2026-06-20-package-hierarchy.md): the new app/core packages slot into existing groups under that hierarchy (`core` for the reusable spine bundle, `ui` for the app-specific front doors).
