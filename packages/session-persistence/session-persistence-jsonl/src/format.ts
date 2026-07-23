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
import { decodeStorageRecord, packChunkRuns } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, StorageRecord } from '@deepseek-ai/dsh-session'

/** Physical encoding selected for JSONL session artifacts. */
export type JsonlCompression = 'zstd' | 'none'

/**
 * Return the artifact suffix for one physical encoding.
 * @param compression - configured JSONL artifact encoding.
 * @returns `.jsonl.zstd` for Zstandard or `.jsonl` for plaintext.
 */
export function logSuffix(compression: JsonlCompression): '.jsonl.zstd' | '.jsonl' {
  return compression === 'zstd' ? '.jsonl.zstd' : '.jsonl'
}

/**
 * The first JSONL record of a session artifact: the immutable
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
  delegationDepth: number
}

/**
 * Build the header line object from a {@link SessionHeader}.
 * @param header - the immutable session metadata to serialize.
 * @returns the `type: 'session'`-tagged line object, absent optional fields omitted (never null).
 */
export function toHeaderLine(header: SessionHeader): HeaderLine {
  return {
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
    ...header.seedLength !== undefined ? { seedLength: header.seedLength } : {},
    delegationDepth: header.delegationDepth ?? 0,
  }
}

/**
 * Parse a header line back into a {@link SessionHeader}.
 * @param line - the shape-checked first line of a log (see the `isHeaderLine` guard).
 * @returns the header, absent optional fields omitted.
 */
export function fromHeaderLine(line: HeaderLine): SessionHeader {
  return {
    version: line.version,
    id: line.id,
    createdAt: line.createdAt,
    ...line.cwd !== undefined ? { cwd: line.cwd } : {},
    ...line.parentSession !== undefined ? { parentSession: line.parentSession } : {},
    ...line.seedLength !== undefined ? { seedLength: line.seedLength } : {},
    delegationDepth: line.delegationDepth,
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
    && typeof (value as { delegationDepth?: unknown }).delegationDepth === 'number'
    && Number.isSafeInteger((value as { delegationDepth: number }).delegationDepth)
    && (value as { delegationDepth: number }).delegationDepth >= 0
    && !Object.is((value as { delegationDepth: number }).delegationDepth, -0)
  )
}

/**
 * Encode an arbitrary string as a single safe path segment, injectively over ALL JS (UTF-16)
 * strings — including lone surrogates. A {@link SessionId} is an unvalidated branded string,
 * so this neutralizes `../`, absolute paths, NUL, and separators before any filesystem use.
 * Safe code units remain literal; every other unit, including `~`, becomes
 * `~XXXX`. Operating on code units preserves lone surrogates, while special-
 * casing `.` and `..` prevents traversal by an otherwise safe whole segment.
 *
 * @param raw - the string to encode; must be non-empty (throws on `''`).
 * @returns the escaped single path segment, decodable back to `raw`.
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
 * subdirectory so sessions group by project. The cwd subdir is a stable hash of
 * the cwd (short, collision-resistant, filesystem-safe); sessions without a
 * cwd go in a shared `_no-cwd` bucket.
 * @param root - the backend's session root directory.
 * @param cwd - the session's project directory; `undefined` selects the shared `_no-cwd` bucket.
 * @returns the per-cwd bucket directory path under `root`.
 */
export function sessionDir(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return join(root, '_no-cwd')
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(root, `cwd-${hash}`)
}

/**
 * The append-only event-log file path for a session.
 * @param root - the backend's session root directory.
 * @param cwd - the session's project directory (picks the per-cwd bucket; `undefined` → `_no-cwd`).
 * @param id - the session id, path-encoded via {@link encodeSegment} before filesystem use.
 * @param compression - physical artifact encoding and filename suffix.
 * @returns the session's configured JSONL artifact path.
 */
export function logPath(
  root: string,
  cwd: string | undefined,
  id: SessionId,
  compression: JsonlCompression,
): string {
  return join(sessionDir(root, cwd), `${encodeSegment(id)}${logSuffix(compression)}`)
}

/**
 * Serialize an event batch as JSONL lines (no trailing newline). With
 * `packChunks` on, delta-chunk runs pack into `text-chunks` /
 * `reasoning-chunks` / `tool-call-chunks` storage rows; off writes one event
 * per line, byte-identical to the pre-packing layout. Reading is layout-blind
 * either way ({@link scanLog} always decodes rows), so the switch only shapes
 * NEW bytes.
 * @param events - the batch to serialize, in log order.
 * @param packChunks - whether to pack delta runs into storage rows.
 * @returns the batch's JSONL text; the writer adds the final newline.
 */
