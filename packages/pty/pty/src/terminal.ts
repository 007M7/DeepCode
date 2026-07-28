/** Backend-neutral line-oriented terminal buffering and control-sequence sanitization. */

import { Buffer } from 'node:buffer'
import { constants } from 'node:os'
import type { PtySendRead } from './types.ts'

/** OSC marker emitted by a controlled bash before each prompt. */
export const PTY_PROMPT_MARKER_PREFIX = '133;D;'

/** One sanitized chunk plus whether it contained the controlled prompt marker. */
export interface PtySanitizedChunk {
  /** Printable, line-normalized terminal text. */
  text: string
  /** Whether the chunk completed the controlled prompt marker. */
  prompt: boolean
  /** Present when printable text followed the latest controlled prompt marker. */
  promptText?: true
}

/**
 * Return the largest code-point-aligned UTF-8 tail within a byte cap.
 * @param text - Candidate terminal text.
 * @param maxBytes - Maximum retained UTF-8 bytes.
 * @returns The retained tail and whether its head was dropped.
 */
export function ptyUtf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

/** UTF-8 and optionally line-bounded terminal text buffer. */
export class PtyTextBuffer {
  private value = ''
  private dropped = false

  /**
   * @param maxBytes - Maximum retained UTF-8 bytes.
   * @param maxLines - Optional maximum retained logical lines.
   */
  constructor(
    private readonly maxBytes: number,
    private readonly maxLines?: number,
  ) {}

  /**
   * Append terminal text and drop the oldest excess.
   * @param text - Decoded and sanitized terminal text.
   */
  append(text: string): void {
    if (text.length === 0) return
    this.value += text
    if (this.maxLines !== undefined) {
      const lines = this.value.split('\n')
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join('\n')
        this.dropped = true
      }
    }
    const tail = ptyUtf8Tail(this.value, this.maxBytes)
    this.value = tail.text
    this.dropped ||= tail.truncated
  }

  /**
   * Consume all currently retained operation text.
   * @returns The delta and whether older text was dropped.
   */
  consume(): PtySendRead {
    const delta = this.value
    const truncated = this.dropped
    this.value = ''
    this.dropped = false
    return { delta, truncated }
  }

  /**
   * Return the retained text without consuming it.
   * @returns The retained text and whether its head was dropped.
   */
  snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.dropped }
  }
}

/**
 * Streaming terminal-control sanitizer for line-oriented PTY backends.
 * Full terminal emulation is deliberately outside the PTY seam.
 */
export class PtyTerminalSanitizer {
  private pending = ''
  private discardMode: 'osc' | 'csi' | undefined
  private discardOscEscape = false
  private trailingCarriageReturn = false
  private awaitingPromptText = false

  /** @param maxPendingBytes - Bound for an incomplete terminal-control sequence. */
  constructor(private readonly maxPendingBytes: number) {}

