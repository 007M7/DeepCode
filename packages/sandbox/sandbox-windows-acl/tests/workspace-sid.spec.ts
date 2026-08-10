/**
 * workspaceWriteSid tests: the per-workspace write identity is deterministic
 * (the same canonical path always derives the same SID — the property the
 * cross-session grant reuse rests on), orphan-shaped, distinct across
 * workspaces, and byte-sensitive (the canonical path is the caller's
 * contract; an alias spelling derives a second identity, self-healing at
 * the cost of one extra tree propagation).
 */

import { describe, expect, it } from 'vitest'

import { workspaceWriteSid } from '../src/index.ts'

describe('workspaceWriteSid', () => {
  it('derives a stable orphan-shaped SID per workspace path', () => {
    const first = workspaceWriteSid('C:\\Users\\agent\\repo')
    const second = workspaceWriteSid('C:\\Users\\agent\\repo')
    expect(first).toBe(second)
    expect(first).toMatch(/^S-1-4-\d+-\d+$/u)
  })

  it('derives distinct identities for distinct workspaces', () => {
    expect(workspaceWriteSid('C:\\Users\\agent\\repo-a')).not.toBe(workspaceWriteSid('C:\\Users\\agent\\repo-b'))
  })

  it('is byte-sensitive: the canonical path is the caller\'s contract (an alias spelling derives a second identity)', () => {
    expect(workspaceWriteSid('C:\\Repo')).not.toBe(workspaceWriteSid('c:\\repo'))
    expect(workspaceWriteSid('C:\\Repo\\')).not.toBe(workspaceWriteSid('C:\\Repo'))
  })
})
