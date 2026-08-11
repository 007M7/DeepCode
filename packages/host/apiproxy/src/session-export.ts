/**
 * Host-side session-log download: streams one ZIP archive whose files are the
 * sessions' stored artifact text verbatim. The root artifact sits under its
 * original base name (`session.jsonl`); each subagent descendant under
 * `subagents/<id>/<filename>`. No manifest is written — every file is
 * byte-identical to the backend's durable artifact and self-describing
 * through its own header line. Compression runs on the host with fflate's
 * streaming Zip API, so the archive bytes are produced incrementally and the
 * host never holds the whole archive in one buffer; production yields to the
 * consumer whenever the response queue fills past its high-water mark, so a
 * slow consumer bounds the accumulation instead of piling up the whole
 * archive (fflate's callback is synchronous — this drain point is the only
 * backpressure available).
 * @module
 */

import { Zip, ZipDeflate } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionLineageNode, SessionQueryService } from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'

/** The services a session-log export needs (absent → the export is unavailable). */
export interface SessionLogExportDeps {
  readonly sessionQuery: SessionQueryService | undefined
  readonly sessionPersistence: SessionPersistence | undefined
}

/** The export services narrowed to the mounted ones streaming actually reads. */
export interface SessionLogExportReady {
  readonly sessionQuery: SessionQueryService
  readonly sessionPersistence: SessionPersistence
}

/**
 * Resolve the persistence and session-query services a log export needs.
 * @param ctx - the composed host context.
 * @returns the export services (absent when the deployment does not mount them).
 */
export function sessionLogExportDeps(ctx: Context): SessionLogExportDeps {
  return {
    sessionQuery: ctx.get('sessionQuery'),
    sessionPersistence: ctx.get('sessionPersistence'),
  }
}

/** One exported artifact: the stored text plus the zip path it lands at. */
export interface SessionLogZipEntry {
  /** Zip entry path (root filename verbatim; descendants under `subagents/<id>/`). */
  readonly path: string
  /** The stored artifact text verbatim. */
  readonly content: string
}

/**
 * One safe zip path segment from an untrusted session id. Session ids are
 * host-controlled, but the brand allows any non-empty string, so `../`, dot
 * segments, and separator characters are neutralized before they can shape
 * archive entries. Distinct ids may collapse onto one segment (id collision
 * is impossible for the host-minted UUIDs, so no uniqueness suffix is kept).
 * @param id - the raw session id.
 * @returns a filesystem-safe single path segment.
 */
function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * The export archive filename for one root session.
 * @param sessionId - the root session id (sanitized to one safe path segment).
 * @returns the attachment filename for the session's export archive.
 */
