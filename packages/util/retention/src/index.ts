/**
 * A dependency-light **retention** library: bounded model-facing output for
 * tools that must cap how much context they return. A caller feeds items or
 * text chunks into a bounded object, gets a per-push {@link PushDecision} about
 * whether the upstream may stop, and later gets the retained content plus exact
 * or partial omission metadata ({@link RetainedItems} / {@link RetainedText}).
 *
 * The library owns ONLY the mechanical question "what did we keep, what did we
 * omit, and may the caller stop reading now?". Tool-specific code still owns
 * business semantics: file grouping, line numbering, exit codes, provider error
 * states, per-line preview truncation, spill files, and the model-facing prose.
 * In particular {@link RetainedText.truncated}/{@link RetainedItems.truncated}
 * means "the retainer omitted otherwise-available content because of a budget" —
 * NOT "the upstream was incomplete". Permission failures, skipped binaries,
 * provider partial failures, and unreadable candidates stay in tool-domain
 * fields, never folded into `truncated`.
 *
 * This is deliberately a library, not a cordis service or plugin: it takes no
 * `ctx`, registers nothing, and emits no events. The two retainers are the only
 * stateful pieces and their state is per-instance (one accumulation), never
 * cross-call. Tool packages import it directly when they need bounded output.
 *
 * The two retainers differ in resource model, which is why they are two names
 * rather than one generic collector:
 * - {@link ItemRetainer} bounds ordered logical units (paths, grep matches,
 *   search sources). `head` retention only in v1. With `stopWhenFull` it can ask
 *   the caller to stop the upstream after the first over-cap probe item.
 * - {@link TextRetainer} bounds byte-oriented text streams (bash stdout/stderr,
 *   web bodies). `head` / `tail` / `headTail`, preserving UTF-8 boundaries at
 *   {@link TextRetainer.finish}. Only `head` can stop early; `tail`/`headTail`
 *   must read to the end to know the true suffix and exact omission.
 *
 * @module @deepseek-ai/dsh-retention
 */

/**
 * How much content the retainer omitted.
 *
 * `atLeast` is the early-stop shape: an {@link ItemRetainer}/{@link TextRetainer}
 * with `stopWhenFull` sees the first unit/chunk past the cap, asks the caller to
 * stop the upstream, and therefore knows only a LOWER bound — reporting an exact
 * count there would be false precision when the true total may be much larger.
 * `exact` is the read-to-end shape (`tail`, `headTail`, or `head` with
 * `readToEnd`), where every unit/byte was observed. `unknown` is reserved for a
 * caller that omits without a count; the retainers themselves never return it.
 */
export type Omitted =
  | { kind: 'none' }
  | { kind: 'exact'; count: number }
  | { kind: 'atLeast'; count: number }
  | { kind: 'unknown' }

/**
 * The caller receives this after each `push()`.
 *
 * `shouldStop` is ADVISORY, not automatic: the tool owns how to stop its upstream
 * source — aborting an HTTP body, breaking a file scan, killing ripgrep. The
 * retainer cannot reach the upstream; it only reports that keeping more would
 * exceed the budget. A `readToEnd` / `tail` / `headTail` retainer never sets it
 * (those must drain to the end).
 */
export interface PushDecision {
  /** Was this whole unit / all of this chunk's bytes retained (nothing dropped)? */
  kept: boolean
  /** Cumulative: has the retainer omitted anything due to the budget yet? */
  truncated: boolean
  /** Advisory: keeping more would exceed the budget — the tool may stop its upstream. */
  shouldStop: boolean
}

/**
 * Final result for ordered logical units.
 *
 * `seen` means units OBSERVED by the retainer, not necessarily the total in the
 * upstream source; with an early stop, the true total is intentionally unknown
 * (hence {@link Omitted.atLeast}). `kept` is `items.length`, surfaced explicitly
 * so a notice formatter need not re-count.
 */
export interface RetainedItems<T> {
  items: T[]
  truncated: boolean
  seen: number
  kept: number
  omitted: Omitted
}

