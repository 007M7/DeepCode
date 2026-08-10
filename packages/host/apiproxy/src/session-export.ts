/**
 * Host-side session-log download: streams one ZIP archive whose files are the
 * sessions' stored artifact text verbatim. The root artifact sits under its
 * original base name (`session.jsonl`); each subagent descendant under
 * `subagents/<id>/<filename>`. No manifest is written — every file is
 * byte-identical to the backend's durable artifact and self-describing
 * through its own header line. Compression happens on the host with fflate's
 * streaming Zip API, so the response is chunked as it is produced and the
 * host never materializes the whole archive.
 * @module
 */

import { Zip, ZipDeflate } from 'fflate'
import type { Context } from 'cordis'
import type { SessionLineageNode, SessionQueryService } from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionRawArtifact } from '@deepseek-ai/dsh-session-persistence'

/** The services a session-log export needs (absent → the export is unavailable). */
export interface SessionLogExportDeps {
  readonly sessionQuery: SessionQueryService | undefined
  readonly sessionPersistence: SessionPersistence | undefined
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
 * host-controlled, but the brand allows any non-empty string, so `../` and
 * separator characters are neutralized before they can shape archive entries.
 * @param id - the raw session id.
 * @returns a filesystem-safe single path segment.
 */
function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
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
 * @param deps - the export services.
 * @param root - the already-read root artifact (read by the caller so the
 * missing-session path can answer cleanly before streaming starts).
 * @param sessionId - the root session id.
 * @param includeDescendants - whether to include every subagent descendant.
 * @param signal - optional cancellation for read work.
 * @returns the export entries in zip order.
 */
export async function* sessionLogZipEntries(
  deps: SessionLogExportDeps,
  root: SessionRawArtifact,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal?: AbortSignal,
): AsyncGenerator<SessionLogZipEntry> {
  yield { path: root.filename, content: root.content }
  if (!includeDescendants) return
  const sessionQuery = deps.sessionQuery
  const sessionPersistence = deps.sessionPersistence
  if (sessionQuery === undefined || sessionPersistence === undefined) {
    // The caller validated services before the stream started; this arm is
    // unreachable today and guards a future caller that skips the check.
    throw new Error('session log export is unavailable: missing session-query or session-persistence service')
  }
  const seen = new Set<SessionId>([sessionId])
  const collect = async function* (
    nodes: readonly SessionLineageNode[],
  ): AsyncGenerator<SessionLogZipEntry> {
    for (const node of nodes) {
      signal?.throwIfAborted()
      const id = node.session.header.id
      if (seen.has(id)) continue
      seen.add(id)
      const raw = await sessionPersistence.readRaw(id)
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
  const lineage = await sessionQuery.traceSession(sessionId)
  yield* collect(lineage.descendants)
}

/** How many code points of artifact text one zip push carries (bounded encode memory). */
const PUSH_CHUNK_CODE_POINTS = 1 << 16

/**
 * Stream one session-log ZIP as a WHATWG ReadableStream. The root artifact is
 * read and validated by the caller before this is called (missing root or
 * missing services answer cleanly before any byte is produced); each entry is
 * then encoded and deflated in bounded chunks as it is produced, so the
 * archive bytes arrive incrementally. A descendant that fails to read errors
 * the stream (fail-loud, never silent under-export).
 * @param deps - the export services.
 * @param root - the already-read root artifact (first zip entry).
 * @param sessionId - the root session id.
 * @param includeDescendants - whether to include every subagent descendant.
 * @param signal - optional cancellation for read work.
 * @returns the zip byte stream.
 */
export function streamSessionLogZip(
  deps: SessionLogExportDeps,
  root: SessionRawArtifact,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // fflate invokes the callback synchronously per compressed chunk;
      // enqueued bytes stay bounded by the compressed archive size (the body
      // consumer drains them over the wire as the stream is pulled).
      const zip = new Zip((error, data, final) => {
        if (error) {
          controller.error(error)
          return
        }
        if (data.byteLength > 0) controller.enqueue(data)
        if (final) controller.close()
      })
      void (async () => {
        try {
          for await (const entry of sessionLogZipEntries(deps, root, sessionId, includeDescendants, signal)) {
            const deflate = new ZipDeflate(entry.path, { level: 6 })
            zip.add(deflate)
            const content = entry.content
            for (let offset = 0; offset < content.length; offset += PUSH_CHUNK_CODE_POINTS) {
              signal?.throwIfAborted()
              const finalChunk = offset + PUSH_CHUNK_CODE_POINTS >= content.length
              deflate.push(encoder.encode(content.slice(offset, offset + PUSH_CHUNK_CODE_POINTS)), finalChunk)
            }
          }
          zip.end()
        } catch (error) {
          // A mid-stream failure (missing descendant, cancellation, read
          // error) must fail the download rather than ship a truncated archive.
          controller.error(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    },
  })
}
