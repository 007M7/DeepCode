import { describe, expect, it } from 'vitest'
import {
  describeOmitted,
  formatRetentionNotice,
  ItemRetainer,
  type Omitted,
  type RetentionNotice,
  TextRetainer,
} from '@deepseek-ai/dsh-retention'

/** Decode a RetainedText via a round-trip helper for readable UTF-8 assertions. */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('ItemRetainer — head, stopWhenFull (glob/grep early stop)', () => {
  it('keeps the first maxItems and asks to stop on the probe item', () => {
    const r = new ItemRetainer<string>({ kind: 'head', maxItems: 2, stop: 'stopWhenFull' })
    expect(r.push('a')).toEqual({ kept: true, truncated: false, shouldStop: false })
    expect(r.push('b')).toEqual({ kept: true, truncated: false, shouldStop: false })
    // The (maxItems + 1)th valid item is the probe: not retained, sets truncated,
    // and shouldStop tells the caller to kill the upstream.
    expect(r.push('c')).toEqual({ kept: false, truncated: true, shouldStop: true })

    const result = r.finish()
    expect(result.items).toEqual(['a', 'b'])
    expect(result.kept).toBe(2)
    expect(result.seen).toBe(3)
    expect(result.truncated).toBe(true)
    // Early stop knows only a lower bound, never an exact total.
    expect(result.omitted).toEqual<Omitted>({ kind: 'atLeast', count: 1 })
  })

  it('reports none when everything fits', () => {
    const r = new ItemRetainer<number>({ kind: 'head', maxItems: 3, stop: 'stopWhenFull' })
    r.push(1)
    r.push(2)
    const result = r.finish()
    expect(result.items).toEqual([1, 2])
    expect(result.truncated).toBe(false)
    expect(result.omitted).toEqual<Omitted>({ kind: 'none' })
  })
})

describe('ItemRetainer — head, readToEnd (exact omission)', () => {
  it('keeps draining past the cap and reports an exact omitted count', () => {
    const r = new ItemRetainer<string>({ kind: 'head', maxItems: 1, stop: 'readToEnd' })
    expect(r.push('a')).toEqual({ kept: true, truncated: false, shouldStop: false })
    // readToEnd never asks to stop — the caller must keep pushing to count exactly.
    expect(r.push('b')).toEqual({ kept: false, truncated: true, shouldStop: false })
    expect(r.push('c')).toEqual({ kept: false, truncated: true, shouldStop: false })

    const result = r.finish()
    expect(result.items).toEqual(['a'])
    expect(result.seen).toBe(3)
    expect(result.omitted).toEqual<Omitted>({ kind: 'exact', count: 2 })
  })
})

describe('ItemRetainer — zero budget', () => {
  it('keeps nothing; first item is the probe under stopWhenFull', () => {
    const r = new ItemRetainer<string>({ kind: 'head', maxItems: 0, stop: 'stopWhenFull' })
    expect(r.push('a')).toEqual({ kept: false, truncated: true, shouldStop: true })
    const result = r.finish()
    expect(result.items).toEqual([])
    expect(result.kept).toBe(0)
    expect(result.omitted).toEqual<Omitted>({ kind: 'atLeast', count: 1 })
  })

  it('rejects a non-integer / negative maxItems', () => {
    expect(() => new ItemRetainer({ kind: 'head', maxItems: -1, stop: 'readToEnd' }))
      .toThrow(/maxItems must be a non-negative integer/)
    expect(() => new ItemRetainer({ kind: 'head', maxItems: 1.5, stop: 'readToEnd' }))
      .toThrow(/maxItems must be a non-negative integer/)
  })
})

