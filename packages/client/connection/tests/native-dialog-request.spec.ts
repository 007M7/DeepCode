import type { IncomingHttpHeaders } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isTrustedNativeDialogRequest } from '../src/native-dialog-request.ts'

function request(
  remoteAddress: string | undefined,
  headers: IncomingHttpHeaders = {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'sec-fetch-site': 'same-origin',
  },
) {
  return { socket: { remoteAddress }, headers }
}

describe('native dialog request trust', () => {
  it('accepts loopback same-origin browser requests', () => {
    expect(isTrustedNativeDialogRequest(request('127.0.0.1'))).toBe(true)
    expect(isTrustedNativeDialogRequest(request('::1', {
      host: '[::1]:3080', origin: 'http://[::1]:3080', 'sec-fetch-site': 'same-origin',
    }))).toBe(true)
    expect(isTrustedNativeDialogRequest(request('::ffff:127.0.0.1'))).toBe(true)
    expect(isTrustedNativeDialogRequest(request('127.0.0.1', {
      host: 'localhost:3080', origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin',
    }))).toBe(true)
    expect(isTrustedNativeDialogRequest(request('127.0.0.2', {
      host: '127.0.0.2:3080', origin: 'https://127.0.0.2:3080', 'sec-fetch-site': 'same-origin',
    }))).toBe(true)
  })

  it('rejects remote sockets and requests without matching browser metadata', () => {
    expect(isTrustedNativeDialogRequest(request('192.168.1.5'))).toBe(false)
    expect(isTrustedNativeDialogRequest(request(undefined))).toBe(false)
    expect(isTrustedNativeDialogRequest(request('127.0.0.1', {
      host: '127.0.0.1:3080', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site',
    }))).toBe(false)
    expect(isTrustedNativeDialogRequest(request('127.0.0.1', {
      host: '127.0.0.1:3080', origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin',
    }))).toBe(false)
    expect(isTrustedNativeDialogRequest(request('127.0.0.1', { host: '127.0.0.1:3080' }))).toBe(false)
    expect(isTrustedNativeDialogRequest(request('127.0.0.1', {
      origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin',
    }))).toBe(false)
    expect(isTrustedNativeDialogRequest(request('127.0.0.1', {
      host: 'attacker.example:3080', origin: 'http://attacker.example:3080', 'sec-fetch-site': 'same-origin',
    }))).toBe(false)
    expect(isTrustedNativeDialogRequest(request('127.0.0.1', {
      host: '127.0.0.1:3080', origin: 'ftp://127.0.0.1:3080', 'sec-fetch-site': 'same-origin',
    }))).toBe(false)
    expect(isTrustedNativeDialogRequest(request('127.0.0.1', {
      host: '127.999.0.1:3080', origin: 'http://127.999.0.1:3080', 'sec-fetch-site': 'same-origin',
    }))).toBe(false)
    expect(isTrustedNativeDialogRequest(request('127.0.0.1', {
      host: '[invalid', origin: 'http://[invalid', 'sec-fetch-site': 'same-origin',
    }))).toBe(false)
  })
})
