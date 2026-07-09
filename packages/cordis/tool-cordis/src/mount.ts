/**
 * Dynamic-mount lifecycle over the `cordis-dynamic` group fiber: settle a
 * sandbox-produced plugin as a child fiber (never leaving a failed fiber
 * mounted), and report the services a settled-but-pending fiber still waits
 * for. Disposal needs no helper — a mount unwinds through an ordinary awaited
 * `fiber.dispose()`, because everything the plugin registered is an effect on
 * its fiber.
 *
 * @module @deepseek-ai/dsh-tool-cordis/mount
 */

import type { Context, Fiber, Plugin } from 'cordis'
import { guardedPlugin } from './guard.ts'

/** One tracked dynamic mount: the fiber plus the display name captured at mount time. */
export interface DynamicMount {
  /** The child fiber under the `cordis-dynamic` group. */
  fiber: Fiber
  /** The plugin's display name at mount time (its `name`, else `<anonymous>`). */
  pluginName: string
}

/**
 * Mount a plugin under the group fiber and settle it. The group fiber loads
 * asynchronously right after the owning plugin's `apply`, so it is awaited
 * before hanging a child off its context. The child fiber's `await()` settles
 * its lifecycle work and rethrows a startup error (e.g. a throwing `apply`);
 * on error the fiber is disposed first — a failed mount never lingers.
 * @param group - the `cordis-dynamic` group fiber every mount hangs under.
 * @param plugin - the plugin the sandbox returned; wrapped with the registration guard before mounting.
 * @returns the settled child fiber (possibly pending on unsatisfied `inject`).
 */
export async function mountDynamic(group: Fiber, plugin: Plugin): Promise<Fiber> {
  await group.await()
  const fiber = group.ctx.plugin(guardedPlugin(plugin))
  try {
    await fiber.await()
  } catch (error) {
    await fiber.dispose()
    const message = error instanceof Error ? error.message : String(error)
    // The commonest startup collision is remounting a NEW version of a tool
    // while the old mount still holds the name — teach the replace recipe.
    if (message.includes('already registered')) {
      throw new Error(
        `${message} — to REPLACE something an earlier mount registered, first cordis_unmount that mount's id `
        + '(find it with cordis_inspect what:"dynamic"), then mount the new version.',
      )
    }
    throw error instanceof Error ? error : new Error(message)
  }
  return fiber
}

/**
 * The services a fiber declared in `inject` that do not exist yet — a settled
 * fiber that is not active is waiting on exactly these (legal cordis
 * semantics: it activates when the service appears).
 * @param ctx - the context to resolve service existence against.
 * @param fiber - the mount fiber whose `inject` declarations are checked.
 * @returns the missing service names, in declaration order.
 */
export function missingServices(ctx: Context, fiber: Fiber): string[] {
  return Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
}
