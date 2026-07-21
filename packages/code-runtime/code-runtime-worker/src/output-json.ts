/** JSON string-prefix accounting for the outer-output ledger. @module @deepseek-ai/dsh-code-runtime-worker/output-json */

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
 * Return the longest code-point-aligned prefix whose JSON string encoding,
 * including its surrounding quotes, fits `maxBytes`.
 *
 * @param text - the candidate string.
 * @param maxBytes - serialized JSON-string bytes available.
 * @returns the fitting prefix, or an empty string when even useful content cannot fit.
 */
export function truncateJsonStringBytes(text: string, maxBytes: number): string {
  if (maxBytes < 2) return ''
  if (Buffer.byteLength(JSON.stringify(text), 'utf8') <= maxBytes) return text
  let bytes = 2
  let end = 0
  for (const character of text) {
    const cost = serializedCharacterBytes(character)
    if (bytes + cost > maxBytes) break
    bytes += cost
    end += character.length
  }
  return text.slice(0, end)
}
