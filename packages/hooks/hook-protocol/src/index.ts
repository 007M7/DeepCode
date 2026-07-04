/**
 * `@deepseek-ai/dsh-hook-protocol` — the shared core of the Claude Code / Codex
 * hook wire protocol. NOT a cordis plugin: it registers nothing and injects
 * nothing. It is a LIBRARY of dialect-neutral primitives the two bridge plugins
 * (`dsh-hooks-claude`, `dsh-hooks-codex`) import to avoid re-implementing the
 * identical halves of the protocol:
 *
 * - {@link matchesMatcher} — the matcher primitive (literal-or-regex by dialect).
 * - {@link runHook} + {@link parseHookOutput} — run a command hook via `ctx.bash`
 *   (stdin payload + env) and decode its exit-code/stdout/stderr into a neutral
 *   {@link HookOutput}.
 * - {@link mergeHookOutputs} — fold multiple matched hooks into one
 *   most-restrictive {@link MergedHookOutcome} (deny > ask > allow).
 * - {@link appendHookInvoked} / {@link appendHookResult} — the log-only `hook/*`
 *   session-event helpers (declaration-merged into `SessionEventMap`);
 *   `appendHookResult` derives the durable `decision`/`stderrSummary` from the
 *   {@link HookOutput} so the shared event's semantics live in one place.
 *
 * Each bridge owns what genuinely DIFFERS: building the per-event stdin payload
 * (CC vs Codex field sets), the dialect's env/substitution, and mapping the
 * neutral outcome onto the harness's seam-specific typed Decisions.
 *
 * @module @deepseek-ai/dsh-hook-protocol
 */

export type {
  CommandHook,
  HookDialect,
  HookOutput,
  MatcherGroup,
  MatcherMode,
} from './types.ts'
export { matchesMatcher } from './matcher.ts'
export { parseHookOutput } from './codec.ts'
export { DEFAULT_HOOK_TIMEOUT_MS, runHook } from './runner.ts'
export type { RunHookOptions, RunHookResult } from './runner.ts'
export { mergeHookOutputs } from './merge.ts'
export type { MergedDecision, MergedHookOutcome } from './merge.ts'
export { appendHookInvoked, appendHookResult, DEFAULT_STDERR_SUMMARY_MAX_CHARS, summarizeStderr } from './events.ts'
export type { HookInvocation, HookResultRecord } from './events.ts'
