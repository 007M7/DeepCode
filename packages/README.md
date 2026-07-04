# Packages

Harness packages, all under the `@deepseek-ai/dsh-*` scope. Each package is a Cordis plugin (microkernel-style): it exports either a default `Service` subclass or a functional plugin that gets registered via `ctx.plugin()`, declares its ctx key/events where applicable through declaration merging, and exposes extension points through `ctx.effect()`, `ctx.on()`, and `ctx.waterfall()`.

## Hierarchy

Packages are grouped by modular role at `packages/<group>/<pkg>/`. The group directory is a pure container (no `package.json` of its own); the package name stays `@deepseek-ai/dsh-<pkg>` regardless of group. Each group has a `README.md` describing its role and whether it is product or support infrastructure.

| Group | Role | Release expectation |
|---|---|---|
| [`core/`](core/README.md) | Product API spine: session, system-prompt, tools, agent, and the concrete loop | Product — stable surface |
| [`llm/`](llm/README.md) | LLM capability family: the abstract service + provider adapters | Product — stable surface |
| [`bash/`](bash/README.md) | Bash capability family: the executor seam, a local impl, and the model-facing tool | Product — stable surface |
| [`fs/`](fs/README.md) | Filesystem capability family: the abstract seam, a local impl, and the model-facing file tools | Product — stable surface |
| [`compact/`](compact/README.md) | Compaction capability family: the abstract seam + a basic backend (tool deferred) | Product — stable surface |
| [`subagent/`](subagent/README.md) | Subagent capability family: the provider-registry seam and the model-facing delegation tool | Product — stable surface |
| [`web/`](web/README.md) | Web capability family: the abstract seam, search/fetch provider impls, and the model-facing web tools | Product — stable surface |
| [`todo/`](todo/README.md) | Todo/planning family: the model-facing `todo_write` tool (whole-list task tracking on the session log) | Product — stable surface |
| [`hooks/`](hooks/README.md) | Hook bridges + the shared Claude Code / Codex wire-protocol library | Product — stable surface |
| [`session-persistence/`](session-persistence/README.md) | Persistence capability family: the seam + JSONL/SQLite backends | Product — stable surface |
| [`ui/`](ui/README.md) | Editor/client integration surfaces (the ACP bridge) | Product — stable surface |
| [`support/`](support/README.md) | Dev/test/example infrastructure (invariants, stdio UI, replay adapter) | Support — lower compatibility expectations |
| [`util/`](util/README.md) | Low-level zero-dependency utilities shared across groups (the `Branded<B>` primitive) | Support — small, stable, harness-dep-free |

The split is the point: a package's group says whether it is part of the product API or support/test/example infrastructure, so release and removal decisions do not have to treat every package as an equal public contract. New packages join an existing group; adding a new top-level group is a deliberate act (extend the group READMEs and the hierarchy docs).

## Dependency graph

```
dsh-brand         (no harness deps — type-only Branded<B> primitive)
dsh-llm          ← dsh-brand                       (vocabulary; brands CallId)
dsh-bash          ← dsh-brand                       (abstract executor seam; brands BashTaskId/OwnerToken)
dsh-session       ← dsh-llm, dsh-brand
dsh-system-prompt ← dsh-llm
dsh-agent         ← dsh-llm, dsh-session, dsh-brand
dsh-compact       ← dsh-session, dsh-llm                (abstract compaction seam; tool deferred)
dsh-compact-basic ← dsh-compact, dsh-session, dsh-llm, dsh-agent  (char/4 + token-budget retention backend)
dsh-tools         ← dsh-llm, dsh-system-prompt, dsh-agent
dsh-bash-local    ← dsh-bash                       (BashExecutor impl)
dsh-tool-bash     ← dsh-bash, dsh-tools            (bash tool schemas)
dsh-fs            ← dsh-llm, dsh-brand              (filesystem provider seam + fs/* events)
dsh-fs-local      ← dsh-fs                          (FileSystem impl)
dsh-fs-policy     ← dsh-fs                          (observed-state + freshness policy gate, no service)
dsh-tool-fs       ← dsh-fs, dsh-tools               (file tools + executor)
dsh-web           ← dsh-llm                          (abstract web seam; search/fetch registries, WebError)
dsh-web-search-exa        ← dsh-web                  (Exa WebSearchProvider)
dsh-web-search-perplexity ← dsh-web                  (Perplexity WebSearchProvider)
dsh-web-search-deepseek   ← dsh-web                  (DeepSeek native-web-search WebSearchProvider)
dsh-web-fetch-local       ← dsh-web                  (anonymous public HTTP(S) WebFetchProvider)
dsh-tool-web      ← dsh-web, dsh-tools, dsh-system-prompt  (web tool schemas)
dsh-llm-deepseek  ← dsh-llm                        (DeepSeek adapter)
dsh-llm-pi-ai     ← dsh-llm                        (pi-ai-backed adapter)
dsh-agent-loop    ← dsh-llm, dsh-session, dsh-session-persistence, dsh-system-prompt, dsh-tools, dsh-agent
dsh-invariants    ← dsh-llm, dsh-session, dsh-agent (dev-mode contract checks)
dsh-acp           ← dsh-agent, dsh-llm, dsh-session, dsh-session-persistence, dsh-tools  (ACP JSON-RPC bridge)
dsh-ui-stdio      ← dsh-agent, dsh-llm, dsh-session (stdio readline UI plugin)
dsh-llm-replay    ← dsh-llm, dsh-session            (record/replay adapter for keyless snapshot tests)
dsh-subagent      ← dsh-agent, dsh-llm, dsh-tools    (abstract subagent provider-registry seam)
dsh-subagent-inprocess ← dsh-subagent, dsh-agent, dsh-session, dsh-llm  (shared in-process run driver)
dsh-subagent-mock ← dsh-subagent, dsh-agent, dsh-llm  (scripted provider for tests)
dsh-subagent-spawn ← dsh-subagent, dsh-subagent-inprocess  (in-process fresh child backend)
dsh-subagent-fork ← dsh-subagent, dsh-subagent-inprocess, dsh-agent, dsh-session  (in-process child seeded from parent log)
dsh-subagent-acp  ← dsh-subagent, dsh-agent, dsh-llm, @agentclientprotocol/sdk  (out-of-process child over ACP)
dsh-tool-subagent ← dsh-subagent, dsh-tools, dsh-agent, dsh-llm (model-facing delegation tool)
dsh-tool-todo     ← dsh-tools, dsh-agent, dsh-session  (model-facing todo_write tool; whole list on the session log)
dsh-agent-core    ← timer, dsh-llm, dsh-session, dsh-system-prompt, dsh-tools, dsh-agent, dsh-invariants, dsh-tool-bash, dsh-agent-loop  (the providerless spine, as one bundle plugin)
dsh-stdio-agent   ← dsh-agent-core, dsh-ui-stdio, dsh-session-persistence-jsonl, dsh-agent, dsh-session  (stdio chat APP + bin)
dsh-acp-agent     ← dsh-agent-core, dsh-acp, dsh-session-persistence-jsonl     (ACP server APP + bin)
```

