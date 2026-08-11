/**
 * Session log export delivery. The host streams the archive from
 * `GET /api/session.export`; this module owns the browser-native download
 * handoff so the browser can stream the response directly to its download
 * manager instead of buffering the ZIP in JavaScript.
 * @module
 */

/**
 * Collapse an untrusted session id into one safe path/filename segment.
 * Distinct ids may collapse onto one segment (impossible for the host-minted
 * UUIDs, so no uniqueness suffix is kept).
 * @param id - the raw session id.
 * @returns a filesystem-safe single segment.
 */
function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * The export archive filename for one session (same convention the host's
 * Content-Disposition uses).
 * @param sessionId - the root session id.
 * @returns the download filename.
 */
export function sessionLogZipFilename(sessionId: string): string {
  return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`
}

/**
 * Hand one host-streamed session archive to the browser download manager.
 * The operation resolves after dispatching the native download; HTTP delivery
 * continues outside JavaScript and is reported by the browser itself.
 * @param sessionId - the root session id to export with all descendants.
 * @returns a promise that rejects if the browser handoff itself fails.
 */
export function downloadSessionLog(sessionId: string): Promise<void> {
  return Promise.resolve().then(() => {
    const query = new URLSearchParams({ sessionId, includeDescendants: 'true' })
    const anchor = document.createElement('a')
    anchor.href = `/api/session.export?${query.toString()}`
    anchor.download = sessionLogZipFilename(sessionId)
    anchor.click()
  })
}
