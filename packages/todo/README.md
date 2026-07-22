# todo/ — todo / planning capability family

The model-facing todo tool. A single **product** package — there is no interface/implementation seam here, because the list is single-owner session state (one agent session owns its own list), not a swappable capability.

| Package | Role | ctx key |
|---|---|---|
| `tool-todo/` | Model-facing `todo_write` tool; writes the whole list to the session log (`todo/write`) | (registers on `ctx.tools`) |

The list lives on the event-sourced session log (`SessionEventMap['todo/write']`, owned by [`dsh-session`](../core/session)); this package is the thin consumer that appends the snapshot. UIs render off `session/event`: the [TUI app](../examples/tui-demo) shows a persistent plan, while the [ACP bridge](../ui/acp) maps it to a `plan` sessionUpdate.
