/**
 * Pure-type client outlet of the title domain: the ONE home of the `title`
 * projection-key declaration, importable from client aggregates without
 * dragging this package's host-side value imports (cordis service,
 * schemastery, the llm seam). The host entry (`index.ts`) imports this module
 * type-only to reuse the same merge — one declaration serves both program
 * sides.
 *
 * @module @deepseek-ai/dsh-session-title/client/types
 */

// Marks this file a module so the declaration below AUGMENTS the projection
// table instead of declaring an ambient module.
export {}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current normalized title — the latest `session/title`
     * event's text (last-wins), or `null` before the first title lands. A
     * plain string: the shape the client list rows consume.
     */
    title: string | null
  }
}
