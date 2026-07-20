# @deepseek-ai/dsh-stdio-demo

The **terminal chat app**: a Cordis app plugin that composes the default agent spine ([`@deepseek-ai/dsh-agent-spine-demo`](../agent-spine-demo/README.md)) with JSONL persistence, human interaction, a pre-created `main` agent, and a TTY-selected pi-tui/readline front door. Its `bin` boots a leaf `cordis.yml`.

It is the terminal counterpart to [`@deepseek-ai/dsh-acp-demo`](../acp-demo/README.md): both consume the same spine, while ACP reserves stdout for JSON-RPC and creates sessions from the client.

## What it bakes in

A terminal chat always wants the same cluster, so the package owns it rather than trusting each leaf to re-wire it:

| Plugin | Why it is here |
|---|---|
| `@deepseek-ai/dsh-agent-spine-demo` | the spine, pre-creating a `main` agent from this app's provider/model pair with `process.cwd()` as the fresh session cwd and carrying its `persona` |
| `@deepseek-ai/dsh-session-persistence-jsonl` | durable JSONL session log under `persistenceRoot` |
| `@deepseek-ai/dsh-user-interaction` | the human question/answer seam used by confirmation tools |
| `@deepseek-ai/dsh-tool-ask-user` | the model-facing `ask_user_question` tool |
| `@cordisjs/plugin-logger-console` | readline diagnostics for non-TTY operation; omitted from the fullscreen TUI path |
| `@deepseek-ai/dsh-stdio` | the line-oriented channel for pipes and automation, bound to the exact app-owned agent/session identity |
| `@deepseek-ai/dsh-tui` | the fullscreen interactive channel for TTY pairs, bound to the same exact identity |

`@cordisjs/plugin-hmr` (the dev/demo edit-reload loop) is deliberately a **leaf** entry, NOT baked in here: it is a Loader-only, subprocess-only dev plugin — its constructor throws without `node --expose-internals` + a live `loader`, and the in-process test tier cannot even import it (so a package whose `apply` statically pulled it in could never carry the per-file coverage gate). Unlike the console logger, a stray `hmr` is not a stdout-purity footgun, so leaving it at the leaf costs no safety. The `demo:echo` / `demo:repl` leaves load it and pass `--expose-internals`.

The leaf `cordis.yml` supplies only the **swappable backends** — an LLM adapter (`llm-deepseek` for the real model, or the mock `mock-llm` for a demo) and a bash executor (`bash-local`) — `hmr`, plus this app's [`Config`](#config). The whole plugin tree a run loads is therefore: this app's cluster, the spine inside `agent-spine-demo`, `hmr`, and the two leaf backends.

## Config

| Key | Default | Routed to |
|---|---|---|
| `provider` | (required) | the pre-created `main` agent's registered provider route |
| `model` | (required) | the pre-created `main` agent's model |
| `maxParallelToolCalls` | agent-loop default | positive-integer concurrent tool-call cap shared by the bundled loop's agents; `1` is serial |
| `persona` | — | the deployment persona template (may reference `{{provider}}`/`{{model}}`/`{{cwd}}`), routed to `dsh-system-prompt` |
| `toolOrder` | — | explicit model-facing tool order (a name list with one `'<unlisted-tools>'` rest entry; absent — lexicographic; an unregistered name fails each turn at prompt assembly), routed to `dsh-system-prompt` |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home exposed to model bash and used by local skill discovery |
| `tools` | `{ mode: 'native' }` | tool-registry presentation config (`native` / `code` / `both`), routed through `dsh-agent-spine-demo` |
| `skills` | owner defaults | registry-cache, local-provider, and model-facing skill-tool config, routed through `dsh-agent-spine-demo` |
| `toolBash` | owner defaults | model-facing bash config routed through `dsh-agent-spine-demo`, including bash's producer-local `enableRunInBackground` |
| `toolTasks` | owner defaults | generic `task_output` wait bounds routed through `dsh-agent-spine-demo` |
| `persistenceRoot` | `./.sessions` | the JSONL backend's root directory |
| `welcome` | `ready.` | terminal banner / TUI subtitle |
| `ui` | `{ mode: 'auto' }` | terminal mode (`auto` / `readline` / `tui`) and nested TUI presentation config |
| `resumeSessionId` | — | resume a persisted session id instead of starting fresh (sourced from an env var in the leaf) |

Fresh terminal sessions use the process launch directory as `session.header.cwd` and mint one combined `main-session-<uuid>` agent/session id, so durable restarts cannot collide. The app passes that exact opaque id to the config-created agent and selected UI before agent-core starts; this lets either front door observe `agent-loop/config-start-failed`, and an AgentLoop-only reload restores materialized history under the same id. Readline buffers startup input until `agent/session-start`; the TUI waits to enter fullscreen until the matching root appears. A resumed run binds both components to the exact `resumeSessionId` and keeps the persisted cwd.

## The bin

`dsh-stdio-demo [path-to-cordis.yml]` (default `./cordis.yml`) loads a gitignored `.env` from the cwd (`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`), then drives the cordis Loader against the config and awaits the whole plugin tree before returning. Run it under `node --expose-internals`, or install the Loader's optional `node-addon-require-builtin` fallback, so the Loader can resolve the config's bare plugin specifiers (`@deepseek-ai/dsh-*`, npm packages). The `demo:echo` / `demo:repl` scripts use `--expose-internals`.

## Example leaf `cordis.yml`

```yaml
# A REPL agent demo: hmr + the DeepSeek adapter + local bash, then this app.
- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    root: ['.']
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    timeoutMs: 60000
- id: stdio-agent
  name: '@deepseek-ai/dsh-stdio-demo'
  config:
    provider: deepseek
    model: deepseek-v4-flash
    persona: 'You are a coding assistant powered by the {{model}} model.'
    ui:
      mode: auto
```

Swap `llm-deepseek` for a `mock-llm` leaf plugin and you have the echo demo — "swap the backend, keep the app".

## Model Experience

### Composed terminal agent request

#### What the model sees

Through `dsh-agent-spine-demo`, the `main` agent receives the harness identity, configured persona, skill catalog, and visible tools; this app also composes the generated [`ask_user_question` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user). Each terminal submission becomes a user message; submissions made while the agent runs steer the active turn.

#### Token effect

Child prompt and schema costs repeat per request; user input and tool history grow until compaction. Terminal banners, logger output, cards, and rendered transcripts add zero model tokens.

#### KV Cache effect

User and tool history is append-only while the composed prompt, schemas, child model route, and session prefix remain fixed. A composition change or compaction may invalidate reuse from its first changed token; terminal rendering has no cache effect.

### Human-answer result

#### What the model sees

Through `dsh-tool-ask-user`, successful terminal answers use that package's exact compact JSON shape. Interruption becomes exactly `Error: ask_user_question was interrupted before the user answered`; a closed stdin becomes `Error: ask_user_question cannot be answered because stdin is closed`.

#### Token effect

Only a completed or failed tool call adds retained result tokens; prompts printed while waiting are terminal-only.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **One pre-created `main` agent drives the selected terminal UI** — there is no multi-session or concurrent-agent surface in this app; a run is one conversation.
- **The front-door cluster is fixed in code** — the JSONL persistence backend and the ask-user tooling are baked; a different composition is a leaf-level sibling entry or another app package.
- **The question tool is not an approval answerer** — this app mounts `user-interaction` and `ask_user_question`, but not `ctx.approval`; a `tools/pre-execute` `ask` therefore fails closed unless the leaf composes an approval service and terminal answerer.