The rule: **extension** plugins depend on interfaces, never on the concrete loop. `dsh-agent-loop` is swappable — UI/hook/tool plugins keep working against the `dsh-agent` vocabulary if the loop is replaced. The sanctioned exception is a **composition/bundle** package like `dsh-agent-core`, whose whole job is to assemble the concrete spine: it depends on `dsh-agent-loop` (and the other concrete spine plugins) on purpose. The rule constrains plugins that EXTEND the system, not the bundle that COMPOSES it — swapping the loop means shipping a different bundle, not rewiring every extension. A swappable capability splits into interface / implementation / consumer packages (the bash trio is the template — see [capability seams](../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)).

## What goes where

| Package | Group | Role | ctx key |
|---|---|---|---|
| `llm/` | `llm` | Abstract LLM service + content-block vocabulary + chunk assembler | `ctx.llm` |
| `session/` | `core` | Event-sourced session log + in-memory store | `ctx.sessions` |
| `system-prompt/` | `core` | Prompt-section + tool-schema assembly registry | `ctx.systemPrompt` |
| `tools/` | `core` | Tool registry + `tools/pre-execute`/`tools/post-execute` pipeline | `ctx.tools` |
| `agent/` | `core` | Agent interface, registry, `agent/*` event vocabulary | `ctx.agents` |
| `agent-loop/` | `core` | THE concrete loop plugin: `ReactLoopAgent` + the loop driver | `ctx.agentLoop` |
| `agent-core/` | `core` | Bundle plugin: the providerless/executor-less/UI-less spine as code (forwards `agent-loop`'s `agents`) | (loads the spine) |
| `bash/` | `bash` | Abstract bash executor seam (interface + vocabulary) | `ctx.bash` |
| `bash-local/` | `bash` | Local-subprocess `BashExecutor` implementation | (registers `ctx.bash`) |
| `tool-bash/` | `bash` | Model-facing `bash`/`bash_output`/`bash_kill` tool schemas | (registers on `ctx.tools`) |
| `fs/` | `fs` | Filesystem provider seam: text IO + atomic mutation primitives (optional version guard); owns the `fs/*` events | `ctx.fs` |
| `fs-local/` | `fs` | Local-filesystem `FileSystem` implementation | (registers `ctx.fs`) |
| `fs-policy/` | `fs` | Policy gate plugin: observed-state + read-before-edit + version-guarded write/edit via the `fs/*` event gate | (no service — `fs/*` listeners) |
| `tool-fs/` | `fs` | Model-facing `read`/`write`/`edit` tools + executor (reads via `ctx.fs`, owns read windowing, dispatches `fs/*`) | (registers on `ctx.tools`) |
| `compact/` | `compact` | Abstract compaction seam + `compact/*` events + `CompactionResult` | `ctx.compact` |
| `compact-basic/` | `compact` | A backend: char/4 estimation + token-budget retention + `llm.stream()` summarization | (registers `ctx.compact`) |
| `web/` | `web` | Abstract web seam (search/fetch provider registries + selection + vocabulary + `WebError`) | `ctx.web` |
| `web-search-exa/` | `web` | Exa-backed `WebSearchProvider` | (registers on `ctx.web`) |
| `web-search-perplexity/` | `web` | Perplexity-backed `WebSearchProvider` | (registers on `ctx.web`) |
| `web-search-deepseek/` | `web` | DeepSeek-backed `WebSearchProvider` using native `web_search` through the Anthropic-compatible API | (registers on `ctx.web`) |
| `web-fetch-local/` | `web` | Anonymous public HTTP(S) `WebFetchProvider` | (registers on `ctx.web`) |
| `tool-web/` | `web` | Model-facing `web_search`/`web_fetch` tool schemas | (registers on `ctx.tools`) |
| `llm-deepseek/` | `llm` | DeepSeek API adapter (hand-rolled fetch/SSE) | (registers on `ctx.llm`) |
| `llm-pi-ai/` | `llm` | DeepSeek adapter via `@earendil-works/pi-ai` (design twin) | (registers on `ctx.llm`) |
| `session-persistence/` | `session-persistence` | Persistence seam + write coordinator | `ctx.sessionPersistence` |
| `session-persistence-jsonl/` | `session-persistence` | JSONL-sidecar persistence backend | (registers `ctx.sessionPersistence`) |
| `session-persistence-sqlite/` | `session-persistence` | SQLite persistence backend | (registers `ctx.sessionPersistence`) |
| `invariants/` | `support` | Dev-mode event-contract invariants + session-log freeze | (listens on `session/*`, `agent/*`) |
| `acp/` | `ui` | Agent Client Protocol bridge: serves the agent to an ACP editor over JSON-RPC stdio | (drives `ctx.agents`/`ctx.sessions`) |
| `stdio-agent/` | `ui` | Terminal stdio chat APP: agent-core spine + console logger + readline UI + a pre-created `main` agent, with a `bin` | (composition + `bin`) |
| `acp-agent/` | `ui` | ACP server APP: agent-core spine + JSONL persistence + the `acp` bridge (no stdout logger), with a `bin` | (composition + `bin`) |
| `ui-stdio/` | `support` | Minimal stdio (readline) UI plugin: renders `agent/*` events, feeds stdin lines to the agent | (drives `ctx.agents`) |
| `llm-replay/` | `support` | Record/replay adapter: short-circuits `llm/stream` with chunks from a recorded session JSONL (keyless snapshot tests) | (listens on `llm/stream`) |
| `subagent/` | `subagent` | Abstract subagent seam: named-provider registry for delegating to child agents | `ctx.subagents` |
| `subagent-inprocess/` | `subagent` | Shared in-process subagent run driver used by spawn/fork; pure library, registers nothing | (none) |
| `subagent-spawn/` | `subagent` | In-process backend: a fresh child agent | (registers on `ctx.subagents`) |
| `subagent-fork/` | `subagent` | In-process backend: a child agent seeded with the parent's completed-turn prefix | (registers on `ctx.subagents`) |
| `subagent-acp/` | `subagent` | Out-of-process backend: a child agent in a spawned subprocess, driven over the Agent Client Protocol | (registers on `ctx.subagents`) |
| `subagent-mock/` | `support` | Scripted `SubagentProvider` for testing the seam through the real load path | (registers on `ctx.subagents`) |
| `tool-subagent/` | `subagent` | Model-facing `subagent` delegation tool over `ctx.subagents` | (registers on `ctx.tools`) |
| `tool-todo/` | `todo` | Model-facing `todo_write` tool; writes the whole task list to the session log (`todo/write`) | (registers on `ctx.tools`) |
| `hook-protocol/` | `hooks` | Shared Claude Code / Codex hook wire-protocol library: matcher, codec, `runHook`, merge, `hook/*` events | (none — library, no service) |
| `brand/` | `util` | Type-only `Branded<B>` nominal-typing primitive (no runtime code, no harness deps) | (none — type-only) |

Each package has its own `README.md` with purpose, service API, events, extension points, and deliberate non-goals (TODOs).

## Conventions (applied across all harness packages)

- **Registrations are effects**: every contribution (adapter, tool, section, agent, event listener) goes through `ctx.effect()` / `ctx.on()`, so disposal and HMR clean up automatically. Every `register()` returns the disposer.
- **Declaration merging for events and ctx**: services declare their events in `declare module 'cordis' { interface Events { ... } }` and their ctx key in `interface Context`.
- **Waterfall semantics**: `ctx.waterfall` listeners receive `(...args, next)` and MUST call `next()` to delegate; returning without it short-circuits (the veto mechanism).
- **Extensible unions**: `ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap`, `TurnTriggerMap`, `TurnEndReasonMap`, and `SessionEventMap` use the merge-extensible-map pattern so plugins can add variants via declaration merging.
- **ESM everywhere**; imports use package names across package boundaries and explicit `.ts` relative specifiers within a package.
- **Tests**: vitest, colocated under `packages/<group>/<pkg>/tests/*.spec.ts`. Every registry needs an HMR-safety test. Err on the side of more tests.
