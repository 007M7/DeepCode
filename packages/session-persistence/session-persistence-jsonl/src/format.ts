/**
 * On-disk format helpers for the JSONL session-persistence backend: path
 * sanitization (a {@link SessionId} is an unvalidated branded string, so it
 * MUST be encoded before use in a path — no traversal, no collision), the
 * per-cwd directory layout, header-line (de)serialization, and the
 * truncation-repair offset computation.
 *
 * @module dsh-session-persistence-jsonl/format
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/**
 * The first line of a session's `.jsonl` file: the immutable
 * {@link SessionHeader} tagged as a `session` record so a reader can tell it
 * apart from an event line.
 */
export interface HeaderLine {
  type: 'session'
  version: number
  id: SessionId
  createdAt: number
  cwd?: string
  parentSession?: SessionId
  seedLength?: number
}

/** Build the header line object from a {@link SessionHeader}. */
export function toHeaderLine(header: SessionHeader): HeaderLine {
  return {
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
    ...header.seedLength !== undefined ? { seedLength: header.seedLength } : {},
  }
}

/** Parse a header line back into a {@link SessionHeader}. */
export function fromHeaderLine(line: HeaderLine): SessionHeader {
  return {
    version: line.version,
    id: line.id,
    createdAt: line.createdAt,
    ...line.cwd !== undefined ? { cwd: line.cwd } : {},
    ...line.parentSession !== undefined ? { parentSession: line.parentSession } : {},
    ...line.seedLength !== undefined ? { seedLength: line.seedLength } : {},
  }
}

/** Type guard: a parsed first line is a well-formed session header. */
function isHeaderLine(value: unknown): value is HeaderLine {
  return (
    typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'session'
    && typeof (value as { version?: unknown }).version === 'number'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { createdAt?: unknown }).createdAt === 'number'
  )
}

/**
 * Encode an arbitrary string as a single safe path segment, injectively over
 * ALL JS (UTF-16) strings — including lone surrogates. A {@link SessionId} is
 * an unvalidated branded string, so this neutralizes `../`, absolute paths,
 * NUL, and separators before any filesystem use.
 *
 * Each UTF-16 code unit is either kept literal (the safe set `[A-Za-z0-9_-]`)
 * or escaped as `~XXXX` (its 4-hex-digit code unit). `~` is itself escaped, so
 * the mapping is injective and reversible: distinct inputs never collide. We
 * iterate code UNITS (`charCodeAt`), not code points, so a lone surrogate
 * escapes to a distinct `~XXXX` instead of being normalized to U+FFFD (which
 * `Buffer.from(…, 'utf8')` would do, breaking injectivity). `.` is in the safe
 * set for readability but the whole-segment tokens `.`/`..` are escaped so they
 * can never traverse.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * The directory a session's files live in: the configured root, then a per-cwd
 * subdirectory so sessions group by project. The cwd subdir is a stable hash
 * (short, collision-resistant, filesystem-safe) plus an encoded suffix for
 * readability; sessions without a cwd go in a shared `_no-cwd` bucket.
 */
export function sessionDir(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return join(root, '_no-cwd')
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(root, `cwd-${hash}`)
}

/** The append-only event-log file path for a session. */
export function logPath(root: string, cwd: string | undefined, id: SessionId): string {
  return join(sessionDir(root, cwd), `${encodeSegment(id)}.jsonl`)
}

/** Serialize one event as a JSONL line (no trailing newline). */
export function eventLine(event: SessionEvent): string {
  return JSON.stringify(event)
}

/**
 * Parse a JSONL log buffer into its preserved event prefix (the header is line
 * 0). Returns the longest prefix of complete, seq-contiguous events plus the
 * byte offset of the end of the last preserved line (`committedBytes`).
 *
 * A crash can leave a durable log whose final turn never closed: real,
 * fully-written events sit after the last `turn/end`. Those are PRESERVED (a
 * single turn can be huge in a long-horizon task — truncating it would destroy
 * real work); the backend closes the orphaned open turn with a synthetic
 * `turn/end {kind:'interrupted'}` on reload (the session-persistence RFC). Only a TORN trailing
 * fragment — a final line never fully flushed (no newline, unparseable, or a
 * seq gap) — is excluded; it bounds the preserved region. A parse error or seq
 * gap AT OR BEFORE the last committed `turn/end` is committed-data corruption
 * and makes the session unloadable (throws).
 *
 * This relies on the session-log invariant that every event lives inside a turn
 * (`Session.append` enforces it): only the final turn can be open, so the
 * preserved tail is at most one unclosed turn.
 */
