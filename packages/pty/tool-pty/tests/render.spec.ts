import { describe, expect, it } from 'vitest'
import { PtySessionId } from '@deepseek-ai/dsh-pty'
import { renderList, renderRead, renderSend, renderSendRead, renderSpawn } from '@deepseek-ai/dsh-tool-pty/src/render.ts'

describe('tool-pty rendering', () => {
  it('renders spawn with and without names or MOTD', () => {
    expect(renderSpawn({ sessionId: PtySessionId('pty-1'), type: 'shell', status: { kind: 'running' }, motd: '' }))
      .toBe('started terminal session pty-1 [type: shell]\n(no startup output)')
    expect(renderSpawn({ sessionId: PtySessionId('pty-2'), name: 'main', type: 'shell', pid: 2, status: { kind: 'running' }, motd: 'ready' }))
      .toContain('pty-2 (main)')
  })

  it('renders running, exited, empty, and truncated sends', () => {
    expect(renderSend({ viewport: '', waitReason: 'timeout', sessionStatus: { kind: 'running' }, truncated: true }))
      .toBe('(no new output)\n[wait: timeout]\n[session: running]\n[output truncated]')
    expect(renderSend({ viewport: 'bye', waitReason: 'session_exit', sessionStatus: { kind: 'exited', exitCode: null, signal: 'SIGTERM' }, truncated: false }))
      .toContain('exited code=null signal=SIGTERM')
    expect(renderSend({ viewport: 'bye', waitReason: 'session_exit', sessionStatus: { kind: 'exited', exitCode: 2, signal: null }, truncated: false }))
      .toContain('exited code=2 signal=null')
    expect(renderSend({ viewport: 'bye', waitReason: 'session_exit', sessionStatus: { kind: 'exited', exitCode: null, signal: null }, truncated: false }))
      .toContain('exited code=null signal=null')
    expect(renderSendRead({ delta: '', truncated: true })).toBe('[output truncated]')
    expect(renderSendRead({ delta: 'x', truncated: true })).toBe('x\n[output truncated]')
    expect(renderSendRead({ delta: 'x\n', truncated: true })).toBe('x\n[output truncated]')
    expect(renderSendRead({ delta: 'x', truncated: false })).toBe('x')
  })

  it('renders history and every list status shape', () => {
    expect(renderRead({ text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: true }))
      .toBe('(no retained output)\n[lines: 0-0 of 0]\n[output truncated]')
    expect(renderList([])).toBe('(no terminal sessions)')
    expect(renderList([
      { sessionId: PtySessionId('pty-1'), type: 'shell', status: { kind: 'running' } },
      { sessionId: PtySessionId('pty-2'), name: 'done', type: 'shell', pid: 9, status: { kind: 'exited', exitCode: 2, signal: null } },
      { sessionId: PtySessionId('pty-3'), type: 'shell', status: { kind: 'exited', exitCode: null, signal: 'SIGTERM' } },
      { sessionId: PtySessionId('pty-4'), type: 'shell', status: { kind: 'exited', exitCode: null, signal: null } },
    ])).toBe('pty-1 [shell] running\npty-2 (done) [shell] exited code=2 signal=null pid=9\npty-3 [shell] exited code=null signal=SIGTERM\npty-4 [shell] exited code=null signal=null')
  })
})
