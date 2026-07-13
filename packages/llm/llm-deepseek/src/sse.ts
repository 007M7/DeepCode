/**
 * Minimal SSE (text/event-stream) parser for the chat-completions stream.
 *
 * Yields each event's `data:` payload as a string, ending with the literal
 * `'[DONE]'` sentinel so the consumer owns end-of-stream flushing. A stream
 * that closes WITHOUT `[DONE]` is a protocol violation → `LlmError`.
 *
 * Handles the wire realities: payloads split across network reads at
 * arbitrary byte positions (including mid-UTF-8), CRLF line endings,
 * multi-`data:` events (joined with newlines per the SSE spec), comment
 * lines, and non-data fields (ignored).
 *
 * @module dsh-llm-deepseek/sse
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal payload DeepSeek (and OpenAI) send after the last chunk. */
export const DONE = '[DONE]'

/** Extract the joined data payload from one raw SSE event block. */
function eventData(block: string): string | undefined {
  const data: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('data:')) {
      // The spec strips ONE leading space after the colon.
      data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5))
    }
    // Comments (':…') and other fields (event:, id:, retry:) are ignored.
  }
  if (data.length === 0) return undefined
  return data.join('\n')
}

/**
 * Parse a byte stream into SSE data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it (truncated response — the model call cannot be trusted).
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const bytes of stream) {
    buffer += decoder.decode(bytes, { stream: true })
    // Events are separated by a blank line (\n\n; tolerate \r\n\r\n via the
    // per-line \r strip in eventData and a normalized split here).
    let boundary: number
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const matched = /\r?\n\r?\n/.exec(buffer.slice(boundary))
      const block = buffer.slice(0, boundary)
      // matched cannot be null: search() just found the same pattern at 0.
      buffer = buffer.slice(boundary + (matched as RegExpExecArray)[0].length)
      const data = eventData(block)
      if (data === undefined) continue
      yield data
      if (data === DONE) return
    }
  }

  // Flush any final un-terminated event (servers usually end with \n\n, but
  // a trailing block without one is still parseable).
  buffer += decoder.decode()
  const data = eventData(buffer)
  if (data !== undefined) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
