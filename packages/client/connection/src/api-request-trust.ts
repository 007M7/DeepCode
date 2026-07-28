/**
 * Browser-trust fence for every /api request. Defends the two confused-deputy
 * paths a browser opens against a local HTTP API — DNS rebinding (Host names
 * the attacker's domain while the socket reaches this server) and cross-site
 * requests fired from a malicious page — without blocking non-browser clients
 * (no browser markers → no deputy to confuse) or legitimately remote browsers
 * (their authority is declared via `trustedHosts`). Network reachability and
 * authentication stay out of scope: binding policy belongs to the webserver
 * config, and this fence is not an auth layer.
 */

import type { IncomingHttpHeaders } from 'node:http'

/** The request facts the fence reads (structural subset of IncomingMessage). */
interface ApiTrustRequest {
  headers: IncomingHttpHeaders
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Hostname of a Host-header authority (port stripped, lowercased, IPv6 bracketed), or undefined when unparsable. */
function authorityHostname(authority: string): string | undefined {
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`).hostname
  } catch {
    return undefined
  }
}

/**
 * Decide whether one /api request may reach the RPC bridge.
 * @param request - node HTTP request facts (headers).
 * @param trustedHosts - exact non-loopback `host[:port]` authorities this deployment serves.
 * @returns true when the Host is ours and any browser markers are same-origin.
 */
export function isTrustedApiRequest(request: ApiTrustRequest, trustedHosts: readonly string[]): boolean {
  // Host fence (DNS-rebinding defense): the browser fills Host from the URL it
  // believes it is talking to, so a rebound page carries the attacker's domain
  // here even though the socket lands on this server.
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostname = authorityHostname(host)
  if (hostname === undefined) return false
  if (!isLoopbackHostname(hostname) && !trustedHosts.includes(host)) return false
  // Cross-site fence: modern browsers label the initiator relationship on
  // every fetch; an explicit cross-site marker is refused regardless of Origin.
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin fence: when a browser attaches an Origin it must be exactly this
  // authority. Absent Origin = non-browser client (curl, tests, native shells)
  // — allowed, because without a browser there is no confused deputy. The
  // literal "null" (sandboxed iframes, file: pages) is an opaque origin, refused.
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
