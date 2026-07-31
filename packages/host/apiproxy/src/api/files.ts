/**
 * The `/f` workspace-file URL shape: the contract half of the web transport
 * that carries bytes rather than RPC. The browser turns a tool's file path
 * into a URL, the serving side turns that URL back into the segments below a
 * session's cwd, and both read this one encoding decision so neither can drift
 * into serving a path the other never meant. Pure string work with no Node and
 * no DOM, like the rest of `api/` — the browser bundle inlines it.
 * @module @deepseek-ai/dsh-host-apiproxy/api/files
 */

/**
 * Route prefix owning every workspace-file read (`/f/<sessionId>/<segments…>`).
 * The path carries the segments verbatim rather than a query parameter so a
 * served document's relative references (`./logo.png`) resolve to their
 * siblings in the same workspace directory.
 */
export const FILES_PATH = '/f'

/** One parsed workspace-file request: whose workspace, and where inside it. */
export interface WorkspaceFileTarget {
  /** The owning session, still an opaque string — the caller resolves it to a cwd. */
  sessionId: string
  /** Decoded path segments below that session's cwd; never empty, never `.` or `..`. */
  segments: string[]
}

/** A segment that survived decoding but would re-enter path resolution as more than one name. */
function isPlainSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..'
    && !segment.includes('/') && !segment.includes('\\') && !segment.includes('\0')
}

function decode(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw)
  } catch {
    // A malformed %-escape is a request we cannot interpret, not a miss.
    return undefined
  }
}

/**
 * Express one tool-reported file path as segments below the session cwd.
 * @param cwd - the session's working directory, or `undefined` when unknown.
 * @param path - the path the tool reported (absolute, or relative to `cwd`).
 * @returns the segments below `cwd`, or `undefined` when the path names
 * something outside the workspace (which this route never serves) or resolves
 * to the workspace directory itself.
 */
export function workspaceFileSegments(cwd: string | undefined, path: string): string[] | undefined {
  const slashed = path.replace(/\\/g, '/')
  const absolute = /^\/|^[A-Za-z]:\//.test(slashed)
  let relative: string
  if (absolute) {
    if (cwd === undefined || cwd === '') return undefined
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!slashed.startsWith(`${root}/`)) return undefined
    relative = slashed.slice(root.length + 1)
  } else {
    relative = slashed
  }
  const segments = relative.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some(segment => !isPlainSegment(segment))) return undefined
  return segments
}

/**
 * Build the origin-relative URL serving one workspace file.
 * @param sessionId - the session whose cwd anchors the path.
 * @param segments - segments below that cwd, as {@link workspaceFileSegments} returns them.
 * @returns the `/f/…` URL, resolved by the browser against the serving origin.
 */
export function workspaceFileUrl(sessionId: string, segments: readonly string[]): string {
  const encoded = segments.map(segment => encodeURIComponent(segment)).join('/')
  return `${FILES_PATH}/${encodeURIComponent(sessionId)}/${encoded}`
}

/**
 * Parse a request pathname back into the session and segments it names.
 * @param pathname - the request's raw (still percent-encoded) pathname.
 * @returns the target, or `undefined` when the pathname is not a well-formed
 * workspace-file read — including every traversal shape, which is refused here
 * before any filesystem call rather than being resolved and then judged.
 */
export function parseWorkspaceFilePath(pathname: string): WorkspaceFileTarget | undefined {
  if (!pathname.startsWith(`${FILES_PATH}/`)) return undefined
  const [rawSession, ...rawSegments] = pathname.slice(FILES_PATH.length + 1).split('/')
  if (rawSession === undefined || rawSegments.length === 0) return undefined
  const sessionId = decode(rawSession)
  if (sessionId === undefined || sessionId === '') return undefined
  const segments: string[] = []
  for (const raw of rawSegments) {
    const segment = decode(raw)
    if (segment === undefined || !isPlainSegment(segment)) return undefined
    segments.push(segment)
  }
  return { sessionId, segments }
}
