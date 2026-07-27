/**
 * TypeScript client SDK for the DeepSeek Harness runtime: spawn the
 * `dsh-jsonrpc-agent` runtime as a subprocess and drive agent turns over
 * stdio JSON-RPC. `DeepSeekHarness` is the high-level turns API;
 * `HarnessClient` is the lower-level protocol client. A pure library — it
 * registers nothing on a Cordis context; the runtime process it spawns is a
 * complete harness configured by its own `cordis.yml`.
 *
 * @module @deepseek-ai/dsh-sdk-client
 */

export * from './api.ts'
export * from './client.ts'
export type * from './types.ts'