export function scanLog(buffer: Buffer): { meta: SessionHeader; events: SessionEvent[]; committedBytes: number } {
  const text = buffer.toString('utf8')
  // Split into complete (newline-terminated) lines, tracking the byte offset of
  // each line's end so the truncation point is exact (multi-byte chars make the
  // char offset differ from the byte offset). A trailing line with no newline is
  // an uncommitted crash fragment and is ignored — it is below the last
  // turn/end by construction (the loop only flushes whole lines).
  //
  // Track the byte offset with a RUNNING accumulator (`endByte`), adding each
  // line's byte length as we go. Recomputing `Buffer.byteLength(text.slice(0, i))`
  // per newline would rescan the whole prefix every time — O(n²) over a long
  // log (one assistant/chunk line per token makes that pathological).
  const lines: { text: string; endByte: number }[] = []
  let start = 0
  let byteOffset = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      const lineText = text.slice(start, i)
      byteOffset += Buffer.byteLength(lineText, 'utf8') + 1 // +1 for the '\n' (a 1-byte char)
      lines.push({ text: lineText, endByte: byteOffset })
      start = i + 1
    }
  }

  const [headerEntry, ...eventEntries] = lines
  if (headerEntry === undefined) throw new Error('empty or header-less session log')

  // Line 0 is the header.
  let parsedHeader: unknown
  try {
    parsedHeader = JSON.parse(headerEntry.text)
  } catch {
    throw new Error('corrupt session log: header line is not valid JSON')
  }
  if (!isHeaderLine(parsedHeader)) {
    throw new Error('corrupt session log: first line is not a session header')
  }
  const headerLine = parsedHeader

  // Find the committed region: the prefix up to and including the LAST complete
  // `turn/end` in the WHOLE log. Two passes so a crash tail after the last
  // turn/end is tolerated, but corruption/gaps AT OR BEFORE the last committed
  // turn/end make the log unloadable (committed data must never be silently
  // dropped).
  //
  // Pass 1: parse every line that parses, recording (parsedOk, seq, isTurnEnd,
  // endByte) per line index. Lines that fail to parse are holes.
  interface Parsed { ok: boolean; event?: SessionEvent; endByte: number }
  const parsed: Parsed[] = eventEntries.map((entry) => {
    try {
      return { ok: true, event: JSON.parse(entry.text) as SessionEvent, endByte: entry.endByte }
    } catch {
      return { ok: false, endByte: entry.endByte }
    }
  })

  // The last index (into eventEntries) that is a valid `turn/end` — the last
  // fully-committed boundary (the loop flushes only at turn/end).
  let lastTurnEnd = -1
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i]
    if (p?.ok && p.event?.type === 'turn/end') { lastTurnEnd = i; break }
  }

  // Walk the longest PREFIX of complete, seq-contiguous, parseable event lines
  // (line i is a parsed event with seq === i). This is the preservable region:
  // it includes any fully-written events of an interrupted final turn AFTER the
  // last turn/end — those are real, durably-written work and must NOT be
  // truncated (a single turn can be huge in a long-horizon task; the orphaned
  // open turn is closed with a synthetic turn/end on reload, not discarded —
  // the session-persistence RFC). The walk stops at the first hole (unparseable line or seq gap):
  //   - if that hole is AT OR BEFORE the last committed turn/end, committed data
  //     was damaged → the session is unloadable (throw);
  //   - if it is AFTER (or there is no committed turn/end yet), it is the
  //     tolerated crash boundary — a torn final line never fully flushed — and
  //     it simply bounds the preserved tail.
  const preserved: SessionEvent[] = []
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    if (!p?.ok || p.event === undefined) {
      if (i <= lastTurnEnd) throw new Error(`corrupt session log: unparsable committed event at line ${i + 1}`)
      break // torn tail fragment after the last turn/end — stop, tolerate
    }
    if (p.event.seq !== i) {
      if (i <= lastTurnEnd) throw new Error(`corrupt session log: seq gap in committed region at line ${i + 1} (expected ${i}, got ${p.event.seq})`)
      break // gap after the last turn/end — torn tail, stop
    }
    preserved.push(p.event)
  }

  // committedBytes = end of the last PRESERVED line (header if none): the next
  // append truncates any torn bytes past this point before writing the
  // synthetic closers + new events.
  const lastPreserved = parsed[preserved.length - 1]
  const committedBytes = preserved.length > 0 && lastPreserved ? lastPreserved.endByte : headerEntry.endByte
  return { meta: fromHeaderLine(headerLine), events: preserved, committedBytes }
}

/**
 * Parse just the header line of a log into a {@link SessionHeader}, or
 * `undefined` if it is missing/not a header. Used by `list()` to read session
 * metadata WITHOUT parsing the whole log: a session picker scales with the
 * number of sessions, not the total size of every conversation.
 */
export function parseHeaderMeta(firstLine: string): SessionHeader | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (!isHeaderLine(parsed)) return undefined
  return fromHeaderLine(parsed)
}
