# @deepseek-ai/dsh-tool-pty

Six model-facing tools over `ctx.pty`: `terminal_open`, `terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close`, and `terminal_list`. Every operation requires the exact initiating `Agent`, so a model cannot address another agent's terminal even if it learns the id.

`terminal_send(run_in_background: true)` reuses `ctx.tasks`; task preflight occurs before any terminal write, completion is collected with `task_output`, and `task_kill` requests `Ctrl-C`. Foreground sends use terminal ACP cards; lifecycle, history, signal, and list calls use generic cards.

## Model Experience

### System prompt

#### What the model sees

The plugin contributes this fixed guidance section:

##### Terminal guidance

```markdown
Use a terminal session only when work needs persistent terminal state or interactive stdin; prefer bash/read/write/edit for bounded one-shot operations. Track every terminal session id and close sessions that no longer matter. An inferred_idle or timeout result does not prove the foreground command exited.
```

#### Token effect

Small fixed input cost on every request while the plugin is active.

#### KV Cache effect

Prefix-stable while the registration scope and guidance text are unchanged.

### Tool schemas

#### What the model sees

The six generated schemas are listed in the [`dsh-tool-pty` catalog section](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pty). Their fixed schema tokens are present whenever this plugin is active; agent-scoped tool filtering may hide them.

#### Token effect

Fixed schema cost on requests where the tools are visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results and task context

#### What the model sees

Spawn returns the id and bounded MOTD. Send/read return bounded terminal text plus readiness/history markers. Background mode returns a generic task id. Results remain in session history until compaction; incremental task reads do not repeat consumed output.

#### Token effect

Data-dependent and bounded by the backend; each returned result remains in history until compaction.

#### KV Cache effect

Append-only; new results follow the reusable request prefix.

## Known Limitations and Deferred Work

- No named key sequence, TUI, BEL, resize, auto-start, or cross-agent sharing schema is exposed.
- Background mode requires both `@deepseek-ai/dsh-tasks` and its model-facing control surface.
