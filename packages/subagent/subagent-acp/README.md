# @deepseek-ai/dsh-subagent-acp

The ACP provider runs each subagent in a fresh subprocess and drives it as an Agent Client Protocol client. It is the out-of-process alternative to spawn and fork: the child has its own runtime, session, model configuration, and tools.

## Start and ownership

`start(request)` performs `spawn` → ACP `initialize` → `newSession` before it fulfills. Fulfillment therefore means a remote session is ready and ownership has transferred to the caller. A spawn, initialization, new-session, or pre-publication cancellation failure rejects only after the subprocess has been reaped.

The returned run id is minted in the parent namespace. The child server's session id remains private to ACP wire calls because ACP guarantees it only within that fresh child process; using it as the parent lifecycle id could collide with another remote run or a local agent.

After publication, the provider sends the prompt and collects streamed `agent_message_chunk` text into `SubagentResult.output`. A prompt/transport failure resolves with `stopReason: 'error'`, or `aborted` when the required request signal or disposal requested cancellation.

`dispose()` is idempotent. It removes the signal listener, requests ACP cancellation when possible, closes stdin, waits `disposeEofGraceMs`, escalates to SIGTERM, waits `disposeGraceMs`, and finally uses SIGKILL if necessary. Every run uses a fresh process; process pooling is not implemented.

## Capabilities and context

ACP advertises no start-time capabilities because this process cannot enforce the remote child's depth, tool filter, persona, or structured-output runtime. It also reports `inheritsParentContext: false`: the remote session starts fresh and ignores `request.parent` beyond the seam's required attribution field.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `acp` | Registry name on `ctx.subagents`. |
| `command` | required | Executable spawned for each run. |
| `args` | `[]` | Command arguments. |
| `cwd` | process cwd | Child process and ACP session working directory. |
| `permission` | `reject` | Auto-answer permission requests by rejecting or choosing the first allow-shaped option. |
| `env` | `{}` | Explicit child environment layered over a credential-scrubbed parent environment. |
| `disposeEofGraceMs` | `6000` | Grace after stdin EOF before SIGTERM. |
| `disposeGraceMs` | `3000` | Grace after SIGTERM before SIGKILL. |

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: acp
    command: node
    args: ['--import', 'tsx', './packages/examples/acp-demo/src/bin.ts', '--config', './examples/acp-agent/cordis.yml']
    permission: reject
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
```

## Stop-reason mapping

| ACP | Harness |
|---|---|
| `end_turn` | `completed` |
| `max_tokens` | `max-tokens` |
| `refusal` | `refusal` |
| `cancelled` | `aborted` |
| `max_turn_requests` or unknown | `error` |

## Process boundary

The child environment is built by [`buildChildEnv`](../subagent-subprocess/README.md): credential-shaped ambient variables are removed, then explicit `config.env` values are applied. The ACP wire is the real serialization boundary; same-process subagent values are not defensively cloned.

The package has no default export. Cordis loader unwrapping would otherwise hide the named `inject` metadata; see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md).

Keyless tests drive a scripted ACP subprocess over real stdio. The with-key e2e drives the repository's real ACP agent and self-skips without `DEEPSEEK_API_KEY`.

## Model Experience

### Child-agent request

#### What the model sees

The remote child receives the standalone task content through ACP plus its own process's configured system prompt, tools, and fresh session. It receives no parent conversation. This provider advertises no optional start-time capabilities, so the local service rejects requests for persona, tool filtering, depth enforcement, or structured output instead of silently omitting them.

#### Token effect

The child pays for an independent full context and its own multi-step history. These tokens never enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Each ACP child can reuse only prefixes identical under its own provider, model, composition, and history; child steps otherwise grow append-only.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final streamed assistant text or that consumer's exact stop-reason error, not intermediate messages or tool traffic. A request already cancelled before publication becomes exactly `Error: subagent request was aborted before the ACP child started`; other start failures pass through as `Error: <message>`.

#### Token effect

Parent input grows only by the final result or error, which is data-dependent and retained until compaction. This provider adds no parent schema itself.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A fresh process per run** — persistent-process pooling is a future optimization ([the seam RFC](../../../docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md)).
- **No optional start-time capabilities** — this provider cannot apply the local harness's `outputSchema`, depth cap, tool filter, or persona inside the remote process, so it advertises none and the service rejects requests that require them.
- **Only `agent_message_chunk` text is collected** — the child's tool-call activity, thought chunks, and plan updates are not surfaced to the parent.
- **Permission prompts are auto-answered** (`permission: allow | reject`) — no human is surfaced a child's `session/request_permission` in this cut.
- **No snapshot-tier replay coverage** (`TODO(acp-subagent-replay)`) — an ACP child is its own process with its own replay shape, deferred.
