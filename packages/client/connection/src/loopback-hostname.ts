/**
 * Browser-safe, zero-dependency loopback classification shared by the `/api`
 * Host fence and browser welcome-persistence selection. The dedicated
 * `./loopback-hostname` source subpath is inlined into client bundles instead
 * of loaded by plain Node, so this module must not add Node-only or runtime
 * dependencies.
 * @module @deepseek-ai/dsh-client-connection/loopback-hostname
 */

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
