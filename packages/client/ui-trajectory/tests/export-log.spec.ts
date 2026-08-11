// @vitest-environment node
/**
 * Session-log export filename derivation. The archive itself is produced and
 * streamed by the host (GET /api/session.export); this package only derives
 * the download filename and triggers the browser save.
 */

import { describe, expect, it } from 'vitest'
import { sessionLogZipFilename } from '../src/client/export-log.ts'

describe('sessionLogZipFilename', () => {
  it('keeps safe session ids verbatim', () => {
    expect(sessionLogZipFilename('session-abc_1-2')).toBe('dsh-session-session-abc_1-2.zip')
  })

  it('neutralizes unsafe id characters that could shape the filename', () => {
    expect(sessionLogZipFilename('../evil')).toBe('dsh-session-___evil.zip')
    expect(sessionLogZipFilename('a/b')).toBe('dsh-session-a_b.zip')
  })

  it('strips dots so a dot-only id cannot shape a dot segment', () => {
    expect(sessionLogZipFilename('..')).toBe('dsh-session-__.zip')
  })
})