export function eventLines(events: readonly SessionEvent[], packChunks: boolean): string {
  const records: readonly StorageRecord[] = packChunks ? packChunkRuns(events) : events
  return records.map(record => JSON.stringify(record)).join('\n')
}

/**
 * Parse a JSONL log buffer into its preserved event prefix (the header is line
 * 0). Event lines pass through verbatim; packed chunk rows expand back into
 * their events, so callers see one contiguous event list regardless of layout.
 * Fully written events in an interrupted final turn remain part of the
 * prefix. The first unparsable record or seq gap after the last `turn/end`
 * marks a tolerated torn tail; the same hole in the committed region rejects.
 *
 * @param buffer - the raw bytes of the log file (header line first).
 * @returns the header, the preserved event prefix, and `committedBytes` — the
 *   byte offset the next append truncates any torn tail to.
 */
export function scanLog(buffer: Buffer): { meta: SessionHeader; events: SessionEvent[]; committedBytes: number } {
  const text = buffer.toString('utf8')
  // Track complete lines by byte offset: a non-newline tail is torn and ignored,
  // and a running counter avoids rescanning a long multi-byte log.
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

  // Parse and decode every complete line first so the last valid `turn/end`
  // determines whether an earlier hole is committed corruption or an
  // uncommitted tail. One line yields one event, or a whole run for a packed
  // chunk row; a row-tagged line that fails row validation is a hole, exactly
  // like unparsable JSON.
  interface Parsed { ok: boolean; events?: SessionEvent[]; endByte: number }
  const parsed: Parsed[] = eventEntries.map((entry) => {
    try {
      return { ok: true, events: decodeStorageRecord(JSON.parse(entry.text)), endByte: entry.endByte }
    } catch {
      return { ok: false, endByte: entry.endByte }
    }
  })

  // The last index (into eventEntries) that ends in a valid `turn/end` — the
  // last fully-committed boundary (the loop flushes only at turn/end). A packed
  // row never stores a turn/end, so only single-event lines can match.
  let lastTurnEnd = -1
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i]
    if (p?.ok && p.events?.some(e => e.type === 'turn/end')) { lastTurnEnd = i; break }
  }

  // Preserve the contiguous prefix, including a complete interrupted turn;
  // holes through the last committed boundary throw, while later holes stop.
  // Contiguity is a cursor over seqs (not the line index): a packed row
  // advances the cursor by its whole run.
  const preserved: SessionEvent[] = []
  let lastPreservedLine = -1
  scan: for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    if (!p?.ok || p.events === undefined) {
      if (i <= lastTurnEnd) throw new Error(`corrupt session log: unparsable committed event at line ${i + 1}`)
      break // torn tail fragment after the last turn/end — stop, tolerate
    }
    for (const event of p.events) {
      if (event.seq !== preserved.length) {
        if (i <= lastTurnEnd) {
          throw new Error(`corrupt session log: seq gap in committed region at line ${i + 1} (expected ${preserved.length}, got ${event.seq})`)
        }
        break scan // gap after the last turn/end — torn tail, stop
      }
      preserved.push(event)
    }
    lastPreservedLine = i
  }

  // committedBytes = end of the last FULLY preserved line (header if none): the
  // next append truncates any torn bytes past this point before writing the
  // synthetic closers + new events. A line is preserved whole or not at all —
  // a mid-row seq gap discards the whole row, keeping the truncation offset on
  // a line boundary.
  const lastPreserved = parsed[lastPreservedLine]
  const committedBytes = lastPreserved !== undefined ? lastPreserved.endByte : headerEntry.endByte
  return { meta: fromHeaderLine(headerLine), events: preserved, committedBytes }
}

/**
 * Parse just the header line of a log into a {@link SessionHeader}, or
 * `undefined` if it is missing/not a header. Used by `list()` to read session
 * metadata WITHOUT parsing the whole log: a session picker scales with the
 * number of sessions, not the total size of every conversation.
 * @param firstLine - the first line of a log file (without its trailing newline).
 * @returns the parsed header, or `undefined` when the line is not a well-formed session header.
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
