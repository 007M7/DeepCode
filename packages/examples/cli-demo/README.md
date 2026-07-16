# @deepseek-ai/dsh-cli-demo

Headless one-shot app and bin for running one agent task without a readline or editor client. The app composes [`@deepseek-ai/dsh-agent-spine-demo`](../agent-spine-demo/README.md), JSONL persistence, and one fresh `main` agent; the bin submits one task, waits through all model and tool steps, emits the selected result, disposes to quiescence, and exits.

The package mounts no console logger, readline UI, user-interaction service, or `ask_user_question` tool. Stdout is reserved for the selected output format; diagnostics use stderr.

## Config

| Key | Default | Routed to |
|---|---|---|
| `model` | required | the pre-created `main` agent's model |
| `persona` | — | the deployment persona in `dsh-system-prompt` |
| `toolOrder` | lexicographic | explicit model-facing tool order in `dsh-system-prompt` |
| `tools` | `{ mode: 'native' }` | tool-registry presentation config through `dsh-agent-spine-demo` |
| `skills` | owner defaults | skill registry, local provider, and model-facing skill tool |
| `persistenceRoot` | `./.sessions` | JSONL session root |

Each process creates a new session whose workspace cwd is the launch directory. The app has no resume setting.

## CLI contract

```sh
dsh-cli-demo [--config path] [--output-format text|json|stream-json] <task>
```

`--config` defaults to `./cordis.yml`; `--output-format` defaults to `text`. Exactly one nonblank positional task is required, so quote tasks containing spaces. `--help` prints usage without booting. There is no `-p` or `--print` flag.

The root headless-agent example supplies its leaf:

```sh
pnpm run demo:headless -- "inspect the failing test and fix it"
```

Loader configs with bare package specifiers require `node --expose-internals` or the Loader's optional native fallback. The root command supplies the Node flag.

### Output formats

- `text` writes the last assistant message containing text, followed by one newline.
- `json` writes one DSH-native result record: `{ type: "result", success, sessionId, turn, result, reason, usage? }`. `usage` sums every model step in the task turn.
- `stream-json` writes each canonical event from the `main` session's task turn as `{ type: "session_event", sessionId, event }`, then the same result record. Child-agent activity appears only through the parent tool events and results.

Only `reason.kind === "completed"` exits successfully. Other durable turn endings still emit partial text or a result record, add a stderr diagnostic, and exit nonzero. Argument and boot failures leave stdout empty. SIGINT and SIGTERM cancel active work, await disposal, and exit 130 and 143 respectively.

The task turn is explicitly flushed before final output. Session logs remain under `persistenceRoot` after the process exits.

## Operational safety

The headless-agent leaf supplies local bash, filesystem, skill, subagent, workflow, and todo capabilities. A task can therefore mutate the launch workspace, run commands, spawn child agents, and consume provider tokens. Run the CLI from the intended project directory, review the leaf's capability and sandbox configuration, and do not treat non-interactive execution as an approval boundary.

## Model Experience

### One-shot task turn

**What the model sees**: The positional task becomes one user message. Through `dsh-agent-spine-demo`, the `main` agent also receives the configured persona, skill catalog, visible tool schemas, and retained tool results needed for later steps in the same turn.

**Token effect**: The task, prompt sections, tool schemas, assistant output, and tool results consume tokens on each model step. JSON event streaming and final rendering add no model tokens; delegated child work has its own model usage and is not included in the parent result's `usage` total.

## Known Limitations and Deferred Work

- **One fresh main session per process** — there is no resume, second prompt, stdin context, or concurrent top-level session in this app.
- **No interactive question or approval provider** — tools that require a human answer cannot complete unless a different leaf composes a non-interactive provider with explicit policy.
- **Streaming is main-session-only** — child sessions are not flattened into the stream, and aggregate usage covers only model steps recorded on the parent task turn.