describe('TextRetainer — head, stopWhenFull (early body stop)', () => {
  it('keeps the prefix and asks to stop on the overflowing chunk', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 5, stop: 'stopWhenFull' })
    expect(r.push('abc')).toEqual({ kept: true, truncated: false, shouldStop: false })
    // 'de' fills the cap exactly (5 bytes) — still fully kept.
    expect(r.push('de')).toEqual({ kept: true, truncated: false, shouldStop: false })
    // 'fgh' is wholly dropped: kept:false, and stopWhenFull → shouldStop.
    expect(r.push('fgh')).toEqual({ kept: false, truncated: true, shouldStop: true })

    const result = r.finish()
    expect(result.text).toBe('abcde')
    expect(result.truncated).toBe(true)
    // Early stop: a lower bound, not an exact size.
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'atLeast', count: 3 })
  })

  it('flags a partially-dropped chunk as not fully kept', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 4, stop: 'stopWhenFull' })
    r.push('ab')
    // 'cde' straddles the cap: 'c','d' fit, 'e' drops → kept:false, shouldStop.
    expect(r.push('cde')).toEqual({ kept: false, truncated: true, shouldStop: true })
    expect(r.finish().text).toBe('abcd')
  })
})

describe('TextRetainer — head, readToEnd (exact omission)', () => {
  it('keeps the prefix, drains the rest, and counts exactly', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 3, stop: 'readToEnd' })
    r.push('abc')
    expect(r.push('defg')).toEqual({ kept: false, truncated: true, shouldStop: false })
    const result = r.finish()
    expect(result.text).toBe('abc')
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 4 })
  })
})

describe('TextRetainer — tail (exact omission, reads to end)', () => {
  it('keeps the final maxBytes and reports exact omission', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 4 })
    // tail never asks to stop — it must read to the end to know the true suffix.
    expect(r.push('hello')).toEqual({ kept: false, truncated: true, shouldStop: false })
    r.push('world')
    const result = r.finish()
    expect(result.text).toBe('orld') // last 4 bytes of 'helloworld'
    expect(result.truncated).toBe(true)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 6 })
  })

  it('keeps everything when the stream is under the cap', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 100 })
    r.push('short')
    const result = r.finish()
    expect(result.text).toBe('short')
    expect(result.truncated).toBe(false)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'none' })
  })

  it('drops old chunks as they slide out of the tail window', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 3 })
    for (const c of ['11', '22', '33', '44']) r.push(c)
    // Only the final 3 bytes survive; earlier whole chunks are dropped.
    expect(r.finish().text).toBe('344')
  })
})

describe('TextRetainer — headTail (prefix + suffix, omit the middle)', () => {
  it('keeps a stable head and tail, omitting the middle exactly', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 3, tailBytes: 3 })
    r.push('abcdefghij') // 10 bytes: head 'abc', tail 'hij', middle 'defg' omitted
    const result = r.finish()
    expect(result.text).toBe('abchij')
    expect(result.truncated).toBe(true)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 4 })
  })

  it('does not double-count when head+tail cover the whole stream', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 3, tailBytes: 3 })
    r.push('abcdef') // exactly head(3) + tail(3), nothing omitted
    const result = r.finish()
    expect(result.text).toBe('abcdef')
    expect(result.truncated).toBe(false)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'none' })
  })
})

describe('TextRetainer — zero budgets', () => {
  it('head maxBytes 0 keeps nothing and stops on first byte (stopWhenFull)', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 0, stop: 'stopWhenFull' })
    expect(r.push('x')).toEqual({ kept: false, truncated: true, shouldStop: true })
    const result = r.finish()
    expect(result.text).toBe('')
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'atLeast', count: 1 })
  })

  it('an empty stream omits nothing', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    const result = r.finish()
    expect(result.text).toBe('')
    expect(result.truncated).toBe(false)
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'none' })
  })

  it('rejects non-integer / negative byte budgets', () => {
    expect(() => new TextRetainer({ kind: 'head', maxBytes: -1, stop: 'readToEnd' }))
      .toThrow(/maxBytes must be a non-negative integer/)
    expect(() => new TextRetainer({ kind: 'tail', maxBytes: 2.5 }))
      .toThrow(/maxBytes must be a non-negative integer/)
    expect(() => new TextRetainer({ kind: 'headTail', headBytes: -1, tailBytes: 2 }))
      .toThrow(/headBytes must be a non-negative integer/)
    expect(() => new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 1.1 }))
      .toThrow(/tailBytes must be a non-negative integer/)
  })
})

