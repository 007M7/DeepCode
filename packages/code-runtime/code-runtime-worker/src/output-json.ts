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
  type Task =
    | { kind: 'value'; value: CodeJsonValue }
    | { kind: 'array'; value: CodeJsonValue[]; index: number }
    | { kind: 'object'; value: Record<string, CodeJsonValue>; keys: string[]; index: number }

  let bytes = 0
  const add = (cost: number): boolean => {
    bytes += cost
    return bytes <= maxBytes
  }
  const tasks: Task[] = [{ kind: 'value', value }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'value') {
      const current = task.value
      if (current === null) {
        if (!add(4)) return undefined
      } else if (typeof current === 'string') {
        const stringBytes = jsonStringBytesUpTo(current, maxBytes - bytes)
        if (stringBytes === undefined) return undefined
        bytes += stringBytes
      } else if (typeof current === 'number') {
        if (!add(Buffer.byteLength(String(current), 'utf8'))) return undefined
      } else if (typeof current === 'boolean') {
        if (!add(current ? 4 : 5)) return undefined
      } else if (Array.isArray(current)) {
        if (!add(2)) return undefined
        if (current.length > 0) tasks.push({ kind: 'array', value: current, index: 0 })
      } else {
        if (!add(2)) return undefined
        const keys = Object.keys(current)
        if (keys.length > 0) tasks.push({ kind: 'object', value: current, keys, index: 0 })
      }
      continue
    }

    if (task.index > 0 && !add(1)) return undefined
    if (task.kind === 'array') {
      const item = task.value[task.index]
      if (item === undefined) return undefined
      if (task.index + 1 < task.value.length) tasks.push({ ...task, index: task.index + 1 })
      tasks.push({ kind: 'value', value: item })
      continue
    }

    const key = task.keys[task.index]
    /* v8 ignore next -- an object frame is created and advanced only for an existing Object.keys entry. */
    if (key === undefined) return undefined
    const keyBytes = jsonStringBytesUpTo(key, maxBytes - bytes)
    if (keyBytes === undefined) return undefined
    if (!add(keyBytes + 1)) return undefined
    const item = task.value[key]
    if (item === undefined) return undefined
    if (task.index + 1 < task.keys.length) tasks.push({ ...task, index: task.index + 1 })
    tasks.push({ kind: 'value', value: item })
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
