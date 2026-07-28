/** LAN-authority derivation for the /api browser-trust fence (`resolveTrustedHosts`). */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { lanIPv4Addresses, resolveTrustedHosts } from '../src/app-cli-entry.ts'

vi.mock('node:os', () => ({
  networkInterfaces: () => ({
    lo0: [
      { family: 'IPv4', internal: true, address: '127.0.0.1' },
    ],
    en0: [
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: false, address: '192.168.1.5' },
    ],
    en1: [
      { family: 'IPv4', internal: false, address: '10.0.0.7' },
    ],
    utun0: undefined,
  }),
}))

afterEach(() => { vi.restoreAllMocks() })

describe('lanIPv4Addresses', () => {
  it('returns only non-internal IPv4 addresses, in interface order', () => {
    expect(lanIPv4Addresses()).toEqual(['192.168.1.5', '10.0.0.7'])
  })
})

describe('resolveTrustedHosts', () => {
  it('derives port-less LAN IP literals for an all-interfaces bind, ahead of the extras', () => {
    expect(resolveTrustedHosts('0.0.0.0', ['harness.internal:3080']))
      .toEqual(['192.168.1.5', '10.0.0.7', 'harness.internal:3080'])
  })

  it('derives nothing for a loopback or unresolved bind — extras alone stand', () => {
    expect(resolveTrustedHosts('127.0.0.1', [])).toEqual([])
    expect(resolveTrustedHosts(undefined, ['lab.internal'])).toEqual(['lab.internal'])
  })
})