/**
 * Final result for text streams.
 *
 * The returned `text` is safe to hand to a formatter: the retainer adds no
 * tool-specific headers, exit markers, XML tags, or recovery instructions, and
 * `omittedBytes` counts BYTES (not characters or lines) — text retention is
 * byte-oriented for process/body safety. UTF-8 boundaries at each cut are
 * preserved, so `text` never carries a replacement char introduced by the cut
 * itself.
 */
export interface RetainedText {
  text: string
  truncated: boolean
  omittedBytes: Omitted
}

/**
 * Whether a retainer asks the caller to stop the upstream once keeping more
 * would exceed the budget (`stopWhenFull`), or must keep accepting input even
 * after the retained output is full (`readToEnd`) — usually to preserve a true
 * tail, count exact omission, or drain an upstream process to avoid pipe
 * backpressure. Names avoid implementation phrases like "overflow".
 */
export type StopMode = 'stopWhenFull' | 'readToEnd'

/** Item retention strategy. Only `head` in v1; windows/grouped budgets wait for a second consumer. */
export type ItemRetentionStrategy = {
  /** Keep the first `maxItems` units. Use for `glob`, `grep`, and web sources. */
  kind: 'head'
  maxItems: number
  stop: StopMode
}

/** Text retention strategy: keep a prefix, a suffix, or both, counted in bytes. */
export type TextRetentionStrategy =
  | {
    /** Keep the first `maxBytes` bytes. May stop an upstream body early. */
    kind: 'head'
    maxBytes: number
    stop: StopMode
  }
  | {
    /** Keep the final `maxBytes` bytes. Requires reading to the end. */
    kind: 'tail'
    maxBytes: number
  }
  | {
    /** Keep a stable prefix and suffix, omitting the middle. Requires reading to the end. */
    kind: 'headTail'
    headBytes: number
    tailBytes: number
  }

/**
 * A neutral, tool-agnostic description of one retention outcome — the input to
 * {@link formatRetentionNotice}. It carries the mechanical facts (strategy,
 * unit, limit, kept count, {@link Omitted}); the tool supplies the recovery
 * words, because only the tool knows the recovery action ("narrow the pattern",
 * "fetch a more specific URL", "read the spill file").
 */
export interface RetentionNotice {
  /** Tool/scope label, e.g. `grep`, `web_fetch`, `bash stdout`. */
  scope: string
  strategy: 'head' | 'tail' | 'headTail'
  unit: 'items' | 'bytes' | 'chars' | 'lines'
  limit: number | { head: number; tail: number }
  kept: number
  omitted: Omitted
}

/** Assert a budget field is a non-negative integer (the retainer request contract). */
function assertBudget(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
}

/**
 * Bounds an ordered stream of logical units, keeping the first `maxItems`
 * ({@link ItemRetentionStrategy} `head`). `push()` reports, per unit, whether it
 * was kept and — under `stopWhenFull` — whether the caller should stop the
 * upstream now that the first over-cap probe unit has been seen.
 *
 * Grouping, sorting, path mapping, per-unit preview truncation, and any
 * `incomplete` state stay OUTSIDE the retainer: it counts and keeps, nothing
 * more. The caller pushes already-shaped units and, after {@link finish},
 * groups/sorts the retained subset itself.
 */
export class ItemRetainer<T> {
  private readonly maxItems: number
  private readonly stop: StopMode
  private readonly items: T[] = []
  private seen = 0
  private omittedCount = 0

  /** @param strategy Head strategy: `maxItems` (non-negative integer) and the {@link StopMode}. */
  constructor(strategy: ItemRetentionStrategy) {
    assertBudget(strategy.maxItems, 'maxItems')
    this.maxItems = strategy.maxItems
    this.stop = strategy.stop
  }

