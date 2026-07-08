# @deepseek-ai/dsh-stdio-agent

The **terminal stdio chat app**: a Cordis app plugin that composes the providerless agent spine ([`@deepseek-ai/dsh-agent-core`](../../core/agent-core/README.md)) with the front-door cluster a terminal chat needs, and a `bin` that boots a leaf `cordis.yml`.

It is the readline counterpart to [`@deepseek-ai/dsh-acp-agent`](../acp-agent/README.md): both consume the same spine, but each bakes in the OPPOSITE front-door cluster.

## What it bakes in

A terminal chat always wants the same cluster, so the package owns it rather than trusting each leaf to re-wire it:

| Plugin | Why it is here |
|---|---|
| `@cordisjs/plugin-logger-console` | the console logger — stdout is just the terminal here, so logging to it is correct (the ACP app must NOT have this) |
| `@deepseek-ai/dsh-agent-core` | the spine, pre-creating a `main` agent from this app's `model` and carrying its `persona` |
| `@deepseek-ai/dsh-session-persistence-jsonl` | durable JSONL session log under `persistenceRoot` |
| `@deepseek-ai/dsh-user-interaction` | the human question/answer seam used by confirmation tools |
| `@deepseek-ai/dsh-tool-ask-user` | the model-facing `ask_user_question` tool |
| `stdio-chat` (in-package module) | the readline UI, bound to the `main` agent |

`@cordisjs/plugin-hmr` (the dev/demo edit-reload loop) is deliberately a **leaf** entry, NOT baked in here: it is a Loader-only, subprocess-only dev plugin — its constructor throws without `node --expose-internals` + a live `loader`, and the in-process test tier cannot even import it (so a package whose `apply` statically pulled it in could never carry the per-file coverage gate). Unlike the console logger, a stray `hmr` is not a stdout-purity footgun, so leaving it at the leaf costs no safety. The `demo:echo` / `demo:repl` leaves load it and pass `--expose-internals`.

The leaf `cordis.yml` supplies only the **swappable backends** — an LLM adapter (`llm-deepseek` for the real model, or the mock `mock-llm` for a demo) and a bash executor (`bash-local`) — `hmr`, plus this app's [`Config`](#config). The whole plugin tree a run loads is therefore: this app's cluster, the spine inside `agent-core`, `hmr`, and the two leaf backends.

## Config

| Key | Default | Routed to |
|---|---|---|
| `model` | (required) | the pre-created `main` agent's model |
| `persona` | — | the deployment persona template (may reference `{{model}}`), routed to `dsh-system-prompt` |
| `toolOrder` | — | explicit model-facing tool order (a name list with one `'<unlisted-tools>'` rest entry; absent — lexicographic; an unregistered name fails each turn at prompt assembly), routed to `dsh-system-prompt` |
| `persistenceRoot` | `./.sessions` | the JSONL backend's root directory |
| `welcome` | `ready.` | the stdin-chat banner |
| `resumeSessionId` | — | resume a persisted session id instead of starting fresh (sourced from an env var in the leaf) |

## The bin

`dsh-stdio-agent [path-to-cordis.yml]` (default `./cordis.yml`) loads a gitignored `.env` from the cwd (`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`), then drives the cordis Loader against the config and awaits the whole plugin tree before returning. Run it under `node --expose-internals`: the cordis Loader resolves the config's bare plugin specifiers (`@deepseek-ai/dsh-*`, npm packages) through its internal module loader, which is only active under that flag. The `demo:echo` / `demo:repl` scripts invoke it that way.

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
