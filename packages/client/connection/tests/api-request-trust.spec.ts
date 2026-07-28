/** Behavior of the /api browser-trust fence (rebinding + cross-site defense). */

import { describe, expect, it } from 'vitest'
import { isTrustedApiRequest } from '../src/api-request-trust.ts'

function request(headers: Record<string, string | undefined>): { headers: Record<string, string | undefined> } {
  return { headers }
}

describe('isTrustedApiRequest', () => {
  it('accepts loopback Hosts in every spelling, with and without ports', () => {
    for (const host of ['localhost', 'localhost:3080', '127.0.0.1', '127.0.0.1:3080', '127.8.9.10:80', '[::1]', '[::1]:3080', 'LOCALHOST:3080']) {
      expect(isTrustedApiRequest(request({ host }), [])).toBe(true)
    }
  })

  it('accepts non-browser requests (no Origin, no sec-fetch-site) — curl, tests, native clients', () => {
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080' }), [])).toBe(true)
  })

  it('refuses a rebound Host: the attacker domain names the socket it did not expect', () => {
    expect(isTrustedApiRequest(request({
      host: 'evil.example:3080',
      origin: 'http://evil.example:3080',
      'sec-fetch-site': 'same-origin',
    }), [])).toBe(false)
  })

  it('accepts a declared public authority only on exact host[:port] match', () => {
    const headers = { host: 'harness.internal:3080', origin: 'http://harness.internal:3080' }
    expect(isTrustedApiRequest(request(headers), ['harness.internal:3080'])).toBe(true)
    expect(isTrustedApiRequest(request(headers), ['harness.internal'])).toBe(false)
    expect(isTrustedApiRequest(request(headers), [])).toBe(false)
  })

  it('refuses cross-origin browser markers even on a loopback Host', () => {
    // Origin present and different → cross-site request that survived preflight rules.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'http://evil.example' }), [])).toBe(false)
    // Explicit cross-site label → refused regardless of Origin.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), [])).toBe(false)
    // Opaque origin (sandboxed iframe, file: page) parses to no authority.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'null' }), [])).toBe(false)
  })

  it('accepts a same-origin browser request', () => {
    expect(isTrustedApiRequest(request({
      host: 'localhost:3080',
      origin: 'http://localhost:3080',
      'sec-fetch-site': 'same-origin',
    }), [])).toBe(true)
  })

  it('refuses malformed authorities', () => {
    expect(isTrustedApiRequest(request({}), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: '' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: 'bad host' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: '127.0.0.999' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: '128.0.0.1' }), [])).toBe(false)
  })
})
