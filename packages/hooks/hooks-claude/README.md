# @deepseek-ai/dsh-hooks-claude

A cordis plugin that runs the supported command-hook subset of a user's existing **Claude Code** hook config (a `hooks.json`, or a settings file's `hooks` key) on the harness's canonical interception seams. It is the **CC dialect** half of the hooks subsystem: it owns the bridge's CC-shaped per-event stdin payloads, CC's env + `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` substitution, and the mapping from a hook's neutral outcome onto the harness's typed Decisions. The dialect-agnostic primitives (matcher, exit-code/stdout codec, `ctx.bash` execution, most-restrictive merge, the `hook/*` events) come from [`@deepseek-ai/dsh-hook-protocol`](../hook-protocol/README.md).

A native cordis plugin could do everything this bridge does — more powerfully, with typed returns and no serialization boundary. **The bridge exists only as a compatibility path for the mapped CC command-hook subset**; anything bespoke should be a native plugin on the same seams (see [the interception-seams RFC](../../../docs/rfc/implemented/feature/2026-06-30-interception-seams.md)).

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

The config is parsed **once** at load. `configPath` is **process-level**: a relative path resolves against the process's launch cwd at load time, so a single config applies to the whole process — there is no per-session (`session/new.cwd`) config discovery yet (`TODO(per-session-hook-config)`). A read/parse failure is contained — the bridge logs a warning and registers nothing rather than crashing boot (a typo'd path must not take the agent down). Only shell-form `type: 'command'` hooks run; an `http`/`mcp_tool`/`prompt`/`agent` hook is parsed-and-skipped with a warning. A hook with no per-hook `timeout` runs under the protocol's reference default (`DEFAULT_HOOK_TIMEOUT_MS` from `dsh-hook-protocol`, 10 minutes — the CC default).

The hooks **themselves** run in the agent's session workspace: for the agent-scoped points the bridge passes the session's `cwd` (the `session/new.cwd`) as the hook process's working directory, so a hook's `pwd`/relative-path/marker operates in the user's project tree, not the server launch dir.

## Hook points → seam Decisions

| CC hook | Harness seam | Mapping |
|---|---|---|
| `SessionStart` | `agent/session-start` (emit) | additionalContext → `agent.inject()` into the new session (cannot block) |
| `UserPromptSubmit` | `agent/prompt-submit` (waterfall) | `deny` → `PromptDecision.block`; additionalContext-only → delegate via `next()` then fold context onto the downstream decision (a later listener can still block/rewrite) |
| `PreToolUse` | `tools/pre-execute` (waterfall) | `deny` → `PreToolDecision.deny`; `ask` → `PreToolDecision.ask` |
| `PostToolUse` | `tools/post-execute` (waterfall) | `deny` → `block` with feedback; additionalContext-only → delegate via `next()` then fold context onto the downstream decision (a Code Mode sub-call’s context is dropped by the run_code bridge — see [the pipeline doc](../../../docs/tool-execution-pipeline.md)) |
| `Stop` | `agent/turn-continuation` (waterfall) | a blocking Stop hook forces `continue`, feeding its reason as next-step steering |
| `SubagentStart` | `subagent/start` (emit) | additionalContext → `agent.inject()` into a live in-process child; a remote child has no local injection target |
| `SubagentStop` | `subagent/end` (emit) | observe-only |

The three emit points run detached — no seam awaits a `SessionStart`/`SubagentStart`/`SubagentStop` hook. Each run chain is tracked, and disposing the bridge aborts still-running hook processes, then drains the continuations before the dispose resolves (`createDetachedRuns` in `dsh-hook-protocol`).

