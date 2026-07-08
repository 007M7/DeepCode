/**
 * The spill storage seam (`ctx.spillFiles`): an abstract service defining WHAT a
 * spill backend does — persist a tool's oversized text to a session-scoped path
 * the model can later `read` — without saying HOW. Implementations subclass
 * {@link SpillFiles} and register as the `spillFiles` service;
 * `@deepseek-ai/dsh-spill-local` (host filesystem) is the first.
 *
 * The seam is deliberately minimal: `saveText` and nothing else. It owns NO
 * retention policy (that is `@deepseek-ai/dsh-retention`), NO tool-result
 * replacement (that is `@deepseek-ai/dsh-spill-policy`), and NO file inspection
 * (the model uses the existing `read` tool on the returned path). A future
 * remote/virtual backend may return a `spill://…` URI plus a read-only bridge;
 * v1 keeps the path filesystem-shaped until such a backend exists.
 *
 * @module @deepseek-ai/dsh-spill
 */

import { Context, Service } from 'cordis'
import type { SaveTextSpill, SpillRef } from './types.ts'

export { SpillPath } from './types.ts'
export type { SaveTextSpill, SpillOwner, SpillRef, SpillSource } from './types.ts'

declare module 'cordis' {
  interface Context {
    spillFiles: SpillFiles
  }
}

/**
 * Abstract spill storage service. Subclass, implement {@link saveText}, and load
 * the subclass as a plugin — it registers as `ctx.spillFiles` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link saveText} persists the FULL `content` verbatim and returns a path
 *   the local `read` tool can open, plus the exact byte length written.
 * - Storage is scoped by the request's {@link SaveTextSpill.owner} session; the
 *   backend chooses a private (not world-readable) location and a collision-free
 *   name derived from — never equal to — the caller's `suggestedName`.
 * - `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend
 *   unavailable); the caller decides how to degrade (the spill policy treats a
 *   rejection as best-effort and keeps the inline result).
 */
export abstract class SpillFiles extends Service {
  constructor(ctx: Context) {
    super(ctx, 'spillFiles')
  }

  /**
   * Persist `input.content` to a session-scoped spill file.
   * @param input - the owner, provenance, suggested name, and full text to save.
   * @returns the saved file's {@link SpillRef} (path + bytes written); rejects on
   *   a storage failure.
   */
  abstract saveText(input: SaveTextSpill): Promise<SpillRef>
}

export default SpillFiles
