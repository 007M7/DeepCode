/** ASCII/base64 JSON framing for byte-faithful protocols over E2B text callbacks. */

import { Buffer } from 'node:buffer'

const BASE64_LINE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Encode one JSON-compatible value as a newline-delimited ASCII frame.
 * @param value - Value accepted by `JSON.stringify`.
 * @returns Base64-encoded UTF-8 JSON followed by one newline.
 */
export function encodeE2BFrame(value: unknown): string {
  return encodeFrame(value)
}

/**
 * Encode one JSON-compatible value while enforcing the decoded frame bound.
 * @param value - Value accepted by `JSON.stringify`.
 * @param maxFrameBytes - Maximum UTF-8 JSON bytes in the encoded frame.
 * @returns Base64-encoded UTF-8 JSON followed by one newline.
 */
export function encodeBoundedE2BFrame(value: unknown, maxFrameBytes: number): string {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new Error('E2B frame maxFrameBytes must be a positive safe integer')
  }
  return encodeFrame(value, maxFrameBytes)
}

function encodeFrame(value: unknown, maxFrameBytes?: number): string {
  const json: unknown = JSON.stringify(value)
  if (typeof json !== 'string') throw new Error('E2B frame value is not JSON-serializable')
  const bytes = Buffer.from(json)
  if (maxFrameBytes !== undefined && bytes.length > maxFrameBytes) {
    throw new Error('E2B frame exceeded its byte limit')
  }
  return `${bytes.toString('base64')}\n`
}

/** Incremental decoder for newline-delimited base64 JSON frames. */
export class E2BFrameDecoder {
  private pending = ''
  private readonly maxEncodedChars: number

  /** @param maxFrameBytes - Maximum decoded UTF-8 JSON bytes in one frame. */
  constructor(private readonly maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new Error('E2B frame maxFrameBytes must be a positive safe integer')
    }
    this.maxEncodedChars = Math.ceil(maxFrameBytes / 3) * 4
  }

  /**
   * Consume one E2B callback chunk.
   * @param chunk - ASCII text received from the remote helper.
   * @returns Every complete decoded JSON value, in order.
   */
  push(chunk: string): unknown[] {
    if (/[^\x0a\x20-\x7e]/.test(chunk)) throw new Error('E2B frame stream contained non-ASCII data')
    this.pending += chunk
    const values: unknown[] = []
    for (;;) {
      const newline = this.pending.indexOf('\n')
      if (newline < 0) {
        if (this.pending.length > this.maxEncodedChars) throw new Error('E2B frame exceeded its byte limit')
        return values
      }
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      values.push(this.decode(line))
    }
  }

  /** Reject a truncated final frame. */
  finish(): void {
    if (this.pending.length !== 0) throw new Error('E2B frame stream ended mid-frame')
  }

  private decode(line: string): unknown {
    if (line.length === 0 || line.length > this.maxEncodedChars || !BASE64_LINE.test(line)) {
      throw new Error('E2B frame contained invalid base64 or exceeded its byte limit')
    }
    const bytes = Buffer.from(line, 'base64')
    if (bytes.length > this.maxFrameBytes) throw new Error('E2B frame exceeded its byte limit')
    let json: string
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error: unknown) {
      throw new Error('E2B frame contained invalid UTF-8', { cause: error })
    }
    try {
      return JSON.parse(json) as unknown
    } catch (error: unknown) {
      throw new Error('E2B frame contained invalid JSON', { cause: error })
    }
  }
}
