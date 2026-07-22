# @deepseek-ai/dsh-acp-demo

The **ACP server app**: a Cordis app plugin that composes the default agent spine ([`@deepseek-ai/dsh-agent-spine-demo`](../agent-spine-demo/README.md)) with the front-door cluster an [Agent Client Protocol](../../ui/acp/README.md) server needs, and a `bin` that boots a leaf `cordis.yml` speaking ACP JSON-RPC on stdio.

It is the structured counterpart to [`@deepseek-ai/dsh-tui-demo`](../tui-demo/README.md): both consume the same spine, but ACP creates sessions from its client and reserves stdout for its wire protocol.

## What it bakes in — and what it deliberately omits

stdout is the ACP JSON-RPC channel, so the cluster is defined as much by what it LEAVES OUT as what it includes:

| Plugin | Why |
|---|---|
| `@deepseek-ai/dsh-agent-spine-demo` | the spine, pre-creating **no** agents (ACP `session/new` creates them on demand) |
| `@deepseek-ai/dsh-commands` | the human-command registry used for ACP discovery and direct slash dispatch |
| `@deepseek-ai/dsh-command-goal` | the discoverable direct `/goal` producer; the app enables the spine's persisted-goal stack with it |
| `@deepseek-ai/dsh-user-interaction` | the human question/answer seam used by clients that can complete ACP elicitation requests |
| `@deepseek-ai/dsh-session-persistence-jsonl` | durable JSONL session log (the bridge advertises `loadSession`) |
| `@deepseek-ai/dsh-session-checkpoint-policy` | semantic durability barriers before model requests and top-level tool effects, plus completed-step checkpoints |
| `@deepseek-ai/dsh-acp` | the bridge that owns stdout for JSON-RPC and provides ACP-backed user answers when a leaf explicitly exposes a user-question tool |
| ~~`@deepseek-ai/dsh-tool-ask-user`~~ | **omitted by default** — ACP elicitation support is still client-dependent, so leaves must opt in deliberately |
| ~~`@deepseek-ai/dsh-user-approval`~~ | **omitted by default** — permission policy is deployment-specific; sandbox/approval leaves opt in and the ACP bridge then supplies the answerer |
| ~~console logger~~ | **omitted** — it writes to stdout and would corrupt the protocol frames ([the stdout-purity footgun](../../ui/acp/README.md)) |
| ~~`hmr`~~ | **omitted** — the editor owns the subprocess |

The app owns this cluster through one ordered Cordis effect. Teardown drains the ACP bridge before removing the checkpoint policy or persistence backend, so a graceful disconnect persists the real closing `step/end` and `turn/end` events rather than leaving crash recovery to synthesize them. Because the package wires no logger entry, an ACP leaf has **nothing to get wrong by default**: it only picks backends. A leaf author can still add `@cordisjs/plugin-logger-console` as a sibling entry, so the rule remains: never add a stdout logger to an ACP leaf; use a stderr exporter instead.

## Config

| Key | Default | Routed to |
|---|---|---|
| `provider` | (required) | the initial provider route for each per-session agent the bridge creates; ACP model selection may replace it per session |
| `model` | (required) | the initial model for each per-session agent; ACP clients may switch among adapter-advertised models |
| `maxParallelToolCalls` | agent-loop default | positive-integer concurrent tool-call cap shared by the bundled loop's agents; `1` is serial |
| `persona` | — | the deployment persona template (may reference `{{provider}}`/`{{model}}`/`{{cwd}}`), routed to `dsh-system-prompt` |
| `toolOrder` | — | explicit model-facing tool order (a name list with one `'<unlisted-tools>'` rest entry; absent — lexicographic; an unregistered name fails each turn at prompt assembly), routed to `dsh-system-prompt` |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home exposed to model bash and used by local skill discovery |
| `sessionTitle` | spine example limits | fallback title word/byte limits routed through `dsh-agent-spine-demo` |
| `tools` | `{ mode: 'native' }` | tool-registry presentation config (`native` / `code` / `both`), routed through `dsh-agent-spine-demo` |
| `workspaceContext` | (required) | workspace-instruction byte budget/config, or `false`; routed to the providerless-safe `dsh-workspace-context` plugin |
| `skills` | owner defaults | registry-cache, local-provider, and model-facing skill-tool config, routed through `dsh-agent-spine-demo` |
| `toolBash` | owner defaults | model-facing bash config routed through `dsh-agent-spine-demo`, including bash's producer-local `enableRunInBackground` |
| `toolTasks` | owner defaults | generic `task_output` wait bounds routed through `dsh-agent-spine-demo` |
| `goals` | owner defaults | persisted goal-domain and model-tool config; `false` removes the goal stack and `/goal` producer |
| `llmRetry` | owner defaults | bounded transient model-request retry policy routed through `dsh-agent-spine-demo` |
| `persistenceRoot` | `./.sessions` | the JSONL backend's root directory |
| `packChunks` | `false` | write delta-chunk runs as packed storage rows (the JSONL backend's `packChunks`) |
| `persistenceCompression` | `'zstd'` | JSONL artifact encoding (`'zstd'` or raw `'none'`) |

The leaf supplies the swappable backends: an LLM adapter (`llm-deepseek` for the real model, `llm-replay` for keyless snapshot replay), a bash executor, and optionally a `ctx.fs` provider. Workspace context becomes a no-op without `ctx.fs`; the shipped [`examples/acp-agent/cordis.yml`](../../../examples/acp-agent/cordis.yml) selects `dsh-sandbox-policy`, `dsh-fs-sandbox`, `dsh-fs-policy`, and `dsh-tool-fs` so baseline instructions and model-facing `read`/`write`/`edit` share one provider, sandbox mode, workspace root, and observed-version policy.

## The bin

`dsh-acp-demo [--config path-to-cordis.yml]` (short form `-c`; default `./cordis.yml`):

- loads a gitignored `.env` from the cwd — **skipped** in snapshot REPLAY so a stray key can never trigger a live call;
- honors `DSH_SNAPSHOT=replay` by booting the sibling `cordis.snapshot.yml` (the keyless replay tree, `llm-replay` in place of `llm-deepseek`);
- in a snapshot run, disposes the context on stdin EOF so the session log is fully flushed before exit.

Run it under `node --expose-internals`, or Loader's optional `node-addon-require-builtin` fallback is required, so the cordis Loader can resolve the config's bare plugin specifiers through its internal module loader. (`demo:acp` runs under tsx, whose tsconfig `paths` map resolves them instead.)

All diagnostics go to **stderr** — stdout is the protocol.

## Model Experience

Indirectly, through `dsh-agent-spine-demo` and `dsh-acp`, which compose each ACP agent's prompt, goal tools, and message history. Direct `/goal` input and output remain outside the model, while accepted mutations append domain-owned model-visible snapshots.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **JSONL persistence is baked in** — config chooses its root but cannot select a different backend; that requires a sibling entry or differently composed app package.
- **User-question and approval mechanisms are omitted by default** — the bridge can answer both when their services/tools are composed, but this front door does not enable those deployment policies itself.
- **A leaf can still corrupt stdout** — the app mounts no console logger, but it cannot prevent a sibling leaf entry from writing non-protocol bytes to the ACP channel.
