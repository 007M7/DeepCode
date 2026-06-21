# @deepseek-ai/dsh-acp-agent

The **ACP server app**: a Cordis app plugin that composes the providerless agent spine ([`@deepseek-ai/dsh-agent-core`](../../core/agent-core/README.md)) with the front-door cluster an [Agent Client Protocol](../acp/README.md) server needs, and a `bin` that boots a leaf `cordis.yml` speaking ACP JSON-RPC on stdio.

It is the structured counterpart to [`@deepseek-ai/dsh-stdio-agent`](../stdio-agent/README.md): both consume the same spine, but this one bakes in the OPPOSITE front-door cluster.

## What it bakes in — and what it deliberately omits

stdout is the ACP JSON-RPC channel, so the cluster is defined as much by what it LEAVES OUT as what it includes:

| Plugin | Why |
|---|---|
| `@deepseek-ai/dsh-agent-core` | the spine, pre-creating **no** agents (ACP `session/new` creates them on demand) |
| `@deepseek-ai/dsh-session-persistence-jsonl` | durable JSONL session log (the bridge advertises `loadSession`) |
| `@deepseek-ai/dsh-acp` | the bridge that owns stdout for JSON-RPC |
| ~~console logger~~ | **omitted** — it writes to stdout and would corrupt the protocol frames ([the stdout-purity footgun](../acp/README.md)) |
| ~~`hmr`~~ | **omitted** — the editor owns the subprocess |

Because there is no logger entry in the package, the footgun is **structurally unreachable from the leaf**: a leaf author cannot wire a stdout logger into the ACP config, because the leaf only picks backends, not the front door.

## Config

| Key | Default | Routed to |
|---|---|---|
| `model` | (required) | the per-session agent template the bridge creates agents from |
| `systemPrompt` | (required) | the per-session agent's system prompt |
| `persistenceRoot` | `./.sessions` | the JSONL backend's root directory |

The leaf supplies the swappable backends: an LLM adapter (`llm-deepseek` for the real model, `llm-replay` for keyless snapshot replay) and a bash executor (`bash-local`).

## The bin

`dsh-acp-agent [path-to-cordis.yml]` (default `./cordis.yml`):

- loads a gitignored `.env` from the cwd — **skipped** in snapshot REPLAY so a stray key can never trigger a live call;
- honors `DSH_SNAPSHOT=replay` by booting the sibling `cordis.snapshot.yml` (the keyless replay tree, `llm-replay` in place of `llm-deepseek`);
- in a snapshot run, disposes the context on stdin EOF so the session log is fully flushed before exit.

All diagnostics go to **stderr** — stdout is the protocol.