describe('TextRetainer — UTF-8 boundary handling', () => {
  it('trims a partial codepoint at the head cut instead of emitting U+FFFD', () => {
    // '€' is 3 bytes (E2 82 AC). A 2-byte head cap keeps 'a' (61) + the first
    // byte of '€' (E2); that partial lead byte must be trimmed, not decoded to
    // a replacement char.
    const r = new TextRetainer({ kind: 'head', maxBytes: 2, stop: 'readToEnd' })
    r.push('a€b') // bytes: 61 E2 82 AC 62
    const result = r.finish()
    expect(result.text).toBe('a') // partial '€' dropped, no U+FFFD
    expect(result.text).not.toContain('�')
    // Omission counts BYTES not kept by retention: 5 total − 2 prefix = 3.
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 3 })
  })

  it('trims a leading partial codepoint at the tail cut', () => {
    // Tail cap 2 over 'a€b' (5 bytes) keeps AC 62 — AC is a continuation byte
    // (the middle of '€'); the leading continuation byte is dropped so the tail
    // begins on a boundary.
    const r = new TextRetainer({ kind: 'tail', maxBytes: 2 })
    r.push('a€b')
    const result = r.finish()
    expect(result.text).toBe('b') // partial '€' at the front dropped
    expect(result.text).not.toContain('�')
  })

  it('preserves a whole multibyte codepoint that fits exactly', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 3, stop: 'readToEnd' })
    r.push('€x') // '€' is exactly 3 bytes
    expect(r.finish().text).toBe('€')
  })

  it('does not reconstruct a codepoint across the omitted middle', () => {
    // headBytes ends mid-'€' and tailBytes starts mid-another '€'; neither cut
    // may glue a valid codepoint across the gap.
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('€€€') // 9 bytes
    const result = r.finish()
    expect(result.text).not.toContain('�')
    expect(result.truncated).toBe(true)
  })

  it('accepts a raw Uint8Array chunk', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 2, stop: 'readToEnd' })
    r.push(utf8('xy'))
    r.push(utf8('z'))
    expect(r.finish().text).toBe('xy')
  })

  it('trims a partial 2-byte codepoint at the head cut', () => {
    // 'é' is 2 bytes (C3 A9). A 2-byte head cap over 'aé' keeps 'a' (61) + the
    // lead byte of 'é' (C3) — an incomplete 2-byte sequence to trim.
    const r = new TextRetainer({ kind: 'head', maxBytes: 2, stop: 'readToEnd' })
    r.push('aé') // bytes: 61 C3 A9
    const result = r.finish()
    expect(result.text).toBe('a')
    expect(result.text).not.toContain('�')
  })

  it('trims a partial 4-byte codepoint (emoji) at the head cut', () => {
    // '😀' is 4 bytes (F0 9F 98 80). A 3-byte head cap keeps 'a' + the first two
    // bytes of the emoji — an incomplete 4-byte sequence that must be trimmed.
    const r = new TextRetainer({ kind: 'head', maxBytes: 3, stop: 'readToEnd' })
    r.push('a😀') // bytes: 61 F0 9F 98 80
    const result = r.finish()
    expect(result.text).toBe('a')
    expect(result.text).not.toContain('�')
  })

  it('keeps a whole 4-byte codepoint that fits exactly', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 4, stop: 'readToEnd' })
    r.push('😀x')
    expect(r.finish().text).toBe('😀')
  })

  it('leaves a head cut ending on a stray continuation run untouched', () => {
    // A cut whose trailing bytes are ALL continuation bytes with no lead in
    // reach is not a trimmable incomplete sequence — the trimmer bails (no lead
    // byte found) and leaves them for the non-fatal decoder to replace.
    const r = new TextRetainer({ kind: 'head', maxBytes: 2, stop: 'readToEnd' })
    // 0x80 0x80 are bare continuation bytes; 'z' follows so the head keeps just
    // the two continuation bytes and the cut lands right after them.
    r.push(new Uint8Array([0x80, 0x80, 0x7a]))
    const result = r.finish()
    // The trimmer did not throw and did not eat the bytes as a partial sequence;
    // only the trailing 'z' is omitted by the 2-byte cap.
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })

  it('leaves a head cut ending on an invalid lead byte untouched', () => {
    // 0xF8 is not a valid UTF-8 lead byte (only 0x00–0xF7 lead). The trimmer
    // recognizes it as "not a lead" (expected length 0) and leaves the byte in
    // place rather than trimming a phantom partial sequence.
    const r = new TextRetainer({ kind: 'head', maxBytes: 1, stop: 'readToEnd' })
    r.push(new Uint8Array([0xf8, 0x61])) // 0xF8 kept, 'a' dropped by the 1-byte cap
    const result = r.finish()
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })
})

