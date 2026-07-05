import { describe, expect, it } from 'vitest'
import { WorkflowError } from '@deepseek-ai/dsh-workflow'
import { extractMeta } from '../src/meta.ts'

const TIMEOUT = 1000

/** Extract and expect success. */
function ok(script: string) {
  return extractMeta(script, TIMEOUT)
}

/** The WorkflowError a bad script produces (throws if it extracts cleanly). */
function bad(script: string): WorkflowError {
  try {
    extractMeta(script, TIMEOUT)
  } catch (error: unknown) {
    if (error instanceof WorkflowError) return error
    throw error
  }
  throw new Error('expected extraction to fail')
}

describe('extractMeta', () => {
  it('extracts a full meta block and blanks the statement line-preservingly', () => {
    const script = `export const meta = {
  name: 'audit-routes',
  description: 'Audit every route',
  whenToUse: 'when auditing',
  phases: [{ title: 'Scan', detail: 'find files' }, { title: 'Fix', model: 'deepseek-v4-pro' }],
}
const x = 1
return x`
    const { meta, body } = ok(script)
    expect(meta).toEqual({
      name: 'audit-routes',
      description: 'Audit every route',
      whenToUse: 'when auditing',
      phases: [{ title: 'Scan', detail: 'find files' }, { title: 'Fix', model: 'deepseek-v4-pro' }],
    })
    // Same line count; the statement's characters blanked; the body intact.
    expect(body.split('\n').length).toBe(script.split('\n').length)
    expect(body.split('\n')[6]).toBe('const x = 1')
    expect(body).not.toContain('export')
  })

  it('allows leading line and block comments before the meta statement', () => {
    const script = `// a workflow
/* multi
   line */
export const meta = { name: 'x', description: 'y' }
return 1`
    expect(ok(script).meta.name).toBe('x')
  })

  it('handles braces inside strings and comments while scanning', () => {
    const script = `export const meta = {
  name: 'tricky', // } not a close {
  /* } also not } */
  description: "has { braces } and 'quotes'",
}
return 2`
    expect(ok(script).meta.description).toBe("has { braces } and 'quotes'")
  })

  it('tolerates template-quoted strings WITHOUT interpolation, escapes included', () => {
    const script = 'export const meta = { name: `plain`, description: `esc \\` tick` }\nreturn 1'
    expect(ok(script).meta.name).toBe('plain')
  })

  it('consumes a trailing semicolon after the literal, spaces included', () => {
    const { body } = ok("export const meta = { name: 'x', description: 'y' };\nreturn 1")
    expect(body).not.toContain(';')
    expect(body.split('\n')[1]).toBe('return 1')
    const spaced = ok("export const meta = { name: 'x', description: 'y' }  ;\nreturn 1")
    expect(spaced.body).not.toContain(';')
  })

  it('rejects a script that does not begin with the meta statement (SCRIPT_PARSE)', () => {
    expect(bad('const a = 1').code).toBe('SCRIPT_PARSE')
    expect(bad('').code).toBe('SCRIPT_PARSE')
    expect(bad('export const meta = [1]').code).toBe('SCRIPT_PARSE')
  })

  it('rejects template interpolation in the meta block as impure (SCRIPT_PARSE)', () => {
    const error = bad('export const meta = { name: `w-${1}`, description: "d" }\nreturn 1')
    expect(error.code).toBe('SCRIPT_PARSE')
    expect(error.message).toContain('pure literal')
  })

  it('rejects unbalanced literals, unterminated strings, and unterminated comments (SCRIPT_PARSE)', () => {
    expect(bad('export const meta = { name: "x", description: "y"').code).toBe('SCRIPT_PARSE')
    expect(bad('export const meta = { name: "x').code).toBe('SCRIPT_PARSE')
    expect(bad('export const meta = { /* open').code).toBe('SCRIPT_PARSE')
    // A line comment running to EOF (no newline) leaves the literal unbalanced.
    expect(bad('export const meta = { name: "x" // eof comment').code).toBe('SCRIPT_PARSE')
  })

  it('rejects a literal referencing variables or calls (META_INVALID via the empty realm)', () => {
    const error = bad('export const meta = { name: someVariable, description: "d" }\nreturn 1')
    expect(error.code).toBe('META_INVALID')
    expect(error.message).toContain('pure literal')
    expect(bad('export const meta = { name: compute(), description: "d" }').code).toBe('META_INVALID')
  })

  it('rejects a literal evaluating to non-JSON data (META_INVALID via materialization)', () => {
    const error = bad('export const meta = { name: "x", description: "d", phases: [{ get title() { return "t" } }] }')
    expect(error.code).toBe('META_INVALID')
    expect(error.message).toContain('JSON data')
  })

  it('rejects shape violations with EVERY violation listed (META_INVALID)', () => {
    const error = bad('export const meta = { description: 7, bogus: 1 }\nreturn 1')
    expect(error.code).toBe('META_INVALID')
    expect(error.message).toContain('meta.name must be a non-empty string')
    expect(error.message).toContain('meta.description must be a non-empty string')
    expect(error.message).toContain('meta.bogus is not a recognized field')
  })

  it('rejects malformed whenToUse and phases shapes precisely', () => {
    expect(bad('export const meta = { name: "x", description: "d", whenToUse: 3 }').message)
      .toContain('meta.whenToUse must be a string')
    expect(bad('export const meta = { name: "x", description: "d", phases: "no" }').message)
      .toContain('meta.phases must be an array')
    expect(bad('export const meta = { name: "x", description: "d", phases: [3] }').message)
      .toContain('meta.phases[0] must be an object')
    expect(bad('export const meta = { name: "x", description: "d", phases: [{}] }').message)
      .toContain('meta.phases[0].title must be a non-empty string')
    expect(bad('export const meta = { name: "x", description: "d", phases: [{ title: "t", extra: 1 }] }').message)
      .toContain('meta.phases[0].extra is not a recognized field')
    expect(bad('export const meta = { name: "x", description: "d", phases: [{ title: "t", detail: 1 }] }').message)
      .toContain('meta.phases[0].detail must be a string')
    expect(bad('export const meta = { name: "x", description: "d", phases: [{ title: "t", model: 1 }] }').message)
      .toContain('meta.phases[0].model must be a string')
  })

  it('stops scanning at the balanced literal — trailing expression text stays in the body', () => {
    // The scanner extracts exactly `{ valueOf: null }`; the ` && 3` is body
    // text (which would fail compilation later, but extraction sees only the
    // literal and reports its unknown field).
    expect(bad('export const meta = { valueOf: null } && 3').message)
      .toContain('meta.valueOf is not a recognized field')
  })
})
