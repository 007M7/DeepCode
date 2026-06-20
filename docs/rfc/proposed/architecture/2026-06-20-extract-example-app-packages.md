# RFC: Extract example apps into packages

Status: proposed

## Problem

An example folder is supposed to be *thin* — the variable wiring of a demo, not the demo's machinery. Today it is thick. Each example carries a hand-rolled `start.ts` boot bootstrap, an infra preamble (`timer`, and — for the stdio demos — `logger` + `hmr`), nested includes of three shared YAML fragments, and per-example `agent-loop`/persistence/system-prompt config. The actual app — the spine of services every agent needs — is spread across the leaf and the [base.yml](../../../../examples/base.yml) / [base-core.yml](../../../../examples/base-core.yml) / [acp-tail.yml](../../../../examples/acp-agent/acp-tail.yml) includes.

The deeper problem is a **coupled front-door cluster** that lives at the leaf with nothing enforcing it. Choosing the ACP bridge over `ui-stdio` is not one swappable line: an ACP server must **drop the stdout console logger** (stdout is the JSON-RPC channel — a stray log corrupts the frames), omit `hmr` (the editor owns the subprocess), and pre-create **no** agents (ACP `session/new` creates them on demand), whereas the stdio app needs a console logger, `hmr`, and a pre-created `main`. (`timer` is the one infra plugin common to both — it writes nothing to stdout — so it belongs in the shared spine, not the cluster.) Today that coupling is enforced only by prose warnings in [acp-agent/cordis.yml](../../../../examples/acp-agent/cordis.yml) and [base-core.yml](../../../../examples/base-core.yml). A leaf that wires a console logger into the ACP config is a one-line, comment-only mistake away — exactly the [stdout-purity footgun](../../implemented/feature/2026-06-18-acp-terminal-and-tool-rendering.md) the examples guard by hand. The three `start.ts` files also duplicate the Loader-boot tail, the `.env` loader, and (for ACP) snapshot-mode branching and the stdin-dispose lifecycle.

## Proposal

Make each example **mostly an invocation of an app package**, splitting the wiring along the existing [interface / implementation / consumer seam](../../implemented/architecture/2026-06-13-capability-seams.md): the **app package owns the composition**, the leaf `cordis.yml` owns only the **swappable choices** (which LLM adapter, which bash executor, model, prompt, persistence root).

- **`@deepseek-ai/dsh-agent-core`** — a Cordis bundle plugin for the providerless, executor-less, UI-less spine: `timer` + `llm` + sessions + system-prompt + tools + agents + invariants + `tool-bash` + `agent-loop`. This is today's [base-core.yml](../../../../examples/base-core.yml) **minus** `bash-local`, **plus** `timer` and the loop, as code instead of a YAML include. The bundle **forwards** `agent-loop`'s `agents` list as its own config (default `[]`, exactly the existing `AgentLoop.Config` shape in [packages/core/agent-loop/src/index.ts](../../../../packages/core/agent-loop/src/index.ts)) — so each app supplies its own pre-created agents. This is precisely the reason [base-core.yml](../../../../examples/base-core.yml) gives today for keeping `agent-loop` *out* of the shared core ("the examples disagree — stdio needs a pre-created `main`, acp needs none"); forwarding the config dissolves that objection — the loop is shared, the agents list is per-app.
- **`@deepseek-ai/dsh-stdio-agent`** and **`@deepseek-ai/dsh-acp-agent`** — app packages, each consuming `dsh-agent-core` and **baking in its coupled front-door cluster**: stdio = `ui-stdio` + console logger + `hmr` + a pre-created `main`; acp = the `acp` bridge + **no stdout logger** + no `hmr` + no pre-created agents. The coupling becomes structurally unreachable from the leaf.
- **Drop `start.ts`.** Each app package exposes a `bin`; the `demo:*` scripts invoke it (e.g. `dsh-stdio-agent ./cordis.yml`). The Loader-boot tail, `.env` loading, snapshot-mode selection, and stdin-dispose lifecycle move into that bin, owned by the app.
- **Collapse each leaf `cordis.yml`** to backends + config: the LLM adapter (`llm-deepseek` with apiKey/models, or `llm-replay`), the bash executor (`bash-local`), and one app-bundle entry carrying the app's config (model, system prompt, persistence root — surfaced as the app package's own `Config`, which routes each value to wherever the app wires it: stdio onto its pre-created agent, acp onto the bridge plugin). A handful of entries, no infra preamble.
- **Fold echo-agent onto `dsh-stdio-agent`**, swapping the LLM backend to the local `mock-llm` and adding the local `echo-tool` at the leaf — the clean demonstration of "swap the backend, keep the app". `mock-llm.ts` / `echo-tool.ts` stay as example-local teaching plugins.
- **Retire** [base.yml](../../../../examples/base.yml), [base-core.yml](../../../../examples/base-core.yml), and [acp-tail.yml](../../../../examples/acp-agent/acp-tail.yml) — the spine they shared now lives in `dsh-agent-core`.

`bash-local` and the LLM adapter stay **leaf choices**: the bundle ships `tool-bash` (the consumer schema), the leaf picks the executor implementation, so a sandboxed executor or replay adapter swaps in without touching the app.

## Why not keep the wiring in shared YAML includes?

The `base*.yml`/`acp-tail.yml` includes already dedupe the *config*, but a YAML include cannot **encapsulate** the front-door coupling — it can only describe it in a comment and trust every leaf to obey. It also cannot own a `bin`, so the boot glue stays copied across three `start.ts` files. A package turns "the ACP app never logs to stdout" from a prose warning into a property of the artifact: there is no logger entry in the leaf to get wrong.

## Acceptance criteria

- Each example directory is `cordis.yml` + `README.md` + tests only — no `start.ts`, no infra preamble; `base.yml`/`base-core.yml`/`acp-tail.yml` are gone.
- `demo:echo` / `demo:coding` / `demo:acp` run via the app-package `bin`s.
- `pnpm run test`, `pnpm run test:snapshot` (re-recorded), `pnpm run typecheck`, `pnpm run knip`, `pnpm run publint`, and `pnpm run doc-sync` are green; the new packages carry the per-file 100% coverage gate and a README like every `@deepseek-ai/dsh-*`.

## What we give up

- **The bare-plugin-tree pedagogy.** echo-agent's inlined `cordis.yml` showed every plugin at once; the spine now lives behind a bundle, so seeing the whole tree means opening `dsh-agent-core`. The app package's README must carry that teaching weight.
- **A layer of indirection.** "What does this demo load?" becomes a package read, not a single YAML scan.
- **Migration cost** (the implementing PR, not this one): three new packages, three leaf rewrites, the boot glue moved into bins, re-recorded ACP snapshots, and rewritten example READMEs + [examples/AGENTS.md](../../../../examples/AGENTS.md).

## Related

- Supersedes [Make the shared example base providerless](../../rejected/architecture/2026-06-20-providerless-example-base.md): renaming `base.yml` to the providerless core is moot once the spine moves into `dsh-agent-core` and the `base*.yml` files are deleted.
- Builds on the [capability-seams](../../implemented/architecture/2026-06-13-capability-seams.md) interface/implementation/consumer split — backends and presentation stay leaf choices; the spine is the shared bundle.
- Complements [Reorganize packages into a modular hierarchy](../../implemented/architecture/2026-06-20-package-hierarchy.md): the new app/core packages slot into a group under that hierarchy (a product group for the reusable core bundle, or alongside the examples for app-specific wiring).
