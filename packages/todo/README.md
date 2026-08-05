# todo/ — todo / planning capability family

English | [中文](README.zh.md)

The model-facing todo tool. A single **product** package — there is no interface/implementation seam here, because the list is single-owner session state (one agent session owns its own list), not a swappable capability.

| Package | Role | ctx key |
|---|---|---|
| `tool-todo/` | Model-facing `todo_write` tool; writes the whole list to the session log (`todo/write`) | (registers on `ctx.tools`) |

The list lives on the event-sourced session log (`SessionEventMap['todo/write']`, owned by [`dsh-session`](../core/session)); this package is the thin consumer that appends the snapshot. Host/client runtimes render the durable list from session events.
