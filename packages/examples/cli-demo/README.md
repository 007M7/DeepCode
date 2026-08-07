# @deepseek-ai/dsh-cli-demo

English | [中文](README.zh.md)

Headless one-shot app and bin for running one agent task without an interactive UI or editor client. It composes [`@deepseek-ai/dsh-agent-spine-demo`](../agent-spine-demo/README.md), JSONL persistence, and exactly one fresh top-level agent. The bin owns one idle-to-idle activity interval, renders its selected output, disposes to quiescence, and exits.

The package mounts no console logger, interactive UI, user-interaction service, or `ask_user_question` tool. Stdout is reserved for the selected output format; diagnostics use stderr.

## Config

| Key | Default | Routed to |
|---|---|---|
| `provider` | required | the configured agent's provider route |
| `model` | required | the configured agent's model |
| `maxParallelToolCalls` | agent-loop default | positive-integer concurrent tool-call cap; `1` is serial |
| `persona` | — | the deployment persona in `dsh-system-prompt` |
| `toolOrder` | lexicographic | explicit model-facing tool order in `dsh-system-prompt` |
| `tools` | `{ mode: 'native' }` | tool-registry presentation config through `dsh-agent-spine-demo` |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home exposed to model bash and used by local skill discovery |
| `sessionTitle` | spine example limits | Fallback title word/byte limits through `dsh-agent-spine-demo` |
| `skills` | owner defaults | skill registry, local provider, and model-facing skill tool |
| `toolBash` | owner defaults | model-facing bash config, including this producer's background opt-in |
| `toolTasks` | owner defaults | generic `task_output` wait bounds |
| `persistenceRoot` | `./.sessions` | JSONL session root |
| `persistenceCompression` | `'zstd'` | JSONL artifact encoding (`'zstd'` or raw `'none'`) |
| `workspaceContext` | required | workspace-instruction byte budget, or `false` to disable loading |

## CLI contract

```sh
dsh-cli-demo [--config path] [--output-format text|json|stream-json] <task>
```

`--config` defaults to `./cordis.yml`; `--output-format` defaults to `text`. Exactly one nonblank positional task is required, so quote tasks containing spaces. `--help` prints usage without booting. There is no `-p` or `--print` flag.

The root headless-agent example supplies its leaf:

```sh
pnpm run demo:headless "inspect the failing test and fix it"
```

Loader configs resolve bare package specifiers through the optional native helper installed by the repository, so the root command needs no special Node flags.

### Output formats

- `text` writes the last assistant message containing text, followed by one newline.
- `json` writes one DSH-native result record: `{ type: "result", sessionId, output, usage? }`. `output` is the last committed assistant text in the activity interval. `usage` sums each model step in that interval once, including billed failed attempts that produced usage without a committed assistant message.
- `stream-json` writes each canonical event from the top-level session's owned activity interval as `{ type: "session_event", sessionId, event }`, then the same result record. Child-agent activity appears only through the parent tool events and results.

Normal idle completion exits successfully without assigning a turn reason to the task. Argument, boot, observation, and persistence failures leave stdout empty. SIGINT and SIGTERM cancel active work, await disposal, and exit 130 and 143 respectively.

The owned activity is explicitly flushed before final output. Session logs remain under `persistenceRoot` after the process exits.

## Operational safety

The headless-agent leaf supplies local bash, filesystem, skill, subagent, workflow, and todo capabilities. A task can therefore mutate the launch workspace, run commands, spawn child agents, and consume provider tokens. Run the CLI from the intended project directory, review the leaf's capability and sandbox configuration, and do not treat non-interactive execution as an approval boundary.

## Model Experience

### One-shot activity

#### What the model sees

The positional task becomes one user message. Through `dsh-agent-spine-demo`, the top-level agent also receives configured workspace instructions and persona, the skill catalog, visible tool schemas, and retained tool results needed for later steps in the owned activity.

#### Token effect

The task, prompt sections, tool schemas, assistant output, and tool results consume tokens on each model step. JSON event streaming and final rendering add no model tokens; delegated child work has its own model usage and is not included in the parent result's `usage` total.

#### KV Cache effect

Tool-round history is append-only while the one-shot agent's prompt, schemas, model route, and session prefix remain fixed. Changing that composition establishes a different request prefix; JSON output mode has no cache effect.

## Known Limitations and Deferred Work

- **One fresh top-level session per process** — its workspace cwd is the launch directory; there is no resume, second prompt, stdin context, or concurrent top-level session in this app.
- **No interactive question or approval provider** — tools that require a human answer cannot complete unless a different leaf composes a non-interactive provider with explicit policy.
- **Streaming is top-level-session-only** — child sessions are not flattened into the stream, and aggregate usage covers only model steps recorded on the parent activity interval.
