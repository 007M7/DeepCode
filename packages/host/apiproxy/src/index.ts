/**
 * @deepseek-ai/dsh-host-apiproxy — the front layer every client shape shares:
 * the ApiProxy contract (api/: types + zod schemas, browser-safe) and the
 * fetch carrier pair (fetch/: toFetchHandler on the host side, AbstractApiClient +
 * platform subclasses on the client side). Host assembly (bootHost/createApiProxy/startHost)
 * lives in @deepseek-ai/dsh-host-runtime.
 */

export type * from './api/index.ts'
export { RpcId } from './api/rpc.ts'
export { toFetchHandler } from './fetch/handler.ts'
export { AbstractApiClient, InProcessApiClient } from './fetch/client.ts'
export type { IApiClient } from './fetch/client.ts'
