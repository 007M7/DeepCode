/** Browser caller for generic Connection unary RPC channels. */

import {
  RpcId,
  serverResponseSchema,
  type ClientRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '../rpc.ts'

const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Create the browser-backed generic RPC caller.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createWebConnectionRpc(): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(crypto.randomUUID())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      const response = await globalThis.fetch(
        new URL(`${channel}/${endpoint}`, resolveBase()),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          ...signal === undefined ? {} : { signal },
        },
      )
      if (!response.ok) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const full = serverResponseSchema.parse(await response.json())
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}

/**
 * Create the fixture-mode caller, where no Host Remote registry exists.
 * @returns caller that rejects every generic Remote invocation.
 */
export function createUnavailableConnectionRpc(): ClientConnectionRpc {
  return {
    call(channel, endpoint) {
      return Promise.reject(new Error(`connection RPC ${channel}/${endpoint} is unavailable in fixture mode`))
    },
  }
}

function resolveBase(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  return location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.length === 0
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
