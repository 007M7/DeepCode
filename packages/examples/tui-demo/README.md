# @deepseek-ai/dsh-tui-demo

The full-screen terminal app bundle: a Cordis plugin that composes [`@deepseek-ai/dsh-agent-spine-demo`](../agent-spine-demo/README.md), persisted same-session goals, the human-command registry and `/goal` producer, JSONL persistence, keyboard-backed user interaction, a pre-created `main` agent, and [`@deepseek-ai/dsh-tui`](../../ui/tui/README.md). A `cordis.yml` mounts it as one entry; the [`dsh`](../../../apps/cli/README.md) CLI is the front door that boots such a config.

Use [`@deepseek-ai/dsh-cli-demo`](../cli-demo/README.md) for pipes, scripts, and other non-interactive runs. This bundle requires a TTY pair and has no line-oriented fallback.

## What it bakes in

| Plugin | Why it is here |
|---|---|
| `@deepseek-ai/dsh-agent-spine-demo` | Shared services, model-facing tools, and one configured `main` agent |
| `@deepseek-ai/dsh-commands` | Human-only discovery and dispatch consumed by the TUI and command plugins |
| `@deepseek-ai/dsh-command-goal` | Direct `/goal` status and mutation over the spine's persisted-goal stack |
| `@deepseek-ai/dsh-session-persistence-jsonl` | Durable session log under `persistenceRoot` |
| `@deepseek-ai/dsh-session-checkpoint-policy` | Semantic durability barriers before model requests and top-level tool effects, plus completed-step checkpoints |
| `@deepseek-ai/dsh-session-query-sqlite` + `@deepseek-ai/dsh-session-reference` | Combined exact/FTS session queries and bounded `@session` snapshots consumed by the TUI; model-facing query tools remain a leaf opt-in |
| `@deepseek-ai/dsh-user-interaction` | Provider-neutral human question service |
| `@deepseek-ai/dsh-tui` | Full-screen transcript, editor, tool cards, plan, and question overlays |
| `@deepseek-ai/dsh-tool-ask-user` | Model-facing `ask_user_question` tool |

Swappable LLM, bash, filesystem, and other capability providers remain in the leaf config. `@cordisjs/plugin-hmr` also remains a leaf-only development entry because it requires Loader internals.

## Config

| Key | Default | Routed to |
|---|---|---|
| `provider` | required | Configured `main` agent provider |
| `model` | required | Configured `main` agent model |
| `maxParallelToolCalls` | agent-loop default | Bundled loop concurrency cap |
| `persona` | — | System-prompt persona template |
| `toolOrder` | lexicographic | Explicit model-facing tool order |
| `tools` | owner default | Tool presentation mode |
| `dshHome` | owner default | Harness home used by bash and skills |
| `sessionTitle` | spine example limits | Fallback title word/byte limits |
| `skills` | owner defaults | Skill registry, local provider, and tool config |
| `toolBash` | owner defaults | Model-facing bash tool config |
| `toolTasks` | owner defaults | Background-task control-tool config, or `false` |
| `goals` | owner defaults | Persisted goal-domain and model-tool config; `false` removes the goal stack and `/goal` producer |
| `workspaceContext` | required | Workspace-instruction config, or `false` |
| `persistenceRoot` | `./.sessions` | JSONL persistence root and parent of the derived `session-query.db` index |
| `persistenceCompression` | `'zstd'` | JSONL artifact encoding (`'zstd'` or raw `'none'`) |
| `sessionReferences` | service defaults | Cross-session candidate and snapshot limits routed to `dsh-session-reference` |
| `welcome` | `ready.` | TUI subtitle |
| `resumeCommand` | — | Exit and no-host fallback command template; the selector itself uses session query and host handoff |
| `ui` | owner defaults | TUI presentation settings such as reasoning, color, and card height |
| `resumeSessionId` | — | Exact persisted session to resume |

Fresh runs mint a `main-session-<uuid>` session id and pass it to both the TUI and configured agent. Resumed runs bind both components to `resumeSessionId`. The TUI mounts before the spine so it can render a matching config-start failure instead of leaving a blank terminal. The app composes persistence and session query for `/resume`; an embedding host may additionally provide `tuiResumeHost` for in-place process handoff.

## Front door

This package ships no bin. The [`dsh`](../../../apps/cli/README.md) CLI is the terminal front door: bare `dsh` boots the shipped `examples/tui-agent/cordis.yml` (which mounts this bundle), and `dsh --config <path-to-cordis.yml>` boots an alternate leaf config that mounts it. It loads the optional cwd `.env`, drives the Cordis Loader, and waits for the full plugin tree. The repository installs Loader's optional native helper, so bare package specifiers resolve under plain Node.

## Example leaf

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
- id: tui-agent
  name: '@deepseek-ai/dsh-tui-demo'
  config:
    provider: deepseek
    model: deepseek-v4-flash
    workspaceContext:
      maxBytes: 65536
    welcome: 'Coding agent ready.'
    ui:
      showReasoning: true
```

## Model Experience

### Interactive terminal turn

#### What the model sees

Each non-empty non-command editor submission becomes a user message; a submission during a running turn becomes steering. Slash-command input and output remain human-only, while accepted `/goal` mutations append domain-owned model-visible state. The shared spine contributes the configured persona, workspace instructions, skill catalog, goal controls, and visible tool schemas. TUI rendering itself is not model-visible.

#### Token effect

User, assistant, and tool history grows under the normal session and compaction rules. Headers, cards, plans, Markdown styling, and keybindings add no tokens.

#### KV Cache effect

Append-only while the composed prompt, schemas, route, and retained history prefix remain stable. Composition changes and compaction can invalidate reuse from the first changed token.

### Human-question answer

#### What the model sees

`ask_user_question` retains the tool call and the compact answer or stable interruption error defined by `dsh-tool-ask-user`. The question overlay is terminal-only.

#### Token effect

Only the completed or failed tool result adds retained tokens.

#### KV Cache effect

Append-only; the answer follows the reusable request prefix.

## Known Limitations and Deferred Work

- **TTY-only** — stdin and stdout must both be terminals; automation uses `dsh-cli-demo`.
- **One configured terminal session** — the transcript and editor bind to one exact session id.
- **The app cluster is fixed** — JSONL persistence and ask-user tooling are baked in; different policy requires another composition.
- **Approval is separate** — this app answers `ctx.userInteraction`, not `ctx.approval`; permission prompts require an approval service and answerer.
