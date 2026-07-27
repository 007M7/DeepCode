# subagent/ — subagent capability family

English | [中文](README.zh.md)

The subagent seam: an agent delegating work to a child agent. Like the [bash](../bash/README.md) and [llm](../llm/README.md) families this is a capability seam (see [capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)) — but with one defining difference: **multiple provider implementations coexist in one context**, registered by name, rather than the single-implementation bash shape. The registry mirrors the LLM adapter registry.

| Package | Role | ctx key |
|---|---|---|
| `subagent/` | Abstract subagent seam: named-provider registry + vocabulary | `ctx.subagents` |
| `subagent-inprocess/` | Shared in-process run driver (no provider; one cleanup effect per run) | — |
| `subagent-spawn/` | In-process backend: a fresh child agent | (registers on `ctx.subagents`) |
| `subagent-fork/` | In-process backend: a child seeded with the parent's completed-turn prefix | (registers on `ctx.subagents`) |
| `subagent-subprocess/` | Shared out-of-process machinery: env scrub, dispose ladder, isolated config dirs (pure lib; registers nothing) | — |
| `subagent-acp/` | Out-of-process backend: a child agent in a spawned subprocess, driven over ACP | (registers on `ctx.subagents`) |
| `tool-subagent/` | Model-facing `subagent` delegation tool over `ctx.subagents` | (registers on `ctx.tools`) |

The interface lives at `subagent/subagent/`. The in-process `subagent-spawn` / `subagent-fork` backends share the `subagent-inprocess` driver (a library with no provider of its own — both depend on it, neither on the other), and the out-of-process `subagent-acp` backend builds on the `subagent-subprocess` library (the credential env scrub, the dispose ladder, isolated config dirs). Tests replace only the child boundary with package-local fixtures.

The proposal and design rationale: [.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md).
