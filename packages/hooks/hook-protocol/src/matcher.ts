/**
 * Matcher shared by both hook dialects. Claude treats alphanumeric/underscore/
 * pipe patterns as literal alternatives and other patterns as regex. Codex
 * uses the same literal fast path, then compiles regex patterns with Rust's
 * `regex` dialect. Missing, empty, and `*` match all. Runtime matching contains
 * invalid regexes as non-matches; config parsers use {@link matcherDiagnostic}
 * to reject them with a diagnostic.
 * @module @deepseek-ai/dsh-hook-protocol/matcher
 */

import { createRequire } from 'node:module'
import type { RRegex as RustRegex } from 'rregex'
import type { MatcherMode } from './types.ts'

// rregex's ESM entry initializes WASM with top-level await. Hook plugins are
// discovered through Cordis Loader's synchronous module boundary, so use the
// package's equivalent synchronous Node entry rather than making both bridge
// modules async merely by importing this shared matcher.
const { RRegex } = createRequire(import.meta.url)('rregex') as {
  RRegex: new(pattern: string) => RustRegex
}

/** True for an absent / empty / `'*'` pattern — the match-all sentinels. */
function isMatchAll(matcher: string | undefined): boolean {
  return matcher === undefined || matcher === '' || matcher === '*'
}

/** An exact pattern is purely word chars + `|` (the regex-vs-literal discriminator). */
const EXACT_MATCHER = /^[A-Za-z0-9_|]+$/

/** Compile one dialect's unanchored regex; invalid patterns return `undefined`. */
function compileRegex(pattern: string, mode: MatcherMode): RegExp | RustRegex | undefined {
  try {
    return mode === 'codex' ? new RRegex(pattern) : new RegExp(pattern)
  } catch (_syntaxError) {
    // Regex construction is the try's only operation, so malformed syntax in
    // the selected dialect is the only expected failure.
    return undefined
  }
}

/** Release the WASM-backed Codex regex once a one-shot validation or match is done. */
function disposeRegex(regex: RegExp | RustRegex): void {
  if (regex instanceof RRegex) regex.free()
}

/**
 * Validate one matcher before a bridge accepts its config group.
 * @param matcher - configured pattern; match-all sentinels are valid.
 * @param mode - dialect deciding which regex engine validates non-literal patterns.
 * @returns `undefined` for a valid matcher, otherwise a stable diagnostic.
 */
export function matcherDiagnostic(matcher: string | undefined, mode: MatcherMode): string | undefined {
  if (isMatchAll(matcher)) return undefined
  const pattern = matcher as string
  if (EXACT_MATCHER.test(pattern)) return undefined
  const regex = compileRegex(pattern, mode)
  if (regex === undefined) return `invalid ${mode} regex matcher ${JSON.stringify(pattern)}`
  disposeRegex(regex)
  return undefined
}

/**
 * Whether `matcher` selects `query` under the given dialect. Literal patterns
 * exact-match pipe-separated alternatives; all other patterns are unanchored
 * regexes in the selected dialect. Invalid regexes return `false` rather than
 * throwing; bridge config parsers surface them through {@link matcherDiagnostic}
 * before use.
 * @param matcher - the configured pattern; absent/empty/`'*'` are the match-all sentinels.
 * @param query - the candidate value (a tool name, a session source, …).
 * @param mode - the dialect deciding which regex engine matches the pattern.
 * @returns `true` when the pattern selects the query; `false` on a non-match or an invalid
 *   regex.
 */
export function matchesMatcher(matcher: string | undefined, query: string, mode: MatcherMode): boolean {
  if (isMatchAll(matcher)) return true
  // matcher is a non-empty string past the match-all guard.
  const pattern = matcher as string
  if (EXACT_MATCHER.test(pattern)) {
    return pattern.split('|').includes(query)
  }
  const regex = compileRegex(pattern, mode)
  if (regex === undefined) return false
  try {
    return regex instanceof RRegex ? regex.isMatch(query) : regex.test(query)
  } finally {
    disposeRegex(regex)
  }
}
