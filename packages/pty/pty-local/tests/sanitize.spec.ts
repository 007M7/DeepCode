import { describe, expect, it } from 'vitest'
import { normalizeTerminalText, TerminalSanitizer } from '@deepseek-ai/dsh-pty-local/src/sanitize.ts'

describe('TerminalSanitizer', () => {
  it('removes split CSI and owned OSC prompt markers', () => {
    const sanitizer = new TerminalSanitizer()
    expect(sanitizer.push('red\x1b[3')).toEqual({ text: 'red', prompt: false })
    expect(sanitizer.push('1m text\x1b[0m\r\n')).toEqual({ text: ' text\n', prompt: false })
    expect(sanitizer.push('\x1b]133;')).toEqual({ text: '', prompt: false })
    expect(sanitizer.push('D;0\x07dsh> ')).toEqual({ text: 'dsh> ', prompt: true })
  })

  it('drops unrelated OSC, short escapes, BEL, and incomplete trailing escape', () => {
    const sanitizer = new TerminalSanitizer()
    expect(sanitizer.push('a\x1b]0;title\x1b\\b\x1b7c\x07')).toEqual({ text: 'abc', prompt: false })
    expect(sanitizer.push('tail\x1b')).toEqual({ text: 'tail', prompt: false })
    expect(sanitizer.flush()).toBe('')
    expect(sanitizer.flush()).toBe('')
    expect(sanitizer.push('\x1b]0;one\x07middle\x1b\\')).toEqual({ text: 'middle', prompt: false })
    expect(sanitizer.push('\x1b]0;one\x1b\\middle\x07')).toEqual({ text: 'middle', prompt: false })
    expect(sanitizer.push('\x1b]0;title\x1b\\')).toEqual({ text: '', prompt: false })
  })

  it('normalizes CRLF and standalone carriage returns', () => {
    expect(normalizeTerminalText('a\r\nb\rc\x07')).toBe('a\nb\nc')
  })
})
