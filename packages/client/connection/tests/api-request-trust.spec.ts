/** Behavior of the /api browser-trust fence (rebinding + cross-site defense). */

import { describe, expect, it } from 'vitest'
import { isTrustedApiRequest } from '../src/api-request-trust.ts'

function request(headers: Record<string, string | undefined>): { headers: Record<string, string | undefined> } {
  return { headers }
}

describe('isTrustedApiRequest', () => {
  it('accepts every request without browser markers — curl, tests, native clients, on any Host', () => {
    // No Origin and no sec-fetch-site → the sender is the principal itself
    // (it forges Host freely anyway); this is the LAN-serving shape a Host
    // fence must not break.
    for (const host of ['127.0.0.1:3080', '192.168.1.5:3080', 'harness.example', undefined]) {
      expect(isTrustedApiRequest(request(host === undefined ? {} : { host }), [])).toBe(true)
    }
  })

  it('accepts loopback Hosts in every spelling, with and without ports, for browser requests', () => {
    for (const host of ['localhost', 'localhost:3080', '127.0.0.1', '127.0.0.1:3080', '127.8.9.10:80', '[::1]', '[::1]:3080', 'LOCALHOST:3080']) {
      expect(isTrustedApiRequest(request({ host, origin: `http://${host}` }), [])).toBe(true)
    }
  })

  it('refuses a rebound Host: the attacker domain names the socket it did not expect', () => {
    expect(isTrustedApiRequest(request({
      host: 'evil.example:3080',
      origin: 'http://evil.example:3080',
      'sec-fetch-site': 'same-origin',
    }), [])).toBe(false)
  })

  it('accepts a declared public authority: exact on host:port entries, any port on port-less entries', () => {
    const headers = { host: 'harness.internal:3080', origin: 'http://harness.internal:3080' }
    expect(isTrustedApiRequest(request(headers), ['harness.internal:3080'])).toBe(true)
    expect(isTrustedApiRequest(request(headers), ['harness.internal'])).toBe(true)
    expect(isTrustedApiRequest(request(headers), ['harness.internal:9999'])).toBe(false)
    expect(isTrustedApiRequest(request(headers), [])).toBe(false)
  })

  it('matches Host, Origin, and trusted entries through WHATWG normalization (case, default port)', () => {
    expect(isTrustedApiRequest(request({ host: 'Harness.INTERNAL:3080', origin: 'http://harness.internal:3080' }), ['harness.internal:3080'])).toBe(true)
    expect(isTrustedApiRequest(request({ host: 'harness.internal', origin: 'http://harness.internal' }), ['HARNESS.internal:80'])).toBe(true)
    // An unparsable entry never matches; it must not poison the rest of the list.
    expect(isTrustedApiRequest(request({ host: 'harness.internal', origin: 'http://harness.internal' }), ['bad entry', 'harness.internal'])).toBe(true)
    expect(isTrustedApiRequest(request({ host: 'harness.internal', origin: 'http://harness.internal' }), ['bad entry'])).toBe(false)
  })

  it('refuses cross-origin browser markers even on a loopback Host', () => {
    // Origin present and different → cross-site request that survived preflight rules.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'http://evil.example' }), [])).toBe(false)
    // Explicit cross-site label → refused regardless of Origin.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), [])).toBe(false)
    // Opaque origin (sandboxed iframe, file: page) parses to no authority.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'null' }), [])).toBe(false)
  })

  it('accepts a same-origin browser request, with or without an Origin header', () => {
    expect(isTrustedApiRequest(request({
      host: 'localhost:3080',
      origin: 'http://localhost:3080',
      'sec-fetch-site': 'same-origin',
    }), [])).toBe(true)
    // Origin-less browser shapes (same-origin GETs) still carry sec-fetch-site.
    expect(isTrustedApiRequest(request({ host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }), [])).toBe(true)
  })

  it('refuses malformed or untrusted authorities on browser requests', () => {
    const markers = { 'sec-fetch-site': 'same-origin' }
    expect(isTrustedApiRequest(request({ ...markers }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ ...markers, host: '' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ ...markers, host: 'bad host' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ ...markers, host: '127.0.0.999' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ ...markers, host: '128.0.0.1' }), [])).toBe(false)
  })
})
