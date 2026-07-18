import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DONE, parseSse } from '../src/sse.ts'

/** Build a byte stream from string fragments (fragments = network reads). */
async function* bytes(...fragments: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  for (const fragment of fragments) {
    yield typeof fragment === 'string' ? encoder.encode(fragment) : fragment
  }
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const item of stream) out.push(item)
  return out
}

describe('parseSse', () => {
  it('parses simple events and the DONE sentinel', async () => {
    const events = await collect(parseSse(bytes('data: {"a":1}\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('handles events split across reads at arbitrary positions', async () => {
    const events = await collect(parseSse(bytes('da', 'ta: {"a"', ':1}\n', '\ndata: [DO', 'NE]\n\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('handles multi-byte UTF-8 split across reads', async () => {
    const encoded = new TextEncoder().encode('data: {"text":"日本語"}\n\ndata: [DONE]\n\n')
    // Split inside the 3-byte sequence for 日.
    const splitAt = 16
    const events = await collect(parseSse(bytes(encoded.slice(0, splitAt), encoded.slice(splitAt))))
    expect(events).toEqual(['{"text":"日本語"}', DONE])
  })

  it('tolerates CRLF line endings', async () => {
    const events = await collect(parseSse(bytes('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('joins multi-data events with newlines (SSE spec)', async () => {
    const events = await collect(parseSse(bytes('data: line1\ndata: line2\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['line1\nline2', DONE])
  })

  it('ignores comments and non-data fields', async () => {
    const events = await collect(parseSse(bytes(': keepalive\nevent: chunk\nid: 7\ndata: {"a":1}\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('skips blocks without data fields', async () => {
    const events = await collect(parseSse(bytes(': ping\n\ndata: {"a":1}\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('preserves data lines without the optional space', async () => {
    const events = await collect(parseSse(bytes('data:{"a":1}\n\ndata:[DONE]\n\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('parses several events from one read', async () => {
    const events = await collect(parseSse(bytes('data: 1\n\ndata: 2\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['1', '2', DONE])
  })

  it('flushes a final un-terminated DONE at stream end', async () => {
    const events = await collect(parseSse(bytes('data: {"a":1}\n\ndata: [DONE]')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('throws STREAM_CLOSED when the stream ends without DONE', async () => {
    await expect(collect(parseSse(bytes('data: {"a":1}\n\n')))).rejects.toThrow(LlmError)
    await expect(collect(parseSse(bytes('data: {"a":1}\n\n')))).rejects.toThrow(/without \[DONE\]/)
  })

  it('throws STREAM_CLOSED for an empty stream', async () => {
    await expect(collect(parseSse(bytes()))).rejects.toThrow(/without \[DONE\]/)
  })

  it('throws STREAM_CLOSED for a mid-event close', async () => {
    await expect(collect(parseSse(bytes('data: {"a"')))).rejects.toThrow(/without \[DONE\]/)
  })

  it('stops yielding after DONE even when more data follows', async () => {
    const events = await collect(parseSse(bytes('data: [DONE]\n\ndata: {"late":1}\n\n')))
    expect(events).toEqual([DONE])
  })
})

describe('parseSse edge branches', () => {
  it('handles a lone CR-terminated data line', async () => {
    // Exercises the \r-strip branch on a line that is ONLY "data:…\r".
    const events = await collect(parseSse(bytes('data: {"a":1}\r\n\r\ndata:[DONE]\r\n\r\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('strips CR from non-data field lines too', async () => {
    const events = await collect(parseSse(bytes('event: chunk\r\ndata: {"a":1}\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('treats bare "data:" lines as empty payload entries', async () => {
    const events = await collect(parseSse(bytes('data:\ndata: x\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['\nx', DONE])
  })
})
