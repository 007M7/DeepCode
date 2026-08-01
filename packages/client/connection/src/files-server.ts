/**
 * The workspace-file listener: a second loopback/LAN socket on the same host
 * as the API, serving nothing but `/f`.
 *
 * The port is the isolation. A workspace file is not necessarily
 * agent-authored — a read row makes every file in a cloned repository
 * openable — so an active document must not be same-origin with `/api`, where
 * its script would pass the browser-trust fence into every method, the
 * loopback-pinned settings and credential plane included. A different port is
 * a different origin, which the browser enforces for free: the document keeps
 * `localStorage`, cookies, and its own `fetch`, while a call to the API is
 * cross-origin and refused twice over — by the fence's Origin check and by
 * CORS. The alternative, `Content-Security-Policy: sandbox`, buys the same
 * boundary by taking the document's origin away entirely, which measurably
 * breaks the pages this route exists to show.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FILES_PATH } from '@deepseek-ai/dsh-host-apiproxy/api'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { handleWorkspaceFile, type WorkspaceFileDeps } from './workspace-files.ts'

/** A listening workspace-file server: its port, and the teardown that reaches quiescence. */
export interface FilesServer {
  /** The bound port (OS-assigned), which the browser half needs to address this origin. */
  port: number
  /** Close the socket and destroy held connections; resolves once quiet. */
  close: () => Promise<void>
}

/**
 * Bind the workspace-file listener.
 * @param host - the same bind host the API uses, so a client that can reach
 * the app can reach its previews (a LAN deployment included).
 * @param trustedHosts - the deployment's non-loopback serving authorities,
 * applied through the same fence as `/api`.
 * @param deps - the session-to-directory lookup reads are confined by.
 * @param onSocketError - reports a post-listen socket error; without a
 * listener node would raise it as an unhandled 'error' event.
 * @returns the bound port and its disposer.
 */
export async function listenForWorkspaceFiles(
  host: string,
  trustedHosts: readonly string[],
  deps: WorkspaceFileDeps,
  onSocketError: (error: Error) => void,
): Promise<FilesServer> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isTrustedApiRequest(req, trustedHosts)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server requests. */
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    // This origin serves one prefix and nothing else: no index, no SPA
    // fallback, no API. Anything else is not here — answered before the method
    // check, because a 405 would claim the resource exists.
    if (pathname !== FILES_PATH && !pathname.startsWith(`${FILES_PATH}/`)) {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // RFC 9110 §15.5.6: a 405 names the methods the resource does support.
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    await handleWorkspaceFile(req, res, deps)
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // A malformed request must not become an unhandled rejection that takes
      // the process down; the API carrier guards its own handler the same way.
      if (res.headersSent) {
        res.destroy()
        return
      }
      onSocketError(error instanceof Error ? error : new Error(String(error)))
      res.writeHead(400)
      res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      server.on('error', onSocketError)
      resolve()
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    // close + closeAllConnections: a held-open response would otherwise keep
    // teardown waiting forever.
    close: () => new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    }),
  }
}

/** The global the node half hands its port to the browser half through. */
export const FILES_PORT_GLOBAL = '__DSH_FILES_PORT__'

/**
 * Inject the workspace-file port into index.html, ahead of the shell bundle
 * that reads it. A boot-time fact of the serving host, delivered the way the
 * module graph is: synchronously on the page, so the first click on a produced
 * file does not race a round trip.
 * @param html - the index.html source.
 * @param port - the bound workspace-file port.
 * @returns the html with the port script injected.
 */
export function injectFilesPort(html: string, port: number): string {
  const script = `<script>window.${FILES_PORT_GLOBAL} = ${String(port)}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  /* v8 ignore next -- headless fixture pages may lack <head>; prepending keeps read-before-shell ordering. */
  return `${script}${html}`
}
