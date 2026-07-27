/** Trust check for browser requests that can open an operating-system dialog. */

import type { IncomingHttpHeaders } from 'node:http'

interface NativeDialogRequest {
  headers: IncomingHttpHeaders
  socket: { remoteAddress?: string | undefined }
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  const first = ipv4.split('.')[0]
  return first === '127'
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Require a local socket plus browser-controlled same-origin metadata.
 * @param request - the node HTTP request facts used by the carrier guard.
 * @returns true only for a same-origin browser request whose peer and URL are loopback.
 */
export function isTrustedNativeDialogRequest(request: NativeDialogRequest): boolean {
  if (!isLoopback(request.socket.remoteAddress)) return false
  if (header(request.headers, 'sec-fetch-site') !== 'same-origin') return false
  const origin = header(request.headers, 'origin')
  const host = header(request.headers, 'host')
  if (origin === undefined || host === undefined) return false
  try {
    const parsed = new URL(origin)
    const hostUrl = new URL(`http://${host}`)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host === host
      && isLoopbackHostname(parsed.hostname)
      && isLoopbackHostname(hostUrl.hostname)
  } catch {
    return false
  }
}
