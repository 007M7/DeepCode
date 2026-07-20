/**
 * Shared entry of echo-a: cross-side RPC vocabulary. Discipline under test:
 * consumers may only `import type` from this file, and this file's own
 * transitive closure must be free of node-side cordis augmentations.
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

export type EchoRequestId = Branded<'spike.echo-request'>

/** Bidirectional RPC surface declared by the plugin itself (blueprint §6). */
export interface EchoARpc {
  'echo-a/ping'(payload: { id: EchoRequestId; text: string }): Promise<{ id: EchoRequestId; upper: string }>
}
