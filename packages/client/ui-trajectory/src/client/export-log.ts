/**
 * Session log export: browser download of the host-streamed ZIP. The archive
 * itself is produced and streamed by the host (GET /api/session.export); this
 * module only derives the download filename and triggers the browser save.
 * @module
 */

/**
 * Collapse an untrusted session id into one safe path/filename segment.
 * @param id - the raw session id.
 * @returns a filesystem-safe single segment.
 */
function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
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
 * Trigger a browser download of raw bytes.
 * @param bytes - the file content.
 * @param filename - the download filename.
 * @param type - the MIME type.
 */
export function downloadBytes(bytes: Uint8Array<ArrayBuffer>, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
