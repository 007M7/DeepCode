# @deepseek-ai/dsh-subagent-acp

The out-of-process **ACP subagent backend**: runs each child agent in a spawned subprocess, driven over the [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) (ACP) as the *client*. Registers a `SubagentProvider` on `ctx.subagents` (the [subagent seam](../subagent)), alongside the in-process [`-spawn`](../subagent-spawn)/[`-fork`](../subagent-fork) backends — multiple backends coexist by name.

It is the direction-inverted twin of the server-side bridge in [`@deepseek-ai/dsh-acp`](../../ui/acp): that package is the ACP *agent* (it answers `initialize`/`newSession`/`prompt`); this one is the ACP *client* (it *calls* them and implements the `sessionUpdate`/`requestPermission` callbacks). Point the configured command at the `acp-agent` example to "talk to our own process".

## What it does

`start(request)` spawns the configured command, wraps its stdio in an ACP `ClientSideConnection`, and drives one session: `initialize` → `newSession` → `prompt`. The child's streamed `agent_message_chunk` text becomes the `SubagentResult.output`; the prompt's terminal `StopReason` maps to the stop reason. `dispose()` kills the subprocess and awaits its exit.

**Fresh process per run.** Each `start` spawns a new child, runs exactly one ACP session, and disposes it. Persistent-process pooling is a future optimization (see the RFC).

Unlike the in-process backends, the child does NOT share this cordis context — it is a separate process with its own session, model client, and tools. So this backend:
- injects only `subagents` (no `ctx.agents`);
- advertises NO start-time capabilities (an out-of-process child can't enforce the parent's depth/tool-filter);
- ignores `request.parent`.

## Config

| Key | Type | Default | Notes |
|---|---|---|---|
| `providerName` | string | `acp` | Registry name on `ctx.subagents`. |
| `command` | string | — (required) | The executable to spawn for each run (the child ACP agent). |
| `args` | string[] | `[]` | Arguments passed to `command`. |
| `cwd` | string | parent cwd | Working directory for the child process and its ACP session. |
| `permission` | `'allow' \| 'reject'` | `reject` | How to auto-answer the child's `session/request_permission` prompts. `reject` declines every prompt (answer `cancelled`); `allow` approves via the first allow-shaped option. The first cut surfaces no prompt to a human. |
| `env` | Record<string,string> | `{}` | Extra env vars for the child (e.g. its own `DEEPSEEK_API_KEY`). Forwarded on top of a credential-scrubbed copy of the parent env, so an explicit key reaches the child while ambient secrets do not leak implicitly. |

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: acp
    command: node
    args: ['--import', 'tsx', './packages/ui/acp-agent/src/bin.ts', './examples/acp-agent/cordis.yml']
    permission: reject
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
```

## StopReason mapping

ACP `StopReason` → harness `SubagentStopReason`:

| ACP | harness |
|---|---|
| `end_turn` | `completed` |
| `max_tokens` | `max-tokens` |
| `refusal` | `refusal` |
| `cancelled` | `aborted` |
| `max_turn_requests` | `error` (no clean equivalent; the task did not finish) |
| _(unknown)_ | `error` |

A spawn/transport/RPC failure resolves `error` (or `aborted` if a cancel was requested) — `result` never rejects on a child-level failure, per the seam contract.

## Environment scrub

Credential-shaped ambient vars (`/KEY|SECRET|TOKEN/i`) are NOT forwarded to the child by default — the parent harness's own secrets must not leak into a spawned process implicitly. The child's OWN credentials are supplied explicitly via `config.env`, layered AFTER the scrub, so an intended `DEEPSEEK_API_KEY` survives while an incidental `AWS_SECRET_ACCESS_KEY` does not.

## Testing

- **Keyless** (`subagent-acp.spec.ts`): spawns a scripted mock ACP server subprocess (`tests/mock-acp-server.ts`) and drives it through the real backend over real ACP stdio — connection setup, client callbacks, the prompt round-trip, stop-reason mapping, cancellation (including the early-cancel race and a torn-pipe-after-cancel), permission auto-answer, and quiescent disposal. No model, no key.
- **With-key e2e** (`subagent-acp.e2e.ts`): the harness drives ITSELF — the backend spawns the real `acp-agent` example process and a real model in that child answers a prompt and does real file work (verified on disk). Self-skips without `DEEPSEEK_API_KEY`.

`TODO(acp-subagent-replay)`: snapshot-tier coverage of an ACP child is a separate replay shape (each child is its own PROCESS with its own single-agent replay, distinct from the in-process per-session keying), deferred — see the RFC.

## Plugin export shape

Named `name` / `inject` / `Config` / `apply`, with **no default export**: the cordis Loader's `unwrapExports` does `exports.default ?? exports`, so a stray default would collapse the module to the bare function and drop the `inject` namespace (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).
