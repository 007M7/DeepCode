/** Test-owned Remote face: `$on` subscriptions driven by the internal forwarded-event plumbing. */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Remote service test double for the forwarded-event path. Feature specs need
 * `ctx.remote.$on` to exist (their plugins inject `remote`) and need forwarded
 * host events to reach those subscribers, but not the generated namespaces or
 * the wire — so this double implements subscription and dispatch only.
 *
 * Dispatch is driven the same way production drives it: by the internal
 * `remote/host-event` event the connection sink emits. A spec therefore
 * exercises its refresh chains with `ctx.emit('remote/host-event', name, args)`,
 * the exact signal `client/runtime` republishes from a `host/remote-event`
 * frame, rather than reaching into this double.
 *
 * `$mount` rejects: a spec that reaches a generated namespace through this
 * double has outgrown it and needs the real Client Remote service.
 */
export class TestRemote {
  private readonly subscriptions = new Map<string, Set<(...args: never[]) => void>>()

  /**
   * Register the double as `ctx.remote` and bind its dispatch to the plumbing event.
   * @param ctx - the spec's root Context.
   */
  constructor(ctx: Context) {
    ctx.provide('remote', this)
    ctx.on('remote/host-event', (event, args) => {
      const listeners = this.subscriptions.get(event)
      if (listeners === undefined) return
      for (const listener of [...listeners]) listener(...args as never[])
    })
  }

  /**
   * Subscribe to one forwarded host event.
   * @param event - forwarded host event name.
   * @param listener - receives the Host argument list verbatim.
   * @returns disposer removing this subscription.
   */
  $on(event: string, listener: (...args: never[]) => void): () => void {
    const listeners = this.subscriptions.get(event) ?? new Set()
    this.subscriptions.set(event, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /**
   * Generated-namespace mount, unsupported by this double.
   * @returns never; always rejects.
   */
  $mount(): Promise<() => Promise<void>> {
    return Promise.reject(new Error('TestRemote: $mount needs the real Client Remote service'))
  }
}
