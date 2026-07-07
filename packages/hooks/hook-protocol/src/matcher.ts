/**
 * The matcher primitive shared by both hook dialects: decide whether a matcher
 * pattern selects a given query (a tool name, a session source, …).
 *
 * The two dialects differ ONLY in how a non-empty pattern is interpreted, so
 * that single axis is the {@link MatcherMode} parameter:
 * - `claude`: a pattern of purely `[A-Za-z0-9_|]+` is a LITERAL (pipe =
 *   exact-match alternation, e.g. `Edit|Write`); anything else is a regex.
 * - `codex`: every pattern is an unanchored regex (no literal fast path).
 *
 * Both treat an absent / empty / `'*'` pattern as match-all, and both treat an
 * invalid regex as a non-match: a broken matcher selects nothing rather than
 * throwing into the loop. This is SILENT — the boolean return cannot distinguish
 * "did not match" from "failed to compile", so a typo'd pattern (e.g. `[`)
 * quietly disables that matcher with no warning. Surfacing bad config would need
 * a diagnostic-returning variant or parse-time validation (`TODO(matcher-diagnostics)`).
 *
 * @module @deepseek-ai/dsh-hook-protocol/matcher
 */

import type { MatcherMode } from './types.ts'

/** True for an absent / empty / `'*'` pattern — the match-all sentinels. */
function isMatchAll(matcher: string | undefined): boolean {
  return matcher === undefined || matcher === '' || matcher === '*'
}

/** A Claude-literal pattern is purely word chars + `|` (the regex-vs-literal discriminator). */
const CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/

/**
 * Whether `matcher` selects `query` under the given dialect {@link MatcherMode}.
 * Match-all sentinels (absent/`''`/`'*'`) always match. A `claude` literal
 * pattern exact-matches the query (splitting `|` into alternatives); every other
 * `claude` pattern and ALL `codex` patterns are tested as an unanchored regex.
 * An invalid regex matches nothing (never throws).
 * @param matcher - the configured pattern; absent/empty/`'*'` are the match-all sentinels.
 * @param query - the candidate value (a tool name, a session source, …).
 * @param mode - the dialect deciding literal-vs-regex interpretation of the pattern.
 * @returns `true` when the pattern selects the query; `false` on a non-match or an invalid regex.
 */
export function matchesMatcher(matcher: string | undefined, query: string, mode: MatcherMode): boolean {
  if (isMatchAll(matcher)) return true
  // matcher is a non-empty string past the match-all guard.
  const pattern = matcher as string
  if (mode === 'claude' && CLAUDE_LITERAL.test(pattern)) {
    return pattern.split('|').includes(query)
  }
  try {
    return new RegExp(pattern).test(query)
  } catch {
    // Invalid regex: a broken matcher selects nothing rather than throwing into
    // the agent loop. This is silent — callers get `false`, indistinguishable
    // from a genuine non-match, so a typo'd pattern quietly disables the matcher.
    // Surfacing it needs a diagnostic-returning variant (TODO(matcher-diagnostics)).
    return false
  }
}
