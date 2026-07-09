# @deepseek-ai/dsh-acp-agent

The **ACP server app**: a Cordis app plugin that composes the providerless agent spine ([`@deepseek-ai/dsh-agent-core`](../../core/agent-core/README.md)) with the front-door cluster an [Agent Client Protocol](../acp/README.md) server needs, and a `bin` that boots a leaf `cordis.yml` speaking ACP JSON-RPC on stdio.

It is the structured counterpart to [`@deepseek-ai/dsh-stdio-agent`](../stdio-agent/README.md): both consume the same spine, but this one bakes in the OPPOSITE front-door cluster.

## What it bakes in — and what it deliberately omits

stdout is the ACP JSON-RPC channel, so the cluster is defined as much by what it LEAVES OUT as what it includes:

| Plugin | Why |
|---|---|
| `@deepseek-ai/dsh-agent-core` | the spine, pre-creating **no** agents (ACP `session/new` creates them on demand) |
| `@deepseek-ai/dsh-user-interaction` | the human question/answer seam used by clients that can complete ACP elicitation requests |
| `@deepseek-ai/dsh-session-persistence-jsonl` | durable JSONL session log (the bridge advertises `loadSession`) |
| `@deepseek-ai/dsh-acp` | the bridge that owns stdout for JSON-RPC and provides ACP-backed user answers when a leaf explicitly exposes a user-question tool |
| ~~`@deepseek-ai/dsh-tool-ask-user`~~ | **omitted by default** — ACP elicitation support is still client-dependent, so leaves must opt in deliberately |
| ~~console logger~~ | **omitted** — it writes to stdout and would corrupt the protocol frames ([the stdout-purity footgun](../acp/README.md)) |
| ~~`hmr`~~ | **omitted** — the editor owns the subprocess |

Because the package wires no logger entry, an ACP leaf has **nothing to get wrong by default**: it only picks backends, so the common mistake — copying a console-logger entry from the stdio config — has no place here. (A leaf author technically *can* still add `@cordisjs/plugin-logger-console` as a sibling entry; the package can't forbid that. So the rule stands: never add a stdout logger to an ACP leaf — stdout is the JSON-RPC channel. Use a stderr exporter if you need logs.)

## Config

| Key | Default | Routed to |
|---|---|---|
| `model` | (required) | the per-session agent template the bridge creates agents from |
| `persona` | — | the deployment persona template (may reference `{{model}}`/`{{cwd}}`), routed to `dsh-system-prompt` |
| `toolOrder` | — | explicit model-facing tool order (a name list with one `'<unlisted-tools>'` rest entry; absent — lexicographic; an unregistered name fails each turn at prompt assembly), routed to `dsh-system-prompt` |
| `persistenceRoot` | `./.sessions` | the JSONL backend's root directory |

The leaf supplies the swappable backends: an LLM adapter (`llm-deepseek` for the real model, `llm-replay` for keyless snapshot replay) and a bash executor (`bash-local`).

## The bin

`dsh-acp-agent [path-to-cordis.yml]` (default `./cordis.yml`):

- loads a gitignored `.env` from the cwd — **skipped** in snapshot REPLAY so a stray key can never trigger a live call;
- honors `DSH_SNAPSHOT=replay` by booting the sibling `cordis.snapshot.yml` (the keyless replay tree, `llm-replay` in place of `llm-deepseek`);
- in a snapshot run, disposes the context on stdin EOF so the session log is fully flushed before exit.

Run it under `node --expose-internals`: the cordis Loader resolves the config's bare plugin specifiers through its internal module loader, active only under that flag. (`demo:acp` runs under tsx, whose tsconfig `paths` map resolves them instead.)

All diagnostics go to **stderr** — stdout is the protocol.
