# @deepseek-ai/dsh-subagent-acp

The ACP provider runs each subagent in a fresh subprocess and drives it as an Agent Client Protocol client. It is the out-of-process alternative to spawn and fork: the child has its own runtime, session, model configuration, and tools.

## Start and ownership

`start(request)` performs `spawn` → ACP `initialize` → `newSession` before it fulfills. Fulfillment therefore means a remote session is ready and ownership has transferred to the caller. A spawn, initialization, new-session, or pre-publication cancellation failure rejects only after the subprocess has been reaped.

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
    args: ['--import', 'tsx', './packages/ui/acp-agent/src/bin.ts', './examples/acp-agent/cordis.yml']
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
