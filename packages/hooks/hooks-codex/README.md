# @deepseek-ai/dsh-hooks-codex

A cordis plugin that runs a user's existing **Codex** `hooks.json` on the harness's canonical interception seams. The **Codex dialect** half of the hooks subsystem. The dialect-agnostic primitives come from [`@deepseek-ai/dsh-hook-protocol`](../hook-protocol/README.md); this bridge owns the Codex-specific payloads, matcher mode, and decision mapping.

Codex's hook protocol is a deliberate **subset** of Claude Code's (same `hooks.json` shape):

- **Five hook points only:** `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop` — no subagent / notification / compaction hooks.
- **Regex-only matchers** (no literal fast path; the matcher is always an unanchored regex).
- **snake_case stdin payloads** with `turn_id`/`model` extras, written **without** a trailing newline.
- **No env vars and no command substitution** (a literal `${…}` in a command survives verbatim).
- **A block-only decision model** — `allow`/`ask` are not honored; a hook can only block, never pre-approve.

A native cordis plugin could do everything this bridge does, more powerfully; the bridge exists only to run UNMODIFIED external Codex hooks faithfully (see [the interception-seams RFC](../../../docs/rfc/implemented/feature/2026-06-30-interception-seams.md)).

## Config

```ts
import type { Config } from '@deepseek-ai/dsh-hooks-codex'
const config: Config = {
  configPath: '/path/to/.codex/hooks.json', // required
  model: 'deepseek-v4',                      // optional: stamped on every payload (Codex includes `model`)
  defaultTimeoutMs: 600_000,                 // optional: per-hook timeout when a hook sets none
  stderrSummaryMaxChars: 500,                // optional: char cap on the hook/result event's persisted stderr summary
}
```

In a `cordis.yml`:

```yaml
- dsh-hooks-codex:
    configPath: ./.codex/hooks.json
    model: deepseek-v4
```

The config is parsed **once** at load. `configPath` is **process-level** — a relative path resolves against the process launch cwd at load time, not per-session (`TODO(per-session-hook-config)`). A read/parse failure is contained (logs + registers nothing). Only sync `type: 'command'` hooks run — a non-command or `async: true` hook is parsed-and-skipped with a warning. A hook accepts `timeout` or the `timeoutSec` alias. Events outside the five Codex points are dropped at parse.

The hooks themselves run in the agent's session workspace: for the agent-scoped points the bridge passes the session's `cwd` as the hook process's working directory, so a hook operates in the user's project tree, not the server launch dir.

## Hook points → seam Decisions

| Codex hook | Harness seam | Mapping |
|---|---|---|
| `SessionStart` | `agent/session-start` (emit) | a plain-stdout hook's output → additionalContext → `agent.inject()` |
| `UserPromptSubmit` | `agent/prompt-submit` (waterfall) | `block` (exit 2) → `PromptDecision.block`; additionalContext-only → delegate via `next()` then fold context onto the downstream decision |
| `PreToolUse` | `tools/pre-execute` (waterfall) | `block` → `PreToolDecision.deny` (no `allow`/`ask`) |
| `PostToolUse` | `tools/post-execute` (waterfall) | `block` → `block` with feedback; additionalContext-only → delegate via `next()` then fold context onto the downstream decision |
| `Stop` | `agent/turn-continuation` (waterfall) | a blocking Stop hook forces `continue` with the reason as next-step steering |

A tool call's payload carries the real `tool_name` (the same value the matcher tests) and Codex's `tool_input: { command }` shape (the `command` arg when present, else `''`). The matcher subject is the tool name (`PreToolUse`/`PostToolUse`) or the session source (`SessionStart`); `UserPromptSubmit`/`Stop` ignore matchers.

## Context source

Injected context carries an explicit `{ kind: 'plugin', plugin: 'hooks-codex' }` source (`agent.inject()` would otherwise default it to `{ kind: 'user' }`).

## Deferred

**Stop loop-guard** (`TODO(stop-loop-guard)`): as in CC, a Stop hook that unconditionally blocks would force-continue every step (`stop_hook_active` is always `false` here); the loop-guard is deferred. A hook author must self-limit until it lands.

**`systemMessage`**: a hook's user-facing warning is logged + warned, not surfaced — there is no user-message channel on these seams yet (only model-facing `additionalContext`).
