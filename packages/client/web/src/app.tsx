/**
 * Real-UI assembly closure. Runs only after loader.settled(): the whole
 * layout tree hangs off the built-in 'root' slot (ui-layout registers
 * AppFrame there and renders the child slots internally) — the shell's
 * render is the one ctx-level renderSlot call in the program.
 */
import type { ReactNode } from 'react'
import type { Context } from 'cordis'
// Type-only: pulls the runtime's SlotMap declaration merge (the 'root' key) into this program.
import type {} from '@deepseek-ai/dsh-client-runtime/client'

/** Assembly inputs: the settled root ctx plus the loader's module-table read surface. */
export interface AssemblyDeps {
  /** Client root context (all plugin services provided). */
  ctx: Context
  /** Module-table resolver (the loader's require; missing spec = throw). Kept in the seam for future shell needs. */
  requireModule: (spec: string) => unknown
}

/**
 * Build the renderApp factory handed to AppRoot.
 * @param deps - assembly inputs.
 * @returns factory producing the real UI tree (called once per AppRoot render after settled).
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  return () => ctx.slots.renderSlot('root', {})
}
