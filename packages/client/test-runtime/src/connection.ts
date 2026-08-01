/** Test-owned connection face: the transport members features read off `ctx.connection`. */
import { workspaceFileSegments, workspaceFileUrl } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionHandle, IApiClient, SessionId } from '@deepseek-ai/dsh-client-connection/client'

/**
 * Connection test double. Implements the same `ConnectionHandle` face features
 * receive as `ctx.connection`, so a production face change breaks this double
 * at compile time. The wire client is not modelled — a feature that needs one
 * composes its own connection over a fake api client; this double exists for
 * the transport facts features read synchronously, above all the
 * workspace-file URL.
 */
export class TestConnection implements ConnectionHandle {
  /**
   * The workspace-file port the host would have published into the page.
   * Unset — the default, and the keyless fixture lane's real state — makes
   * {@link TestConnection.fileUrl} answer `undefined`, which is the signal a
   * caller falls back to the Host opener on.
   */
  filesPort: number | undefined

  /** The wire client; unused by this double's consumers and absent by construction. */
  readonly api: IApiClient = undefined as unknown as IApiClient

  /**
   * Stream-loop starter (inert).
   * @returns a stop handle that does nothing.
   */
  start(): { stop(): void } {
    return { stop: () => {} }
  }

  /**
   * Workspace-file URL, deriving exactly as production does so a feature test
   * sees the real inside/outside-workspace split.
   * @param sessionId - the Session whose cwd anchors the path.
   * @param cwd - that Session's working directory.
   * @param path - the path a tool reported.
   * @returns the absolute URL on the workspace-file origin, or undefined when
   * the path leaves the workspace or no port is published.
   */
  fileUrl(sessionId: SessionId, cwd: string | undefined, path: string): string | undefined {
    if (this.filesPort === undefined) return undefined
    const segments = workspaceFileSegments(cwd, path)
    if (segments === undefined) return undefined
    return `http://localhost:${String(this.filesPort)}${workspaceFileUrl(sessionId, segments)}`
  }
}
