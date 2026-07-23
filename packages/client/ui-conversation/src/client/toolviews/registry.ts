/**
 * ToolViewRegistry: named per-tool component registry, session-scope aware
 * (api-contracts v3 section 7). Consumed by chat now, trajectory/waterfall
 * later — deliberately a named service, not a SlotMap key. The tool key set
 * is deliberately open (model-side tools arrive at runtime): the strong
 * typing lives inside the Entry — `I` is inferred from the inject factory at
 * the register site and proves component props ⊇ ToolViewProps & I.
 */
import type { FC } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ResolvedToolView, ToolViewOptions, ToolViewProps } from '../contract/toolview.ts'

/** Stored registration: the per-registration inject parameter is erased
 *  (storage-erase/read-restore is the typed-Map boundary, one cast budgeted). */
interface Registration extends ToolViewOptions {
  component: FC<ToolViewProps & object>
}

/**
 * Per-tool renderer registry. Resolution order: scope match (later
 * registration wins) > global (same tie-break) > undefined, where the caller
 * falls back to GenericToolCard.
 */
export class ToolViewRegistry {
  private byTool = new Map<string, Registration[]>()
  private version = 0
  private listeners = new Set<() => void>()

  /**
   * Register a tool row renderer. The component must accept the shared
   * ToolViewProps plus its own injected share `I` — mismatches (missing keys,
   * wrong types, an inject factory that does not produce what the component
   * declares) are register-site compile errors.
   * @param tool - tool name the renderer takes over.
   * @param component - row component over ToolViewProps & I.
   * @param opts - optional session-scope filter and private inject factory.
   * @returns disposer removing this registration.
   */
  register<I extends object = object>(
    tool: string, component: FC<ToolViewProps & I>, opts?: ToolViewOptions<I>): () => void {
    const list = this.byTool.get(tool) ?? []
    if (list.length === 0) this.byTool.set(tool, list)
    // Storage erases I (heterogeneous registrations share one list); resolve
    // restores the erased shape on the read face.
    const entry: Registration = { component: component as FC<ToolViewProps & object>, ...opts }
    list.push(entry)
    this.bump()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const at = list.indexOf(entry)
      /* v8 ignore next -- negative arm: an entry lives in one list and only its
         own once-guarded disposer removes it, so a live disposer always finds it. */
      if (at >= 0) list.splice(at, 1)
      if (list.length === 0) this.byTool.delete(tool)
      this.bump()
    }
  }

  /**
   * Resolve the renderer for a tool in a session.
   * @param tool - tool name.
   * @param sessionId - session the row renders in (fed to scope filters).
   * @returns resolved view, or undefined when nothing matches.
   */
  resolve(tool: string, sessionId: SessionId): ResolvedToolView | undefined {
    const list = this.byTool.get(tool)
    if (list === undefined) return undefined
    let global: Registration | undefined
    let scoped: Registration | undefined
    for (const entry of list) {
      if (entry.scope === undefined) global = entry
      else if (entry.scope(sessionId)) scoped = entry
    }
    const hit = scoped ?? global
    if (hit === undefined) return undefined
    return hit.inject === undefined ? { component: hit.component } : { component: hit.component, inject: hit.inject }
  }

  /**
   * Subscribe to registration changes (render outlets re-resolve on notify).
   * @param fn - change listener.
   * @returns disposer.
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Monotonic registration version for uSES getSnapshot.
   * @returns current version.
   */
  getVersion(): number {
    return this.version
  }

  private bump(): void {
    this.version += 1
    for (const fn of this.listeners) fn()
  }
}
