# @deepseek-ai/dsh-hooks-claude

A cordis plugin that runs a user's existing **Claude Code** hook config (a `hooks.json`, or a settings file's `hooks` key) on the harness's canonical interception seams. It is the **CC dialect** half of the hooks subsystem: it owns CC's per-event stdin payloads, CC's env + `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` substitution, and the mapping from a hook's neutral outcome onto the harness's typed Decisions. The dialect-agnostic primitives (matcher, exit-code/stdout codec, `ctx.bash` execution, most-restrictive merge, the `hook/*` events) come from [`@deepseek-ai/dsh-hook-protocol`](../hook-protocol/README.md).

A native cordis plugin could do everything this bridge does — more powerfully, with typed returns and no serialization boundary. **The bridge exists only to run UNMODIFIED external CC hooks faithfully**; anything bespoke should be a native plugin on the same seams (see [the interception-seams RFC](../../../docs/rfc/implemented/feature/2026-06-30-interception-seams.md)).

## Config

```ts
import type { Config } from '@deepseek-ai/dsh-hooks-claude'
const config: Config = {
  configPath: '/path/to/hooks.json', // required: a hooks.json or a settings file with a `hooks` key
  pluginRoot: '/path/to/plugin',     // optional: replaces ${CLAUDE_PLUGIN_ROOT} in command strings
  projectDir: '/path/to/project',    // optional: replaces ${CLAUDE_PROJECT_DIR} AND sets the hook env var; defaults to the session cwd when omitted
  defaultTimeoutMs: 600_000,         // optional: per-hook timeout when a hook sets none (CC default)
  stderrSummaryMaxChars: 500,        // optional: char cap on the hook/result event's persisted stderr summary
}
```

In a `cordis.yml`:

```yaml
- dsh-hooks-claude:
    configPath: ./.claude/hooks.json
    pluginRoot: ./.claude/plugins/my-plugin
    projectDir: .
```

The config is parsed **once** at load. `configPath` is **process-level**: a relative path resolves against the process's launch cwd at load time, so a single config applies to the whole process — there is no per-session (`session/new.cwd`) config discovery yet (`TODO(per-session-hook-config)`). A read/parse failure is contained — the bridge logs a warning and registers nothing rather than crashing boot (a typo'd path must not take the agent down). Only `type: 'command'` hooks run; a `prompt`/`agent`/HTTP hook is parsed-and-skipped with a warning. A hook with no per-hook `timeout` runs under the protocol's reference default (`DEFAULT_HOOK_TIMEOUT_MS` from `dsh-hook-protocol`, 10 minutes — the CC default).

The hooks **themselves** run in the agent's session workspace: for the agent-scoped points the bridge passes the session's `cwd` (the `session/new.cwd`) as the hook process's working directory, so a hook's `pwd`/relative-path/marker operates in the user's project tree, not the server launch dir.

## Hook points → seam Decisions

| CC hook | Harness seam | Mapping |
|---|---|---|
| `SessionStart` | `agent/session-start` (emit) | additionalContext → `agent.inject()` into the new session (cannot block) |
| `UserPromptSubmit` | `agent/prompt-submit` (waterfall) | `deny` → `PromptDecision.block`; additionalContext-only → delegate via `next()` then fold context onto the downstream decision (a later listener can still block/rewrite) |
| `PreToolUse` | `tools/pre-execute` (waterfall) | `deny` → `PreToolDecision.deny`; `ask` → `PreToolDecision.ask` |
| `PostToolUse` | `tools/post-execute` (waterfall) | `deny` → `block` with feedback; additionalContext-only → delegate via `next()` then fold context onto the downstream decision |
| `Stop` | `agent/turn-continuation` (waterfall) | a blocking Stop hook forces `continue`, feeding its reason as next-step steering |
| `SubagentStart` | `subagent/start` (emit) | additionalContext → `agent.inject()` into the live child |
| `SubagentStop` | `subagent/end` (emit) | observe-only |

The three emit points run detached — no seam awaits a `SessionStart`/`SubagentStart`/`SubagentStop` hook. Each run chain is tracked, and disposing the bridge aborts still-running hook processes, then drains the continuations before the dispose resolves (`createDetachedRuns` in `dsh-hook-protocol`).

The matcher subject is the tool name (`PreToolUse`/`PostToolUse`), the session source (`SessionStart`), or a constant `agent_type` of `general-purpose` (`SubagentStart`/`SubagentStop` — the harness subagent seam carries no per-kind label, so the bridge reports Claude Code's own Task-tool default; a default/`*`/empty `agent_type` matcher fires, a specific-kind matcher does not); `UserPromptSubmit`/`Stop` ignore matchers. Multiple file-configured hooks on one point run **serially, in config order**, and fold most-restrictively (`deny > ask > allow`, see `dsh-hook-protocol`); serial keeps each hook's `hook/invoked`/`hook/result` pair adjacent in the log, and the fold is order-independent for the decision (see the RFC's "run serially, not concurrently" note).

## Context source

Injected context carries an explicit `{ kind: 'plugin', plugin: 'hooks-claude' }` source. `agent.inject()` defaults a missing source to `{ kind: 'user' }`, which would mislabel plugin context as a user prompt — so the bridge always names itself.

## Deferred (faithful-but-degraded)

- **`updatedInput` (tool-input rewrite)** is logged + warned, **not honored** — input rewrite is a deferred consistency-design problem ([the pre-tool-input-rewrite RFC](../../../docs/rfc/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)).
- **`systemMessage`** (a hook's user-facing warning) is logged + warned, **not surfaced** — there is no user-message channel on these seams yet (only model-facing `additionalContext`). The shared merge collects it; the bridge does not yet render it.
- **Stop loop-guard.** CC breaks an infinite force-continue with `stop_hook_active` (true once a Stop hook has fired this run) plus a max-consecutive cap; both are deferred (`TODO(stop-loop-guard)`). Today `stop_hook_active` is always `false`, so a Stop hook that unconditionally blocks would force-continue every step — a hook author must self-limit until the guard lands.
