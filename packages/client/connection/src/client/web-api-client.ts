// WebApiClient: the browser platform subclass — transport = global fetch over same-origin
// /api/* (base resolution handled by AbstractApiClient). Envelope observation comes from the
// base batching aspect; subscribers attach via subscribeEnvelopes (see boot).

import { AbstractApiClient } from './api.ts'

/** Browser platform subclass: transport = global fetch over same-origin /api/*. */
export class WebApiClient extends AbstractApiClient {
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }
}
