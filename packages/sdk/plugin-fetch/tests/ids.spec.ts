import { describe, expect, it } from 'vitest'
import { commitSha, integrity } from '../src/ids.ts'

describe('commitSha', () => {
  it('accepts abbreviated and full lowercase hex object ids', () => {
    expect(commitSha('abc1234')).toBe('abc1234')
    expect(commitSha('a'.repeat(40))).toBe('a'.repeat(40))
    expect(commitSha('0'.repeat(64))).toBe('0'.repeat(64))
  })

  it.each([
    ['too short', 'abc123'],
    ['uppercase', 'ABCDEF1'],
    ['non-hex', 'ghijklm'],
    ['too long', 'a'.repeat(65)],
    ['empty', ''],
  ])('rejects an invalid sha (%s)', (_label, value) => {
    expect(() => commitSha(value)).toThrow(/invalid commit sha/)
  })
})

describe('integrity', () => {
  it.each([
    'sha512-abcABC123+/==',
    'sha384-abcABC123+/',
    'sha256-Zm9vYmFy',
  ])('accepts a valid SRI entry (%s)', (value) => {
    expect(integrity(value)).toBe(value)
  })

  it.each([
    ['missing algorithm', 'abcABC123'],
    ['unsupported algorithm', 'sha1-abcABC123'],
    ['illegal base64 char', 'sha512-abc*def'],
    ['empty', ''],
  ])('rejects an invalid integrity (%s)', (_label, value) => {
    expect(() => integrity(value)).toThrow(/invalid subresource integrity/)
  })
})
