/**
 * `@deepseek-ai/dsh-hook-protocol` — the shared core of the Claude Code / Codex hook wire
 * protocol. not a cordis plugin: it registers nothing and injects nothing. It is a LIBRARY of
 * dialect-neutral primitives the two bridge plugins (`dsh-hooks-claude`, `dsh-hooks-codex`)
 * import to avoid re-implementing the identical halves of the protocol.
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
export { createDetachedRuns } from './detached.ts'
export type { DetachedRuns } from './detached.ts'
