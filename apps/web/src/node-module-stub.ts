/**
 * Browser stand-in for `node:module`, mapped by the vite alias in
 * vite.config.ts (design §2.4). The vendored Loader's internal.ts imports
 * `createRequire` at module scope but only calls it inside
 * `ModuleLoader.fromInternal()`, whose version probe is compiled to the
 * `"0.0.0"` define in the browser build — so this throw is a fail-loud
 * tripwire for any path that would genuinely need Node's module machinery.
 */

/** Throwing stand-in for node:module's createRequire (never reached in the browser boot). */
export const createRequire = (): never => {
  throw new Error('node:module is not available in the browser')
}

/** Erased type peer for the vendored loader's type-only LoadHookContext import. */
export type LoadHookContext = never