The matcher subject is the tool name (`PreToolUse`/`PostToolUse`), the session source (`SessionStart`), or a constant `agent_type` of `general-purpose` (`SubagentStart`/`SubagentStop` — the harness subagent seam carries no per-kind label, so the bridge reports Claude Code's own Task-tool default; a default/`*`/empty `agent_type` matcher fires, a specific-kind matcher does not); `UserPromptSubmit`/`Stop` ignore matchers. Multiple file-configured hooks on one point run **serially, in config order**, and fold most-restrictively (`deny > ask > allow`, see `dsh-hook-protocol`); serial keeps each hook's `hook/invoked`/`hook/result` pair adjacent in the log, and the fold is order-independent for the decision (see the RFC's "run serially, not concurrently" note).

## Context source

Injected context carries an explicit `{ kind: 'plugin', plugin: 'hooks-claude' }` source. `agent.inject()` defaults a missing source to `{ kind: 'user' }`, which would mislabel plugin context as a user prompt — so the bridge always names itself.

## Model Experience

### Hook-provided context

**What the model sees**: `SessionStart`, accepted prompt, post-tool, and live in-process subagent-start hooks can add source-attributed context messages; a blocking `Stop` hook adds its reason as next-step steering. Remote-child injection has no local target.

**Token effect**: No cost when hooks return no context. Hook text is data-dependent, logged, and resent in later conversation requests until compaction.

### Blocked prompt or tool outcome

**What the model sees**: Provider-supplied reasons pass through verbatim. When absent, a blocked prompt uses exactly `blocked by UserPromptSubmit hook`, a denied tool becomes `Error: blocked by PreToolUse hook`, blocked post-tool feedback is exactly `blocked by PostToolUse hook`, and a blocking stop adds steering exactly `continue: blocked by Stop hook`. `systemMessage` and `updatedInput` are logged or warned but are not model-visible in this implementation.

**Token effect**: Blocking a prompt removes that prompt's request tokens; denial or feedback adds the retained fallback or provider text; forced continuation pays another full request.

## Known Limitations and Deferred Work

- **Unsupported hook events (23 of Claude Code's current 30):** `Setup`, `InstructionsLoaded`, `UserPromptExpansion`, `MessageDisplay`, `PermissionRequest`, `PostToolUseFailure`, `PostToolBatch`, `PermissionDenied`, `Notification`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `SessionEnd`, `Elicitation`, and `ElicitationResult`. Config for these events is parsed but never dispatched. The comparison baseline is Claude Code's [official hook-event reference](https://code.claude.com/docs/en/hooks#hook-events).
- **`SessionStart` is partial:** JSON `additionalContext` is consumed, but plain stdout context, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills`, and `CLAUDE_ENV_FILE` are unsupported. The hook runs detached, so context can miss the first request (`TODO(session-start-gating)`), and the payload omits current optional fields such as `model`, `agent_type`, and `session_title`.
- **`UserPromptSubmit` is partial:** blocking and JSON `additionalContext` work, but plain stdout context, `sessionTitle`, and `suppressOriginalPrompt` are unsupported. Unless overridden, the bridge also uses its 600-second default instead of Claude Code's event-specific 30-second command timeout.
- **`PreToolUse` is partial:** `deny` and `ask` decisions work; `allow` does not pre-approve, `defer` is unsupported, `additionalContext` is ignored, and `updatedInput` is logged + warned but not honored ([the pre-tool-input-rewrite RFC](../../../docs/rfc/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)).
- **`PostToolUse` is partial:** blocking feedback and JSON `additionalContext` work, but `updatedToolOutput` and `updatedMCPToolOutput` are unsupported and `tool_response` is flattened to text.
- **`SubagentStart` and `SubagentStop` are partial:** both report a constant `agent_type` of `general-purpose` and use the child session id where Claude Code reports the parent session. Start context is best-effort and can only reach a live in-process child, while stop is observe-only and cannot block the subagent or feed it context. Start omits `transcript_path`; stop also omits `agent_transcript_path`, `last_assistant_message`, `background_tasks`, and `session_crons` and always reports `stop_hook_active: false`.
- **`Stop` is partial:** blocking forces another model turn, but `stop_hook_active` is always `false`, `last_assistant_message`, `background_tasks`, and `session_crons` are omitted, and the consecutive-block cap is not implemented (`TODO(stop-loop-guard)`). An unconditionally blocking hook therefore force-continues every step unless it self-limits.
- **Common payload and output fields are partial:** mapped event payloads omit `prompt_id`, `transcript_path`, `permission_mode`, and `effort` where Claude Code would provide them. `systemMessage` is logged + warned but not surfaced; `{"continue": false}` is recorded but does not halt the run; `suppressOutput`, `stopReason`, and `terminalSequence` are not applied (`TODO(hook-continue-false)`).
- **Handler and config support is partial:** only shell-form command handlers run. `http`, `mcp_tool`, `prompt`, and `agent` handlers are skipped; command-handler options such as `args`, `async`, `asyncRewake`, `shell`, `if`, `once`, and `statusMessage` are not honored. Matching handlers run serially and are not deduplicated, whereas Claude Code runs them in parallel and deduplicates identical handlers. One process-level `configPath` is parsed once at load; Claude Code's layered project, user, plugin, and policy discovery and live reload are not implemented (`TODO(per-session-hook-config)`).