  /**
   * Consume one decoded PTY data chunk.
   * @param chunk - Decoded terminal data.
   * @returns Printable text and prompt-marker facts.
   */
  push(chunk: string): PtySanitizedChunk {
    this.pending += this.discardPrefix(chunk)
    let text = ''
    let prompt = false
    let promptText = false
    let index = 0
    const appendText = (value: string): boolean => {
      text += value
      if (this.awaitingPromptText && value.replace(/[\r\n\x07]/g, '').length > 0) {
        this.awaitingPromptText = false
        return true
      }
      return false
    }
    while (index < this.pending.length) {
      const escape = this.pending.indexOf('\x1b', index)
      if (escape < 0) {
        promptText = appendText(this.pending.slice(index)) || promptText
        index = this.pending.length
        break
      }
      promptText = appendText(this.pending.slice(index, escape)) || promptText
      if (escape + 1 >= this.pending.length) {
        index = escape
        break
      }
      const kind = this.pending[escape + 1]
      if (kind === ']') {
        const bel = this.pending.indexOf('\x07', escape + 2)
        const stringTerminator = this.pending.indexOf('\x1b\\', escape + 2)
        let end = -1
        if (bel >= 0 && stringTerminator >= 0) end = Math.min(bel + 1, stringTerminator + 2)
        else if (bel >= 0) end = bel + 1
        else if (stringTerminator >= 0) end = stringTerminator + 2
        if (end < 0) {
          index = escape
          break
        }
        const terminatorBytes = this.pending[end - 1] === '\x07' ? 1 : 2
        const content = this.pending.slice(escape + 2, end - terminatorBytes)
        if (content.startsWith(PTY_PROMPT_MARKER_PREFIX)) {
          prompt = true
          promptText = false
          this.awaitingPromptText = true
        }
        index = end
        continue
      }
      if (kind === '[') {
        let end = escape + 2
        while (end < this.pending.length) {
          const code = this.pending.charCodeAt(end)
          if (code >= 0x40 && code <= 0x7e) break
          end += 1
        }
        if (end >= this.pending.length) {
          index = escape
          break
        }
        index = end + 1
        continue
      }
      index = escape + 2
    }
    this.pending = this.pending.slice(index)
    this.enforcePendingBound()
    return { text: this.normalizeText(text), prompt, ...promptText ? { promptText: true } : {} }
  }

  /**
   * Flush printable trailing data and discard incomplete controls.
   * @returns Remaining normalized printable text.
   */
  flush(): string {
    const text = this.pending.startsWith('\x1b') ? '' : this.pending
    this.pending = ''
    this.discardMode = undefined
    this.discardOscEscape = false
    this.awaitingPromptText = false
    const normalized = this.normalizeText(text)
    if (!this.trailingCarriageReturn) return normalized
    this.trailingCarriageReturn = false
    return `${normalized}\n`
  }

  private normalizeText(text: string): string {
    let complete = this.trailingCarriageReturn ? `\r${text}` : text
    this.trailingCarriageReturn = false
    if (complete.endsWith('\r')) {
      complete = complete.slice(0, -1)
      this.trailingCarriageReturn = true
    }
    return normalizePtyTerminalText(complete)
  }

  private enforcePendingBound(): void {
    if (Buffer.byteLength(this.pending) <= this.maxPendingBytes) return
    this.discardMode = this.pending[1] === ']' ? 'osc' : 'csi'
    this.pending = ''
  }

  private discardPrefix(chunk: string): string {
    if (this.discardMode === undefined) return chunk
    if (this.discardMode === 'csi') {
      for (let index = 0; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) {
          this.discardMode = undefined
          return chunk.slice(index + 1)
        }
      }
      return ''
    }

    let index = 0
    if (this.discardOscEscape) {
      this.discardOscEscape = false
      if (chunk.startsWith('\\')) {
        this.discardMode = undefined
        return chunk.slice(1)
      }
    }
    while (index < chunk.length) {
      if (chunk[index] === '\x07') {
        this.discardMode = undefined
        return chunk.slice(index + 1)
      }
      if (chunk[index] === '\x1b') {
        if (chunk[index + 1] === '\\') {
          this.discardMode = undefined
          return chunk.slice(index + 2)
        }
        if (index + 1 === chunk.length) this.discardOscEscape = true
      }
      index += 1
    }
    return ''
  }
}

/**
 * Normalize CRLF and standalone carriage returns for line-oriented rendering.
 * @param text - Sanitized terminal text.
 * @returns Line-normalized text with BEL removed.
 */
export function normalizePtyTerminalText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\x07', '')
}

/**
 * Convert a platform signal number into the seam's signal-name vocabulary.
 * @param number - Platform signal number, zero, or an absent signal.
 * @returns The matching Node signal name, or `null` when unknown or absent.
 */
export function ptySignalName(number: number | undefined): NodeJS.Signals | null {
  if (number === undefined || number === 0) return null
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === number) return name as NodeJS.Signals
  }
  return null
}
