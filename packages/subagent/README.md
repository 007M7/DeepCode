# subagent/ — subagent capability family

The subagent seam: an agent delegating work to a child agent. Like the [bash](../bash/README.md) and [llm](../llm/README.md) families this is a capability seam (see [capability seams](../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)) — but with one defining difference: **multiple provider implementations coexist in one context**, registered by name, rather than the single-implementation bash shape. The registry mirrors the LLM adapter registry.

| Package | Role | ctx key |
|---|---|---|
| `subagent/` | Abstract subagent seam: named-provider registry + vocabulary | `ctx.subagents` |
| `subagent-spawn/` | In-process backend: a fresh child agent (+ the shared run driver) | (registers on `ctx.subagents`) |
| `subagent-fork/` | In-process backend: a child seeded with the parent's completed-turn prefix | (registers on `ctx.subagents`) |
| `subagent-acp/` | Out-of-process backend: a child agent in a spawned subprocess, driven over ACP | (registers on `ctx.subagents`) |
| `tool-subagent/` | Model-facing `subagent` delegation tool over `ctx.subagents` | (registers on `ctx.tools`) |

The interface lives at `subagent/subagent/`. The in-process `subagent-spawn` / `subagent-fork` and the out-of-process `subagent-acp` backends ship here; the test-only `dsh-subagent-mock` (in [support](../support/README.md)) is separate. All **product** packages except the mock.

The proposal and design rationale: [docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md](../../docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md).