export function sessionLogZipFilename(sessionId: string): string {
  return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`
}

/**
 * Yield the export entries in zip order: the preloaded root artifact first,
 * then every subagent descendant in lineage order, each read from the
 * persistence backend right before it is yielded and dropped after the
 * consumer moves on (the host holds at most one descendant's artifact text at
 * a time beyond the root).
 * @param deps - the mounted export services (the caller answered 500 before this runs).
 * @param root - the already-read root artifact (read by the caller so the
 * missing-session path can answer cleanly before streaming starts).
 * @param sessionId - the root session id.
 * @param includeDescendants - whether to include every subagent descendant.
 * @param signal - optional cancellation for read work.
 * @returns the export entries in zip order.
 */
export async function* sessionLogZipEntries(
  deps: SessionLogExportReady,
  root: SessionRawArtifact,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal?: AbortSignal,
): AsyncGenerator<SessionLogZipEntry> {
  yield { path: root.filename, content: root.content }
  if (!includeDescendants) return
  const seen = new Set<SessionId>([sessionId])
  const collect = async function* (
    nodes: readonly SessionLineageNode[],
  ): AsyncGenerator<SessionLogZipEntry> {
    for (const node of nodes) {
      signal?.throwIfAborted()
      const id = node.session.header.id
      if (seen.has(id)) continue
      seen.add(id)
      const raw = await deps.sessionPersistence.readRaw(id)
      if (raw === undefined) {
        throw new Error(`subagent "${id}" has no stored log artifact`)
      }
      yield {
        path: `subagents/${safeSessionIdSegment(id)}/${raw.filename}`,
        content: raw.content,
      }
      yield* collect(node.descendants)
    }
  }
  const lineage = await deps.sessionQuery.traceSession(sessionId)
  yield* collect(lineage.descendants)
}

/** How many code units of artifact text one zip push carries (bounded encode memory). */
const PUSH_CHUNK_CODE_UNITS = 1 << 16

/**
 * Push one artifact's text into a deflate stream in bounded chunks, never
 * splitting a surrogate pair across a chunk boundary (a lone high surrogate
 * re-encodes as U+FFFD and would silently corrupt the exported artifact).
 * @param deflate - the zip entry's deflate stream.
 * @param content - the artifact text verbatim.
 * @param signal - optional cancellation; throws when aborted.
 */
async function pushArtifactChunks(
  deflate: ZipDeflate,
  content: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const encoder = new TextEncoder()
  let offset = 0
  let finalChunk: boolean
  do {
    signal?.throwIfAborted()
    let end = Math.min(offset + PUSH_CHUNK_CODE_UNITS, content.length)
    if (end < content.length && end - offset > 1) {
      // Back off one code unit when the boundary lands inside a surrogate
      // pair: the pair then starts the next chunk whole.
      const last = content.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    finalChunk = end >= content.length
    deflate.push(encoder.encode(content.slice(offset, end)), finalChunk)
    offset = end
    /* v8 ignore next 2 -- only fires when a slow consumer leaves the queue over-full */
    if (controller.desiredSize !== null && controller.desiredSize < 0) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  } while (!finalChunk)
}

/**
 * Stream one session-log ZIP as a WHATWG ReadableStream. The root artifact is
 * read and validated by the caller before this is called (missing root or
 * missing services answer cleanly before any byte is produced); each entry is
 * then encoded and deflated in bounded chunks as it is produced, so the
 * archive bytes arrive incrementally. A descendant that fails to read errors
 * the stream (fail-loud, never silent under-export).
 * @param deps - the mounted export services (the caller answered 500 before this runs).
 * @param root - the already-read root artifact (first zip entry).
 * @param sessionId - the root session id.
 * @param includeDescendants - whether to include every subagent descendant.
 * @param signal - optional cancellation for read work.
 * @returns the zip byte stream.
 */
export function streamSessionLogZip(
  deps: SessionLogExportReady,
  root: SessionRawArtifact,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // fflate invokes the callback synchronously per compressed chunk, so a
      // single push can enqueue ahead of a slow consumer; pushArtifactChunks
      // yields between chunks once the queue is over-full, bounding the
      // accumulation to the queue high-water mark plus one push.
      const zip = new Zip((error, data, final) => {
        /* v8 ignore next 3 -- fflate reports only internal zip failures, unreachable for valid inputs */
        if (error) {
          controller.error(error)
          return
        }
        /* v8 ignore next -- fflate may emit empty chunks; not controllable from tests */
        if (data.byteLength > 0) controller.enqueue(data)
        if (final) controller.close()
      })
      void (async () => {
        try {
          for await (const entry of sessionLogZipEntries(deps, root, sessionId, includeDescendants, signal)) {
            const deflate = new ZipDeflate(entry.path, { level: 6 })
            zip.add(deflate)
            await pushArtifactChunks(deflate, entry.content, controller, signal)
          }
          zip.end()
        } catch (error) {
          // A mid-stream failure (missing descendant, cancellation, read
          // error) must fail the download rather than ship a truncated archive.
          /* v8 ignore next -- typed backends reject with Error, and DOMException is one in Node */
          controller.error(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    },
  })
}
