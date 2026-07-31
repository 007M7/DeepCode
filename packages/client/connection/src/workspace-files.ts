/**
 * The read half of the web transport: streams one file out of a session's
 * workspace so the browser can open what the agent just produced. The RPC
 * gateway carries structured session state; this route carries bytes, which a
 * JSON-RPC envelope cannot stream and a `file://` link cannot reach from an
 * http page.
 *
 * Confinement is the whole contract: a request names a session, the session
 * names its cwd, and nothing outside that realpath is ever served. The caller
 * owns the browser-trust fence ([api-request-trust](./api-request-trust.ts)) —
 * this module is reached only by requests that already passed it.
 */

import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parseWorkspaceFilePath } from '@deepseek-ai/dsh-host-apiproxy/api'

/**
 * Content types served verbatim. Everything absent is `text/plain`, not
 * `application/octet-stream`: a workspace read is a "show me what you made"
 * gesture, and an unknown extension is far more often a source file to read
 * than a binary to download. `nosniff` keeps that choice binding, so a
 * mislabelled document can never be re-interpreted as HTML.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
}

const DEFAULT_MIME = 'text/plain; charset=utf-8'

/** Extensions whose top-level navigation can execute script, and so need the sandbox. */
const SCRIPTABLE = new Set(['.html', '.htm', '.xhtml', '.svg'])

/**
 * Model-authored documents run in an opaque origin. Without it a generated page
 * is same-origin with the RPC gateway, where `/api/events.mux` is a readable
 * GET stream — one `window.open` away from every session's events. The cost is
 * that `localStorage`, cookies, and same-origin `fetch` are unavailable inside
 * a preview; the native-open path (`host.openPath`) remains the full-capability
 * way to view a file.
 */
const SANDBOX_CSP = 'sandbox allow-scripts allow-popups allow-modals allow-forms'

/** How the route learns which directory a session may serve from. */
export interface WorkspaceFileDeps {
  /**
   * The session's absolute working directory.
   * @param sessionId - the session named by the request path.
   * @returns its cwd, or `undefined` when the id names no session this host serves.
   */
  cwdFor: (sessionId: string) => Promise<string | undefined>
}

function fail(res: ServerResponse, status: number): void {
  res.writeHead(status)
  res.end()
}

/**
 * Resolve one request's segments against a session cwd, refusing anything that
 * leaves it. Both sides go through `realpath`, so a symlink inside the
 * workspace pointing out of it is refused by its resolved target rather than
 * its name. A component swapped between this resolution and the open below
 * would still be followed; closing that window needs privileges that already
 * imply workspace write access, which is strictly stronger than reading a
 * workspace file, so the check stops here.
 */
async function confine(cwd: string, segments: readonly string[]): Promise<string | undefined> {
  const root = await realpath(cwd)
  const real = await realpath(resolve(root, ...segments))
  return real.startsWith(root + sep) ? real : undefined
}

/**
 * Serve one workspace-file request. The caller has already applied the
 * browser-trust fence and rejected non-read methods.
 * @param req - the request, read for its url and method only (no body).
 * @param res - the response this function owns to completion.
 * @param deps - the session-to-cwd lookup this host answers with.
 */
export async function handleWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WorkspaceFileDeps,
): Promise<void> {
  /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server requests. */
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const target = parseWorkspaceFilePath(pathname)
  if (target === undefined) {
    fail(res, 404)
    return
  }
  const cwd = await deps.cwdFor(target.sessionId)
  if (cwd === undefined) {
    fail(res, 404)
    return
  }

  let file: string | undefined
  let size: number
  try {
    file = await confine(cwd, target.segments)
    if (file === undefined) {
      fail(res, 403)
      return
    }
    const info = await stat(file)
    // A directory read has no answer here: the route serves files, and listing
    // is the directory-picker capability's job, behind its own fence.
    if (!info.isFile()) {
      fail(res, 404)
      return
    }
    size = info.size
  } catch {
    // Missing, unreadable, or a path whose ancestor is not a directory: all
    // report as absent, so a probe cannot distinguish them.
    fail(res, 404)
    return
  }

  const ext = extname(file).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME[ext] ?? DEFAULT_MIME,
    'content-length': String(size),
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    // Workspace files change under the agent's hands; a cached preview would
    // show the previous turn's output after the next edit.
    'cache-control': 'no-store',
    ...SCRIPTABLE.has(ext) ? { 'content-security-policy': SANDBOX_CSP } : {},
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  try {
    // pipeline (not pipe) so a client disconnect destroys the read stream:
    // an abandoned preview must not leave a descriptor open.
    await pipeline(createReadStream(file), res)
  } catch {
    // The status line is already out, so a mid-stream read failure or client
    // disconnect can only end the response abruptly.
    res.destroy()
  }
}
