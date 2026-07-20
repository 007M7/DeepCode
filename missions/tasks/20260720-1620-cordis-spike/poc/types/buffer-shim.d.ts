/**
 * Minimal ambient Buffer so cosmokit's `typeof Buffer !== 'undefined'` runtime
 * guards type-check without admitting @types/node into the browser program.
 */
declare var Buffer:
  | { from(...args: unknown[]): Uint8Array & { toString(encoding?: string): string } }
  | undefined
