/** JSON string-prefix accounting for the outer-output ledger. @module @deepseek-ai/dsh-code-runtime-worker/output-json */

import type { CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'

/** Control characters with a two-byte short JSON escape instead of `\u00XX`. */
const SHORT_ESCAPE_CODES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

/** Serialized bytes contributed by one complete Unicode code point inside JSON quotes. */
function serializedCharacterBytes(character: string): number {
  if (character.length === 2) return 4
  if (character === '"' || character === '\\') return 2
  const code = character.charCodeAt(0)
  if (code >= 0xd800 && code <= 0xdfff) return 6
  if (code < 0x20) return SHORT_ESCAPE_CODES.has(code) ? 2 : 6
  return Buffer.byteLength(character, 'utf8')
}

/**
 * Measure one JSON string without materializing its complete escaped form.
 * @param text - the candidate string.
 * @param maxBytes - largest serialized size the caller can admit.
 * @returns Exact serialized bytes, or `undefined` as soon as the cap is crossed.
 */
export function jsonStringBytesUpTo(text: string, maxBytes: number): number | undefined {
  if (maxBytes < 2) return undefined
  let bytes = 2
  for (const character of text) {
    bytes += serializedCharacterBytes(character)
    if (bytes > maxBytes) return undefined
  }
  return bytes
}

/**
 * Measure one lossless JSON value without allocating its serialized form.
 * @param value - already validated lossless JSON.
 * @param maxBytes - largest serialized size the caller can admit.
 * @returns Exact serialized bytes, or `undefined` as soon as the cap is crossed.
 */
export function jsonValueBytesUpTo(value: CodeJsonValue, maxBytes: number): number | undefined {
  if (value === null) return maxBytes >= 4 ? 4 : undefined
  if (typeof value === 'string') return jsonStringBytesUpTo(value, maxBytes)
  if (typeof value === 'number') {
    const bytes = Buffer.byteLength(String(value), 'utf8')
    return bytes <= maxBytes ? bytes : undefined
  }
  if (typeof value === 'boolean') {
    const bytes = value ? 4 : 5
    return bytes <= maxBytes ? bytes : undefined
  }

  let bytes = 2
  if (bytes > maxBytes) return undefined
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (index > 0 && ++bytes > maxBytes) return undefined
      const item = value[index]
      if (item === undefined) return undefined
      const itemBytes = jsonValueBytesUpTo(item, maxBytes - bytes)
      if (itemBytes === undefined) return undefined
      bytes += itemBytes
    }
    return bytes
  }

  let entries = 0
  for (const [key, item] of Object.entries(value)) {
    if (entries > 0 && ++bytes > maxBytes) return undefined
    const keyBytes = jsonStringBytesUpTo(key, maxBytes - bytes)
    if (keyBytes === undefined) return undefined
    bytes += keyBytes + 1
    if (bytes > maxBytes) return undefined
    const itemBytes = jsonValueBytesUpTo(item, maxBytes - bytes)
    if (itemBytes === undefined) return undefined
    bytes += itemBytes
    entries += 1
  }
  return bytes
}

/**
 * Return the longest code-point-aligned prefix whose JSON string encoding,
 * including its surrounding quotes, fits `maxBytes`.
 *
 * @param text - the candidate string.
 * @param maxBytes - serialized JSON-string bytes available.
 * @returns the fitting prefix, or an empty string when even useful content cannot fit.
 */
export function truncateJsonStringBytes(text: string, maxBytes: number): string {
  if (maxBytes < 2) return ''
  let bytes = 2
  let end = 0
  for (const character of text) {
    const cost = serializedCharacterBytes(character)
    if (bytes + cost > maxBytes) break
    bytes += cost
    end += character.length
  }
  return end === text.length ? text : text.slice(0, end)
}
