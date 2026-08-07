import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import {
  deriveClientTimeZoneContext,
} from '@deepseek-ai/dsh-time-context'
import { renderTimeZoneContext } from '../src/request-zone.ts'

function request(clientTimeZone?: unknown) {
  return createUserMessage({
    content: [{ type: 'text', text: 'request' }],
    source: clientTimeZone === undefined
      ? { kind: 'user' }
      : { kind: 'user', rpcId: 'request-zone', clientTimeZone } as never,
  })
}

describe('request-zone derivation', () => {
  it('publishes derivation without exposing the internal renderer', () => {
    expect(timeContext.deriveClientTimeZoneContext).toBe(deriveClientTimeZoneContext)
    expect('renderTimeZoneContext' in timeContext).toBe(false)
  })

  it('derives missing, one resolved zone, and sorted unique mixed zones', () => {
    const plugin = createUserMessage({
      content: [],
      source: { kind: 'plugin', plugin: 'fixture' },
    })
    expect(deriveClientTimeZoneContext([plugin, request(), request(1)])).toEqual({ kind: 'missing' })
    expect(deriveClientTimeZoneContext([createUserMessage({
      content: [],
      source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' } as never,
    })])).toEqual({ kind: 'missing' })
    expect(deriveClientTimeZoneContext([
      request('Asia/Shanghai'),
      request('Asia/Shanghai'),
    ])).toEqual({ kind: 'resolved', timeZone: 'Asia/Shanghai' })
    expect(deriveClientTimeZoneContext([
      request('Asia/Shanghai'),
      request('America/New_York'),
    ])).toEqual({
      kind: 'mixed',
      timeZones: ['America/New_York', 'Asia/Shanghai'],
    })
  })

  it('renders resolved, mixed, and unavailable policy lines', () => {
    expect(renderTimeZoneContext('Asia/Shanghai', {
      kind: 'resolved',
      timeZone: 'Asia/Shanghai',
    })).toBe(
      'Session time zone: Asia/Shanghai.\nClient time zone for this request: Asia/Shanghai.',
    )
    expect(renderTimeZoneContext('UTC', {
      kind: 'mixed',
      timeZones: ['America/New_York', 'UTC'],
    })).toBe(
      'Session time zone: UTC.\nClient time zone for this request: mixed ["America/New_York","UTC"].',
    )
    expect(renderTimeZoneContext(undefined, { kind: 'missing' })).toBe(
      'Session time zone: unavailable.\nClient time zone for this request: missing.',
    )
  })
})
