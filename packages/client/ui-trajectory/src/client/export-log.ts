/**
 * Session log export: browser download of the host-streamed ZIP. The archive
 * itself is produced and streamed by the host (GET /api/session.export); this
 * module only derives the download filename and triggers the browser save.
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
 * Trigger a browser download of a blob response.
 * @param blob - the response body to save (passed straight through, no copy).
 * @param filename - the download filename.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // Revoke one tick later: some browsers read the blob URL after click().
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
