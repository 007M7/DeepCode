/**
 * Dialect-neutral vocabulary for the Claude Code / Codex hook wire protocol,
 * plus the log-only `hook/*` session events. Types only — runtime helpers live
 * in the sibling modules (`matcher`, `codec`, `runner`, `merge`, `events`).
 *
 * This package is the SHARED CORE: the truly-identical primitives both the
 * `dsh-hooks-claude` and `dsh-hooks-codex` bridges build on. Each bridge owns
 * its own per-dialect stdin-payload construction and decision mapping on top of
 * these primitives — the divergences (which events exist, literal-vs-regex
 * matching, env/substitution, snake_case extras, allow/ask support) are the
 * BRIDGE's concern, not this lib's.
 *
 * @module @deepseek-ai/dsh-hook-protocol/types
 */

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * A hook command was invoked at a hook point — log-only provenance (like
     * `compact/*`; NOT a {@link SurfaceEventType}, carries no `surfaceOp`).
     * `dialect` is the bridge that ran it (`claude`/`codex`/`native`), `point`
     * the hook point (`PreToolUse`, `Stop`, …), `matcher` the matcher-group
     * pattern that selected it (absent for match-all), `handlerId` a stable id
     * for the command (so an invoked/result pair correlates). `turn` is the open
     * turn the invocation lives inside.
     * @mode emit
     */
    'hook/invoked': {
      turn: number
      point: string
      dialect: HookDialect
      matcher?: string
      handlerId: string
    }
    /**
     * A hook command's outcome — log-only, paired with a prior `hook/invoked`
     * (same `handlerId`). `decision` is the resolved dialect-neutral outcome the
     * bridge mapped it to (`allow`/`deny`/`ask`/`block`/`continue`/`stop`/`pass`),
     * `exitCode` the process exit (absent if it never ran), `stderrSummary` a
     * truncated stderr (the block reason source on exit 2), `durationMs` the wall
     * time. `turn` matches the `hook/invoked`.
     * @mode emit
     */
    'hook/result': {
      turn: number
      point: string
      handlerId: string
      decision: string
      exitCode?: number
      stderrSummary?: string
      durationMs: number
    }
  }
}

/** Which protocol dialect a hook config / invocation belongs to. */
export type HookDialect = 'claude' | 'codex' | 'native'

/**
 * One configured command hook (the `{ type: 'command', command, timeout? }`
 * shape shared by both dialects). Non-command hook types (CC's `prompt`/`agent`/
 * `http`) are parsed-and-skipped by a bridge, so only this shape reaches the
 * runner.
 */
export interface CommandHook {
  /** The shell command line to run. */
  command: string
  /** Per-hook timeout in SECONDS (the wire unit); the runner converts to ms. */
  timeoutSec?: number
}

/**
 * One matcher group: a `matcher` pattern (absent / `''` / `'*'` = match-all)
 * plus the command hooks that run when it matches. Both dialects share this
 * shape (CC's `hooks.json` and Codex's `hooks.json`).
 */
export interface MatcherGroup {
  matcher?: string
  hooks: CommandHook[]
}

/**
 * How a matcher pattern is interpreted. Claude Code uses {@link literal} when the
 * pattern is purely `[A-Za-z0-9_|]+` (pipe = exact-match alternation) and
 * {@link regex} otherwise; Codex is always {@link regex}. The bridge picks the
 * mode for its dialect.
 */
export type MatcherMode = 'claude' | 'codex'

/**
 * The dialect-neutral OUTCOME a hook produced, parsed from its exit code +
 * stdout JSON + stderr by {@link parseHookOutput}. A bridge maps this onto a
 * seam-specific typed Decision (PreToolDecision, PromptDecision, …). Every field
 * is OPTIONAL because a hook may exercise any subset; the bridge decides which
 * fields are meaningful for its hook point and which it ignores (faithful-but-
 * degraded — e.g. Codex ignores `allow`/`ask`).
 */
export interface HookOutput {
  /** The raw process exit code (`undefined` if the hook could not be run). */
  exitCode: number | undefined
  /** Trimmed stderr — the block-reason source on a blocking (exit 2) hook. */
  stderr: string
  /**
   * Trimmed stdout, verbatim. On a clean exit a hook may emit PLAIN (non-JSON)
   * stdout that the protocol renders as output (CC) or treats as
   * `additionalContext` (Codex SessionStart/UserPromptSubmit) — so the bridge
   * needs the raw text, not just the parsed structured fields. Empty string when
   * the hook produced no stdout.
   */
  stdout: string
  /**
   * `false` ⇒ the hook asked to halt (CC/Codex `continue:false`); pairs with
   * {@link stopReason}. `true`/absent ⇒ proceed.
   */
  continue?: boolean
  /** Human-readable reason shown when {@link continue} is `false`. */
  stopReason?: string
  /** Hide the hook's stdout from the transcript (CC `suppressOutput`). */
  suppressOutput?: boolean
  /**
   * The neutral blocking decision a hook expressed, folded from the two channels
   * the reference protocols keep DISTINCT: the legacy top-level `decision`
   * (`approve`/`block` only) and `hookSpecificOutput.permissionDecision`
   * (`allow`/`deny`/`ask`). We normalize them to one enum — `'block'`/`'deny'`
   * forbid, `'approve'`/`'allow'` permit, `'ask'` requests confirmation — but
   * `'allow'`/`'deny'`/`'ask'` arise ONLY from a `permissionDecision`, never from
   * a top-level `decision` (an out-of-band `{"decision":"deny"}` is invalid and
   * ignored, matching the schemas). Absent ⇒ no explicit decision (exit code governs).
   */
  decision?: 'approve' | 'allow' | 'block' | 'deny' | 'ask'
  /** The reason/explanation accompanying {@link decision}. */
  reason?: string
  /**
   * The `hookSpecificOutput.hookEventName` discriminator, when the hook emitted
   * a `hookSpecificOutput` block. The reference schemas key that block by event,
   * so a block whose `hookEventName` names a DIFFERENT event than the one firing
   * is malformed: {@link parseHookOutput} DISCARDS its event-scoped fields when
   * given the firing event's `expectedEventName` (a hook claiming `PreToolUse`
   * output on a `Stop` event does not affect the `Stop`). This field is still
   * surfaced even on a mismatch — the record shows what the block claimed. Absent
   * when the hook emitted no `hookSpecificOutput`.
   */
  hookEventName?: string
  /** Extra context to inject for the next model request (CC `additionalContext`). */
  additionalContext?: string
  /** A warning surfaced to the user (CC `systemMessage`). */
  systemMessage?: string
  /**
   * A tool-input rewrite a hook requested (CC `updatedInput`). PARSED but NOT
   * honored — input rewrite is deferred (see the interception-seams RFC); a
   * bridge logs + warns when this is present.
   */
  updatedInput?: Record<string, unknown>
}
