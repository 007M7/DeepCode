/**
 * The matcher primitive shared by both hook dialects: decide whether a matcher pattern selects
 * a given query (a tool name, a session source, …).
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
 *
 * @param matcher - the configured pattern; absent/empty/`'*'` are the match-all sentinels.
 * @param query - the candidate value (a tool name, a session source, …).
 * @param mode - the dialect deciding literal-vs-regex interpretation of the pattern.
 * @returns `true` when the pattern selects the query; `false` on a non-match or an invalid
 *   regex.
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
