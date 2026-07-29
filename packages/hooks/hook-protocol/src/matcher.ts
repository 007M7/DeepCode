/**
 * Matcher shared by both hook dialects. Claude treats alphanumeric/underscore/
 * pipe patterns as literal alternatives and other patterns as regex. Codex
 * uses the same literal fast path, then compiles regex patterns with Rust's
 * `regex` dialect. Missing, empty, and `*` match all. Runtime matching contains
 * invalid regexes as non-matches. Codex regexes are interned in a bounded pool
 * shared across module reloads; a config registry leases those instances for
 * diagnostics and runtime matching without reconstructing them.
 * @module @deepseek-ai/dsh-hook-protocol/matcher
 */

import { createRequire } from 'node:module'
import type { RRegex as RustRegex } from 'rregex'
import type { MatcherMode } from './types.ts'

type CodexRegexPoolEntry =
  | { regex: RustRegex }
  | { diagnostic: string }

type RRegexModule = {
  RRegex: new(pattern: string) => RustRegex
} & Record<symbol, unknown>

/** Process-wide ceiling for distinct non-literal Codex matcher patterns. */
export const MAX_INTERNED_CODEX_REGEX_PATTERNS = 128

// rregex's ESM entry initializes WASM with top-level await. Hook plugins are
// discovered through Cordis Loader's synchronous module boundary, so use the
// package's equivalent synchronous Node entry rather than making both bridge
// modules async merely by importing this shared matcher. The versioned symbol
// lives on that CJS module instance: Cordis may reload this library module, but
// Node retains the dependency module and therefore its bounded intern pool.
const rregexModule = createRequire(import.meta.url)('rregex') as RRegexModule
const { RRegex } = rregexModule
const CODEX_REGEX_POOL_KEY = Symbol.for('@deepseek-ai/dsh-hook-protocol/rregex-pool/v1')
const priorPool = rregexModule[CODEX_REGEX_POOL_KEY]
const codexRegexPool = priorPool instanceof Map
  ? priorPool as Map<string, CodexRegexPoolEntry>
  : new Map<string, CodexRegexPoolEntry>()
if (!(priorPool instanceof Map)) {
  rregexModule[CODEX_REGEX_POOL_KEY] = codexRegexPool
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
}

/** A config-lifetime matcher set compiled once and explicitly disconnected. */
export interface CompiledMatchers {
  /** Match one of the patterns supplied to {@link compileMatchers}. */
  matches(matcher: string | undefined, query: string): boolean
  /** Diagnose one supplied pattern using the already-compiled instance. */
  diagnostic(matcher: string | undefined): string | undefined
  /** Release this registry's references. Safe to call more than once. */
  dispose(): void
}

/** Intern one Codex regex or its diagnostic without exceeding the process budget. */
function internCodexRegex(pattern: string): CodexRegexPoolEntry {
  const existing = codexRegexPool.get(pattern)
  if (existing !== undefined) return existing
  if (codexRegexPool.size >= MAX_INTERNED_CODEX_REGEX_PATTERNS) {
    return {
      diagnostic: `codex regex matcher capacity exceeded (${MAX_INTERNED_CODEX_REGEX_PATTERNS} distinct patterns per process) for ${JSON.stringify(pattern)}`,
    }
  }

  let entry: CodexRegexPoolEntry
  try {
    entry = { regex: new RRegex(pattern) }
  } catch (_syntaxError) {
    // Regex construction is the try's only operation, so malformed syntax in
    // Rust's dialect is the only expected failure. Cache failures too: a bad
    // config repeatedly reloaded must not keep growing WASM memory.
    entry = { diagnostic: `invalid codex regex matcher ${JSON.stringify(pattern)}` }
  }
  codexRegexPool.set(pattern, entry)
  return entry
}

/** Compile one matcher into a reusable predicate. */
function compileMatcher(matcher: string | undefined, mode: MatcherMode): CompiledMatcher {
  if (isMatchAll(matcher)) return { matches: () => true }
  const pattern = matcher as string
  if (EXACT_MATCHER.test(pattern)) {
    const alternatives = new Set(pattern.split('|'))
    return { matches: query => alternatives.has(query) }
  }

  if (mode === 'codex') {
    const entry = internCodexRegex(pattern)
    if ('regex' in entry) {
      const regex = entry.regex
      return { matches: query => regex.isMatch(query) }
    }
    return {
      matches: () => false,
      diagnostic: entry.diagnostic,
    }
  }

  try {
    const regex = new RegExp(pattern)
    return { matches: query => regex.test(query) }
  } catch (_syntaxError) {
    return {
      matches: () => false,
      diagnostic: `invalid claude regex matcher ${JSON.stringify(pattern)}`,
    }
  }
}

/**
 * Compile a finite config's unique matcher patterns for repeated evaluation.
 * The returned registry owns one config's references. Codex native instances
 * live in a bounded, reload-stable process pool; disposal disconnects this
 * config but deliberately keeps interned instances for later reloads.
 * @param matchers - the complete finite set of patterns in one loaded config.
 * @param mode - the native regex dialect used for non-literal patterns.
 * @returns a reusable registry that disconnects its config-local lookups on disposal.
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
  return compileMatcher(matcher, mode).diagnostic
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
  return compileMatcher(matcher, mode).matches(query)
}
