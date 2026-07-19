/**
 * Unit tests for the shell-quoting safety boundary, plus a REAL round-trip:
 * every adversarial value, quoted, must survive `bash -c "printf '%s' <quoted>"`
 * byte-for-byte — proving the quoting is inert in an actual shell, not just
 * against a mental model of one.
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { singleQuote } from '@deepseek-ai/dsh-tool-fs-search'

/** Adversarial values a model could pass as pattern / path / include. */
const HOSTILE: readonly string[] = [
  'plain',
  'with spaces',
  "it's got 'quotes'",
  '"double quoted"',
  '$(rm -rf /tmp/nope)',
  '`touch /tmp/nope`',
  '$HOME and ${PATH}',
  'semi;colon && chain || pipe | bg &',
  'newline\nin the middle',
  '-leading-dash',
  '--leading-double-dash',
  '*?[a-z]{x,y}',
  '!bang',
  '\\backslash\\',
  '~tilde',
  '# not a comment',
  '>redirect <input 2>&1',
]

describe('singleQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(singleQuote('abc')).toBe("'abc'")
  })

  it("rewrites embedded single quotes as '\\''", () => {
    expect(singleQuote("a'b")).toBe("'a'\\''b'")
    expect(singleQuote("''")).toBe("''\\'''\\'''")
  })

  it.each(HOSTILE.map(value => [JSON.stringify(value), value] as const))(
    'round-trips %s through a real bash -c unchanged',
    (_label, value) => {
      const result = spawnSync('bash', ['-c', `printf '%s' ${singleQuote(value)}`], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(value)
    },
  )

  it('a quoted command substitution does not execute (the world stays untouched)', () => {
    const canary = `/tmp/dsh-quote-canary-${process.pid}`
    const result = spawnSync('bash', ['-c', `printf '%s' ${singleQuote(`$(touch ${canary})`)}`], { encoding: 'utf8' })
    expect(result.stdout).toBe(`$(touch ${canary})`)
    // The canary file must NOT exist — the substitution stayed literal.
    expect(spawnSync('test', ['-e', canary]).status).not.toBe(0)
  })
})
