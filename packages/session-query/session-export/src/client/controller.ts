/** Browser download state shared by the Session Header button and `/export`. */

import { createSnapshotStore, type SessionId, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Download phases presented by the shared modal. */
export type SessionExportDownloadStatus = 'downloading' | 'success' | 'error'

/** One Session's current download-dialog state. */
export interface SessionExportDownloadEntry {
  readonly open: boolean
  readonly status: SessionExportDownloadStatus
  readonly error: string | null
}

/** Download states keyed by the Session whose Header owns the dialog. */
export interface SessionExportDownloadState {
  bySession: Record<string, SessionExportDownloadEntry | undefined>
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Save = (blob: Blob, filename: string) => void

const INITIAL: SessionExportDownloadState = { bySession: {} }

/**
 * Collapse an untrusted Session id into the filename convention owned by the host endpoint.
 * @param sessionId - Session whose archive is downloaded.
 * @returns one safe browser download filename.
 */
export function sessionLogZipFilename(sessionId: SessionId): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

/**
 * Trigger a browser save without copying the response blob.
 * @param blob - complete ZIP response body.
 * @param filename - browser download filename.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns one in-flight browser download per Session and publishes modal state. */
export class SessionExportDownloadController {
  /** uSES-safe state source shared by every Session-scoped modal contribution. */
  readonly store: SnapshotStore<SessionExportDownloadState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /**
   * @param fetcher - HTTP carrier used to read the host-streamed ZIP.
   * @param save - browser save operation.
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly save: Save = downloadBlob,
  ) {}

  /**
   * Download one Session tree; concurrent gestures for the same Session share one operation.
   * @param sessionId - root Session whose ZIP includes descendants and attachments.
   * @returns after the browser save starts, an error state is published, or a late post-disposal request is ignored.
   */
  download(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /**
   * Present a command failure without issuing an HTTP request.
   * @param sessionId - Session whose modal reports the failure.
   * @param error - stable command failure text.
   */
  fail(sessionId: SessionId, error: string): void {
    this.publish(sessionId, { open: true, status: 'error', error })
  }

  /**
   * Close one Session's dialog without cancelling an in-flight browser download.
   * @param sessionId - Session whose modal closes.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /**
   * Abort active fetches and reach quiescence.
   * @returns after every active operation settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, { open: true, status: 'downloading', error: null })
    try {
      const url = new URL('/api/session.export', hostBase())
      url.searchParams.set('sessionId', sessionId)
      url.searchParams.set('includeDescendants', 'true')
      const response = await this.fetcher(url, { signal })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
      }
      this.save(await response.blob(), sessionLogZipFilename(sessionId))
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'success', error: null })
    } catch (error: unknown) {
      if (signal.aborted) return
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'error', error: messageOf(error) })
    }
  }

  private publish(sessionId: SessionId, entry: SessionExportDownloadEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