  /**
   * Offer one unit. Kept when the retainer is below `maxItems`; otherwise dropped
   * and counted as omitted. Under `stopWhenFull` the first dropped unit is the
   * probe: `shouldStop` is `true` so the caller can kill ripgrep / cancel the
   * stream, and the final {@link Omitted} stays `atLeast` (the true total is
   * unknown). Under `readToEnd` the caller keeps pushing so omission is `exact`.
   *
   * @param item The already-shaped logical unit (path, flat match, source).
   * @returns The per-push {@link PushDecision}.
   */
  push(item: T): PushDecision {
    this.seen++
    if (this.items.length < this.maxItems) {
      // Reached only below the cap, before any omission (items only grow, the
      // cap is fixed), so nothing has been dropped yet: truncated is always false.
      this.items.push(item)
      return { kept: true, truncated: false, shouldStop: false }
    }
    this.omittedCount++
    return {
      kept: false,
      truncated: true,
      // Only ask to stop when the caller opted into it; readToEnd must keep
      // draining to reach an exact omission count.
      shouldStop: this.stop === 'stopWhenFull',
    }
  }

  /**
   * Finalize and report what was kept and omitted. `omitted` is `atLeast` under
   * `stopWhenFull` (a lower bound — the caller was asked to stop before the true
   * total was known) and `exact` under `readToEnd`.
   *
   * @returns The {@link RetainedItems} snapshot (safe to group/sort downstream).
   */
  finish(): RetainedItems<T> {
    const truncated = this.omittedCount > 0
    return {
      items: this.items,
      truncated,
      seen: this.seen,
      kept: this.items.length,
      omitted: truncated
        ? { kind: this.stop === 'stopWhenFull' ? 'atLeast' : 'exact', count: this.omittedCount }
        : { kind: 'none' },
    }
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder() // utf-8, non-fatal: internal malformed bytes → U+FFFD

/**
 * Drop a trailing incomplete UTF-8 sequence so a prefix cut never emits a
 * replacement char at the boundary. Walks back over continuation bytes
 * (`10xxxxxx`) to the lead byte; if fewer bytes follow it than the lead byte's
 * length declares, the sequence is incomplete and is trimmed. A complete tail,
 * or a run too long/short to be a valid lead, is returned untouched (any
 * genuinely malformed interior is left for the decoder to replace).
 */
function trimTrailingPartialUtf8(bytes: Uint8Array): Uint8Array {
  let i = bytes.length - 1
  // Continuation bytes are 0b10xxxxxx; scan back at most 3 (max sequence is 4).
  // Indices are bounds-checked by the loop guard, so the reads are in range (a
  // cast, not `!`, per the repo's no-non-null-assertion rule).
  while (i >= 0 && ((bytes[i] as number) & 0xc0) === 0x80 && bytes.length - i <= 3) i--
  if (i < 0) return bytes
  const lead = bytes[i] as number
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0
  // expected 0 → not a lead byte (stray continuation / invalid): leave it.
  if (expected === 0) return bytes
  return bytes.length - i < expected ? bytes.subarray(0, i) : bytes
}

/**
 * Drop leading continuation bytes (`10xxxxxx`) so a suffix cut starts on a
 * lead/ASCII byte instead of mid-codepoint.
 */
function trimLeadingContinuationUtf8(bytes: Uint8Array): Uint8Array {
  let i = 0
  // i < length guards the read; cast rather than `!` (no-non-null-assertion).
  while (i < bytes.length && ((bytes[i] as number) & 0xc0) === 0x80) i++
  return bytes.subarray(i)
}

/**
 * Bounds a byte-oriented text stream, keeping a prefix, a suffix, or both
 * ({@link TextRetentionStrategy}). All three strategies share one prefix/suffix
 * accumulator: `head` is prefix-only, `tail` is suffix-only, `headTail` is both.
 * Only `head` with `stopWhenFull` sets `shouldStop`; `tail`/`headTail` must read
 * to the end to know the true suffix and the exact omitted byte count.
 *
 * Bytes, not characters: caps and `omittedBytes` are byte counts for process/
 * body safety. Chunks that straddle a codepoint are handled — {@link finish}
 * trims a partial codepoint at each cut so the returned text never introduces a
 * replacement char at the boundary. The retainer holds at most
 * `prefixCap + tailBytes + one chunk` in memory (old suffix chunks are dropped
 * as they slide out), so a large stream does not accumulate unbounded.
 */
export class TextRetainer {
  private readonly prefixCap: number
  private readonly suffixCap: number
  private readonly allowStop: boolean
  private readonly prefixChunks: Uint8Array[] = []
  private prefixHeld = 0
  private readonly suffixChunks: Uint8Array[] = []
  private suffixHeld = 0
  private total = 0

  /** @param strategy One of the {@link TextRetentionStrategy} shapes; byte budgets must be non-negative integers. */
  constructor(strategy: TextRetentionStrategy) {
    switch (strategy.kind) {
      case 'head':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this.prefixCap = strategy.maxBytes
        this.suffixCap = 0
        this.allowStop = strategy.stop === 'stopWhenFull'
        break
      case 'tail':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this.prefixCap = 0
        this.suffixCap = strategy.maxBytes
        this.allowStop = false
        break
      case 'headTail':
        assertBudget(strategy.headBytes, 'headBytes')
        assertBudget(strategy.tailBytes, 'tailBytes')
        this.prefixCap = strategy.headBytes
        this.suffixCap = strategy.tailBytes
        this.allowStop = false
        break
    }
  }

  /**
   * Offer one chunk (a `Uint8Array`, or a `string` encoded as UTF-8). Prefix
   * bytes fill up to the prefix cap then stop; suffix bytes roll so only the
   * last `suffixCap` bytes are retained. `kept` is `true` only when no byte of
   * this chunk was dropped. Under `head` + `stopWhenFull`, `shouldStop` turns
   * `true` on the chunk that first drops a byte (the caller may then abort the
   * body); other strategies never set it.
   *
   * @param chunk The next bytes of the stream (`Uint8Array` or UTF-8 `string`).
   * @returns The per-push {@link PushDecision}.
   */
  push(chunk: Uint8Array | string): PushDecision {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    const before = this.total
    this.total += bytes.length

    // Prefix: take only up to the cap; the rest of this chunk is "not prefixed".
    const room = this.prefixCap - this.prefixHeld
    const take = Math.max(0, Math.min(room, bytes.length))
    if (take > 0) {
      this.prefixChunks.push(bytes.subarray(0, take))
      this.prefixHeld += take
    }

    // Suffix: append the whole chunk, then drop whole leading chunks that have
    // fully slid out of the last `suffixCap` bytes (bounded memory).
    if (this.suffixCap > 0) {
      this.suffixChunks.push(bytes)
      this.suffixHeld += bytes.length
      let head = this.suffixChunks[0]
      while (head !== undefined && this.suffixHeld - head.length >= this.suffixCap) {
        this.suffixChunks.shift()
        this.suffixHeld -= head.length
        head = this.suffixChunks[0]
      }
    }

    // Dropped = bytes that no side can keep. Compute cumulative omission the
    // SAME way finish() does (via omittedAt), so push and finish never disagree;
    // per-push we only need whether THIS chunk pushed the total past what the
    // two caps hold, and — for head+stopWhenFull — whether to stop.
    const droppedThisChunk = this.omittedAt(this.total) > this.omittedAt(before)
    return {
      kept: !droppedThisChunk,
      truncated: this.omittedAt(this.total) > 0,
      shouldStop: this.allowStop && droppedThisChunk,
    }
  }

  /** Bytes omitted once `total` bytes have been seen: `total − keptPrefix − keptSuffix`. */
  private omittedAt(total: number): number {
    const prefixLen = Math.min(total, this.prefixCap)
    const suffixLen = Math.min(total - prefixLen, this.suffixCap)
    return total - prefixLen - suffixLen
  }

  /**
   * Finalize: decode the retained prefix and suffix (each trimmed to a UTF-8
   * boundary at its cut) and report the exact or lower-bound omitted byte count.
   * `head` + `stopWhenFull` yields `atLeast` (a lower bound — the caller was
   * asked to stop before the true size was known); every other case reads to the
   * end and yields `exact`.
   *
   * @returns The {@link RetainedText} snapshot (safe to hand to a formatter).
   */
  finish(): RetainedText {
    const prefixLen = Math.min(this.total, this.prefixCap)
    const suffixLen = Math.min(this.total - prefixLen, this.suffixCap)

    const prefix = concat(this.prefixChunks) // exactly prefixLen bytes (prefixHeld === prefixLen)
    const suffix = concat(this.suffixChunks).subarray(this.suffixHeld - suffixLen)

    // With nothing omitted by budget, prefix and suffix are ADJACENT slices of
    // one stream (prefixLen + suffixLen === total), so the head|tail split is
    // artificial: a codepoint may span it. Decode the contiguous whole as one
    // buffer — trimming or decoding the halves separately here would corrupt a
    // boundary-spanning codepoint though no content was dropped. Only a real
    // omitted gap makes each side a true cut: trim each to a UTF-8 boundary and
    // decode separately so a codepoint is never reconstructed across the gap.
    const budgetOmitted = this.omittedAt(this.total)
    const [keptPrefix, keptSuffix] = budgetOmitted > 0
      ? [trimTrailingPartialUtf8(prefix), trimLeadingContinuationUtf8(suffix)]
      : [prefix, suffix]
    const text = budgetOmitted > 0
      ? decoder.decode(keptPrefix) + decoder.decode(keptSuffix)
      : decoder.decode(concat([prefix, suffix]))

    // Report omission against the bytes ACTUALLY returned, not the pre-trim
    // budget: a boundary trim drops partial-codepoint bytes too, so an exact
    // count derived from the budget alone would overstate the retained text (and
    // any "Omitted N bytes" notice built from it would be a lie). total_seen −
    // retained stays a valid lower bound under `atLeast` (true total ≥ seen).
    const omitted = this.total - keptPrefix.length - keptSuffix.length
    const truncated = omitted > 0

    return {
      text,
      truncated,
      omittedBytes: truncated
        ? { kind: this.allowStop ? 'atLeast' : 'exact', count: omitted }
        : { kind: 'none' },
    }
  }
}

/** Concatenate chunks into one contiguous buffer (their exact total length). */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Standardized, false-precision-safe wording for one {@link Omitted} value —
 * the "may standardize omission wording" half the library owns. `exact` prints
 * the count (`Omitted 3 items`); `atLeast`/`unknown` print NO count, because an
 * early stop knows only that more was dropped, not how much (claiming "omitted
 * 1" when the true total may be huge is the false-precision trap the `atLeast`
 * variant exists to avoid). `none` is the empty string.
 *
 * @param omitted The omission metadata from a retainer result.
 * @param unit The noun for the omitted quantity (`items`, `bytes`, `chars`, `lines`).
 * @returns A neutral clause (no trailing space), or `''` when nothing was omitted.
 */
export function describeOmitted(omitted: Omitted, unit: RetentionNotice['unit']): string {
  switch (omitted.kind) {
    case 'none':
      return ''
    case 'exact':
      return `Omitted ${omitted.count} ${unit}.`
    case 'atLeast':
    case 'unknown':
      return `More ${unit} were omitted.`
  }
}

/**
 * Turn a {@link RetentionNotice} into a one-line footer: the library-owned
 * standardized omission clause ({@link describeOmitted}) followed by the tool's
 * own recovery guidance. The library never owns recovery words — only the tool
 * knows the action ("narrow the pattern", "fetch a more specific URL", "read the
 * spill file") — so `recovery` supplies them and receives the full notice to
 * phrase from (`kept`, `limit`, `omitted`, …). Either half may be empty; the two
 * are joined with a single space.
 *
 * @param notice The neutral retention outcome.
 * @param recovery Tool-supplied guidance builder; receives the notice, returns a sentence (or `''`).
 * @returns The combined footer line.
 */
export function formatRetentionNotice(
  notice: RetentionNotice,
  recovery: (notice: RetentionNotice) => string,
): string {
  return [describeOmitted(notice.omitted, notice.unit), recovery(notice)]
    .filter(part => part.length > 0)
    .join(' ')
}
