/**
 * Matcher shared by both hook dialects. Claude treats alphanumeric/underscore/
 * pipe patterns as literal alternatives and other patterns as regex. Codex
 * uses the same literal fast path, then compiles regex patterns with Rust's
 * `regex` dialect. Missing, empty, and `*` match all. Runtime matching contains
 * invalid regexes as non-matches. A compiled config registry exposes the same
 * stable diagnostic without constructing a second native regex.
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

interface CompiledMatcher {
  matches(query: string): boolean
  diagnostic?: string
  dispose(): void
}

/** A config-lifetime matcher set compiled once and explicitly released. */
export interface CompiledMatchers {
  /** Match one of the patterns supplied to {@link compileMatchers}. */
  matches(matcher: string | undefined, query: string): boolean
  /** Diagnose one supplied pattern using the already-compiled instance. */
  diagnostic(matcher: string | undefined): string | undefined
  /** Release every native matcher. Safe to call more than once. */
  dispose(): void
}

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

/** Release a WASM-backed Codex regex when its owning matcher lifetime ends. */
function disposeRegex(regex: RegExp | RustRegex): void {
  if (regex instanceof RRegex) regex.free()
}

/** Compile one matcher into a reusable, explicitly disposable predicate. */
function compileMatcher(matcher: string | undefined, mode: MatcherMode): CompiledMatcher {
  if (isMatchAll(matcher)) return { matches: () => true, dispose: () => {} }
  const pattern = matcher as string
  if (EXACT_MATCHER.test(pattern)) {
    const alternatives = new Set(pattern.split('|'))
    return { matches: query => alternatives.has(query), dispose: () => {} }
  }
  const regex = compileRegex(pattern, mode)
  if (regex === undefined) {
    return {
      matches: () => false,
      diagnostic: `invalid ${mode} regex matcher ${JSON.stringify(pattern)}`,
      dispose: () => {},
    }
  }
  return {
    matches: query => regex instanceof RRegex ? regex.isMatch(query) : regex.test(query),
    dispose: () => { disposeRegex(regex) },
  }
}

/**
 * Compile a finite config's unique matcher patterns for repeated evaluation.
 * The returned registry owns native Rust-regex allocations; its caller must
 * dispose it when the config/plugin lifetime ends.
 * @param matchers - the complete finite set of patterns in one loaded config.
 * @param mode - the native regex dialect used for non-literal patterns.
 * @returns a reusable registry that owns and disposes its compiled regexes.
 */
export function compileMatchers(matchers: Iterable<string | undefined>, mode: MatcherMode): CompiledMatchers {
  const compiled = new Map<string | undefined, CompiledMatcher>()
  for (const matcher of matchers) {
    if (!compiled.has(matcher)) compiled.set(matcher, compileMatcher(matcher, mode))
  }
  let disposed = false
  return {
    matches(matcher, query) {
      if (disposed) return false
      return compiled.get(matcher)?.matches(query) ?? false
    },
    diagnostic(matcher) {
      if (disposed) return undefined
      return compiled.get(matcher)?.diagnostic
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const matcher of compiled.values()) matcher.dispose()
      compiled.clear()
    },
  }
}

/**
 * Validate one matcher before a bridge accepts its config group.
 * @param matcher - configured pattern; match-all sentinels are valid.
 * @param mode - dialect deciding which regex engine validates non-literal patterns.
 * @returns `undefined` for a valid matcher, otherwise a stable diagnostic.
 */
export function matcherDiagnostic(matcher: string | undefined, mode: MatcherMode): string | undefined {
  const compiled = compileMatcher(matcher, mode)
  try {
    return compiled.diagnostic
  } finally {
    compiled.dispose()
  }
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
  const compiled = compileMatcher(matcher, mode)
  try {
    return compiled.matches(query)
  } finally {
    compiled.dispose()
  }
}
