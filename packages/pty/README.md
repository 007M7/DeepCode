# pty/ — persistent PTY capability family

English | [中文](README.zh.md)

`PTY` stands for **Pseudo-Terminal**（伪终端）. This capability provides persistent, owner-scoped terminal sessions for workflows that require state across tool calls or interactive stdin. PTY complements the one-shot bash and filesystem tools; it does not replace their stronger per-operation contracts.

| Package | Role | ctx key |
|---|---|---|
| [`pty`](pty/README.md) (`@deepseek-ai/dsh-pty`) | Backend registry, branded ids, exact-Agent ownership, session operations, and awaited cleanup | `ctx.pty` |
| [`pty-local`](pty-local/README.md) (`@deepseek-ai/dsh-pty-local`) | Local `node-pty` backend, readiness detection, bounded terminal state, sandboxing, and process-session supervision | registers on `ctx.pty` |
| [`pty-e2b`](pty-e2b/README.md) (`@deepseek-ai/dsh-pty-e2b`) | E2B byte-PTY backend, remote foreground signaling, bounded terminal state, and awaited remote cleanup | registers on `ctx.pty` |
| `tool-pty` (`@deepseek-ai/dsh-tool-pty`) | Six model-facing tools and generic task integration for background sends | registers on `ctx.tools` |

The core design lives in the [persistent PTY Agent Note](../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md); the remote ownership boundary lives in the [E2B extension note](../../.agents/notes/implemented/feature/2026-07-28-e2b-interactive-semantic-code-runtime-poc.md).
