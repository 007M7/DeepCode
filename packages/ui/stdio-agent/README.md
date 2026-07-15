# @deepseek-ai/dsh-stdio-agent

The **terminal stdio chat app**: a Cordis app plugin that composes the default agent spine ([`@deepseek-ai/dsh-agent-core`](../../core/agent-core/README.md)) with the front-door cluster a terminal chat needs, and a `bin` that boots a leaf `cordis.yml`.

It is the readline counterpart to [`@deepseek-ai/dsh-acp-agent`](../acp-agent/README.md): both consume the same spine, but each bakes in the OPPOSITE front-door cluster.

## What it bakes in

A terminal chat always wants the same cluster, so the package owns it rather than trusting each leaf to re-wire it:

| Plugin | Why it is here |
|---|---|
| `@cordisjs/plugin-logger-console` | the console logger — stdout is just the terminal here, so logging to it is correct (the ACP app must NOT have this) |
| `@deepseek-ai/dsh-agent-core` | the spine, pre-creating a `main` agent from this app's `model` with `process.cwd()` as the fresh session cwd and carrying its `persona` |
| `@deepseek-ai/dsh-session-persistence-jsonl` | durable JSONL session log under `persistenceRoot` |
| `@deepseek-ai/dsh-user-interaction` | the human question/answer seam used by confirmation tools |
| `@deepseek-ai/dsh-tool-ask-user` | the model-facing `ask_user_question` tool |
| `@deepseek-ai/dsh-stdio` | the readline UI, bound to the `main` agent |

`@cordisjs/plugin-hmr` (the dev/demo edit-reload loop) is deliberately a **leaf** entry, NOT baked in here: it is a Loader-only, subprocess-only dev plugin — its constructor throws without `node --expose-internals` + a live `loader`, and the in-process test tier cannot even import it (so a package whose `apply` statically pulled it in could never carry the per-file coverage gate). Unlike the console logger, a stray `hmr` is not a stdout-purity footgun, so leaving it at the leaf costs no safety. The `demo:echo` / `demo:repl` leaves load it and pass `--expose-internals`.

The leaf `cordis.yml` supplies only the **swappable backends** — an LLM adapter (`llm-deepseek` for the real model, or the mock `mock-llm` for a demo) and a bash executor (`bash-local`) — `hmr`, plus this app's [`Config`](#config). The whole plugin tree a run loads is therefore: this app's cluster, the spine inside `agent-core`, `hmr`, and the two leaf backends.

## Config

| Key | Default | Routed to |
|---|---|---|
| `model` | (required) | the pre-created `main` agent's model |
| `persona` | — | the deployment persona template (may reference `{{model}}`/`{{cwd}}`), routed to `dsh-system-prompt` |
| `toolOrder` | — | explicit model-facing tool order (a name list with one `'<unlisted-tools>'` rest entry; absent — lexicographic; an unregistered name fails each turn at prompt assembly), routed to `dsh-system-prompt` |
| `tools` | `{ mode: 'native' }` | tool-registry presentation config (`native` / `code` / `both`), routed through `dsh-agent-core` |
| `skills` | owner defaults | registry-cache, local-provider, and model-facing skill-tool config, routed through `dsh-agent-core` |
| `persistenceRoot` | `./.sessions` | the JSONL backend's root directory |
| `welcome` | `ready.` | the stdin-chat banner |
| `resumeSessionId` | — | resume a persisted session id instead of starting fresh (sourced from an env var in the leaf) |

Fresh stdio sessions use the process launch directory as `session.header.cwd`, so project-scoped features such as skill discovery and default bash workdir follow the directory where `dsh-stdio-agent` was started. Resumed sessions keep the cwd stored in the persisted session header.

## The bin

`dsh-stdio-agent [path-to-cordis.yml]` (default `./cordis.yml`) loads a gitignored `.env` from the cwd (`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`), then drives the cordis Loader against the config and awaits the whole plugin tree before returning. Run it under `node --expose-internals`, or install the Loader's optional `node-addon-require-builtin` fallback, so the Loader can resolve the config's bare plugin specifiers (`@deepseek-ai/dsh-*`, npm packages). The `demo:echo` / `demo:repl` scripts use `--expose-internals`.

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
    models: [deepseek-v4-flash]
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    timeoutMs: 60000
- id: stdio-agent
  name: '@deepseek-ai/dsh-stdio-agent'
  config:
    model: deepseek-v4-flash
    persona: 'You are a coding assistant powered by the {{model}} model.'
```

Swap `llm-deepseek` for a `mock-llm` leaf plugin and you have the echo demo — "swap the backend, keep the app".

## Model Experience

### Composed terminal agent request

**What the model sees**: Through `dsh-agent-core`, the `main` agent receives the harness identity, configured persona, skill catalog, and visible tools; this app also composes the generated [`ask_user_question` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user). Each readline submission becomes a user message.

**Token effect**: Child prompt and schema costs repeat per request; user input and tool history grow until compaction. The welcome banner, logger output, and rendered transcript are terminal-only and add zero model tokens.

### Human-answer result

**What the model sees**: Through `dsh-tool-ask-user`, successful terminal answers use that package's exact compact JSON shape. Interruption becomes exactly `Error: ask_user_question was interrupted before the user answered`; a closed stdin becomes `Error: ask_user_question cannot be answered because stdin is closed`.

**Token effect**: Only a completed or failed tool call adds retained result tokens; prompts printed while waiting are terminal-only.

## Known Limitations and Deferred Work

- **One pre-created `main` agent drives the readline UI** — there is no multi-session or concurrent-agent surface in this app; a run is one conversation.
- **The front-door cluster is fixed in code** — the JSONL persistence backend and the ask-user tooling are baked; a different composition is a leaf-level sibling entry or another app package.
- **The question tool is not an approval answerer** — this app mounts `user-interaction` and `ask_user_question`, but not `ctx.approval`; a `tools/pre-execute` `ask` therefore fails closed unless the leaf composes an approval service and terminal answerer.