describe('describeOmitted — false precision safety', () => {
  it('prints an exact count for exact omission', () => {
    expect(describeOmitted({ kind: 'exact', count: 3 }, 'items')).toBe('Omitted 3 items.')
    expect(describeOmitted({ kind: 'exact', count: 12 }, 'bytes')).toBe('Omitted 12 bytes.')
  })

  it('prints NO count for atLeast (early stop) and unknown', () => {
    // The whole point of atLeast: never claim "omitted 1" when the true count is
    // unknown. Both atLeast and unknown collapse to a countless clause.
    expect(describeOmitted({ kind: 'atLeast', count: 1 }, 'items')).toBe('More items were omitted.')
    expect(describeOmitted({ kind: 'unknown' }, 'lines')).toBe('More lines were omitted.')
  })

  it('returns empty string when nothing was omitted', () => {
    expect(describeOmitted({ kind: 'none' }, 'chars')).toBe('')
  })
})

describe('formatRetentionNotice', () => {
  const notice = (omitted: Omitted): RetentionNotice => ({
    scope: 'grep',
    strategy: 'head',
    unit: 'items',
    limit: 100,
    kept: 100,
    omitted,
  })

  it('joins the standardized omission clause with the tool recovery guidance', () => {
    const out = formatRetentionNotice(
      notice({ kind: 'atLeast', count: 1 }),
      ({ kept }) => `Results capped at ${kept}. Narrow the pattern, path, or include to see more.`,
    )
    expect(out).toBe('More items were omitted. Results capped at 100. Narrow the pattern, path, or include to see more.')
  })

  it('omits the empty half when nothing was omitted', () => {
    const out = formatRetentionNotice(notice({ kind: 'none' }), () => 'Recovery text.')
    expect(out).toBe('Recovery text.')
  })

  it('omits the empty half when the tool supplies no recovery text', () => {
    const out = formatRetentionNotice(notice({ kind: 'exact', count: 2 }), () => '')
    expect(out).toBe('Omitted 2 items.')
  })

  it('passes the full notice to the recovery builder (limit as a head/tail pair)', () => {
    const headTail: RetentionNotice = {
      scope: 'bash stdout',
      strategy: 'headTail',
      unit: 'bytes',
      limit: { head: 2_000, tail: 2_000 },
      kept: 4_000,
      omitted: { kind: 'exact', count: 500 },
    }
    const out = formatRetentionNotice(headTail, n =>
      typeof n.limit === 'object' ? `Kept ${n.limit.head}B head + ${n.limit.tail}B tail.` : '')
    expect(out).toBe('Omitted 500 bytes. Kept 2000B head + 2000B tail.')
  })
})
