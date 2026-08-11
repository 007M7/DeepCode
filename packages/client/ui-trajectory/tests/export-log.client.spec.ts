// @vitest-environment jsdom
/**
 * Session-log export browser delivery: safe filename derivation and a native
 * download handoff that leaves the streamed response outside JavaScript.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadSessionLog, sessionLogZipFilename } from '../src/client/export-log.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

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

describe('downloadSessionLog', () => {
  it('hands the descendant-inclusive endpoint directly to the browser', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await downloadSessionLog('session/with spaces')

    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.contexts[0] as HTMLAnchorElement
    const url = new URL(anchor.href)
    expect(url.pathname).toBe('/api/session.export')
    expect(url.searchParams.get('sessionId')).toBe('session/with spaces')
    expect(url.searchParams.get('includeDescendants')).toBe('true')
    expect(anchor.download).toBe('dsh-session-session_with_spaces.zip')
  })

  it('rejects when the browser download handoff fails', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('download denied')
    })

    await expect(downloadSessionLog('session-root')).rejects.toThrow('download denied')
  })
})
