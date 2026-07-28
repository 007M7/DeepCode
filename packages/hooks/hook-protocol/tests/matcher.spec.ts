import { describe, expect, it } from 'vitest'
import { matcherDiagnostic, matchesMatcher } from '@deepseek-ai/dsh-hook-protocol'

describe('matchesMatcher — match-all sentinels (both dialects)', () => {
  for (const mode of ['claude', 'codex'] as const) {
    it(`${mode}: absent / empty / '*' match everything`, () => {
      expect(matchesMatcher(undefined, 'Bash', mode)).toBe(true)
      expect(matchesMatcher('', 'anything', mode)).toBe(true)
      expect(matchesMatcher('*', 'whatever', mode)).toBe(true)
    })
  }
})

describe('matchesMatcher — claude dialect (literal-or-regex)', () => {
  it('a pure word-char pattern is a LITERAL exact match (not substring)', () => {
    expect(matchesMatcher('Bash', 'Bash', 'claude')).toBe(true)
    // literal exact: "Bash" must NOT match "BashOutput" (a regex would, substring)
    expect(matchesMatcher('Bash', 'BashOutput', 'claude')).toBe(false)
  })

  it('a pipe pattern is literal ALTERNATION (exact match any alternative)', () => {
    expect(matchesMatcher('Edit|Write', 'Edit', 'claude')).toBe(true)
    expect(matchesMatcher('Edit|Write', 'Write', 'claude')).toBe(true)
    expect(matchesMatcher('Edit|Write', 'Read', 'claude')).toBe(false)
    // still exact per-alternative, not substring
    expect(matchesMatcher('Edit|Write', 'EditFile', 'claude')).toBe(false)
  })

  it('a non-word pattern falls through to regex (unanchored)', () => {
    expect(matchesMatcher('^Bash$', 'Bash', 'claude')).toBe(true)
    expect(matchesMatcher('Bash.*', 'BashOutput', 'claude')).toBe(true)
    expect(matchesMatcher('.*\\.ts$', 'foo.ts', 'claude')).toBe(true)
    expect(matchesMatcher('.*\\.ts$', 'foo.js', 'claude')).toBe(false)
  })
})

describe('matchesMatcher — codex dialect (literal-or-Rust-regex)', () => {
  it('a word pattern uses Codex exact-match semantics', () => {
    expect(matchesMatcher('Bash', 'Bash', 'codex')).toBe(true)
    expect(matchesMatcher('Bash', 'BashOutput', 'codex')).toBe(false)
  })

  it('regex alternation and anchors work', () => {
    expect(matchesMatcher('Edit|Write', 'Edit', 'codex')).toBe(true)
    expect(matchesMatcher('^Bash$', 'Bash', 'codex')).toBe(true)
    expect(matchesMatcher('^Bash$', 'BashOutput', 'codex')).toBe(false)
  })

  it('uses Rust regex syntax and matching semantics', () => {
    expect(matchesMatcher('(?i)bash', 'xxBASHyy', 'codex')).toBe(true)
    expect(matchesMatcher('(?x)^ b a s h $ # policy matcher', 'bash', 'codex')).toBe(true)
    expect(matchesMatcher('^\\p{Greek}+$', 'αβ', 'codex')).toBe(true)
    // JavaScript accepts look-around, but Rust regex deliberately does not.
    expect(matchesMatcher('(?=Bash)', 'Bash', 'codex')).toBe(false)
  })
})

describe('matchesMatcher — invalid regex is a non-match (never throws)', () => {
  it('an unbalanced pattern matches nothing rather than throwing', () => {
    // '(' is not the claude-literal charset, so it goes to the regex path and is invalid.
    expect(() => matchesMatcher('(', 'x', 'claude')).not.toThrow()
    expect(matchesMatcher('(', 'x', 'claude')).toBe(false)
    expect(matchesMatcher('[', 'x', 'codex')).toBe(false)
  })
})

describe('matcherDiagnostic — parse-time diagnostics', () => {
  it('accepts match-all sentinels, Claude literals, and valid regexes', () => {
    expect(matcherDiagnostic(undefined, 'claude')).toBeUndefined()
    expect(matcherDiagnostic('', 'codex')).toBeUndefined()
    expect(matcherDiagnostic('*', 'codex')).toBeUndefined()
    expect(matcherDiagnostic('Edit|Write', 'claude')).toBeUndefined()
    expect(matcherDiagnostic('^Bash$', 'claude')).toBeUndefined()
    expect(matcherDiagnostic('Edit|Write', 'codex')).toBeUndefined()
    expect(matcherDiagnostic('(?i)bash', 'codex')).toBeUndefined()
    expect(matcherDiagnostic('(?x)^ b a s h $ # policy matcher', 'codex')).toBeUndefined()
  })

  it('returns a stable diagnostic for invalid regexes in either dialect', () => {
    expect(matcherDiagnostic('(', 'claude')).toBe('invalid claude regex matcher "("')
    expect(matcherDiagnostic('[', 'codex')).toBe('invalid codex regex matcher "["')
    expect(matcherDiagnostic('(?=Bash)', 'codex')).toBe('invalid codex regex matcher "(?=Bash)"')
  })
})
