/**
 * Adaptive chooser of the directory-picker seam: resolves the host's
 * situation once at boot (bind host, SSH launch, display session) and mounts
 * the matching dual-face backend — `-native` or `-browse` — as a real Loader
 * entry in the in-memory root tree. Because the backend arrives as an
 * ordinary entry, its browser half is discovered exactly as a config-row's
 * would be, so the seam's one-row-swaps-both-faces invariant holds for the
 * resolved choice; pinning an interaction remains composing that backend row
 * directly instead of this one.
 * @module @deepseek-ai/dsh-host-directory-picker-auto
 */

import type { Context } from 'cordis'
// Empty type imports carry the `loader` and `httpServer` Context merges for the reads below.
import type {} from '@cordisjs/plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DirectoryPickerBackendKind } from './resolve.ts'
import { resolveDirectoryPickerBackend } from './resolve.ts'

export type { DirectoryPickerBackendKind, DirectoryPickerEnv, DirectoryPickerHostFacts } from './resolve.ts'
export { resolveDirectoryPickerBackend } from './resolve.ts'

/** Cordis plugin name. */
export const name = 'directory-picker-auto'
/** Required services: the effective bind host (`httpServer`) and the entry tree the backend mounts into (`loader`). */
export const inject = ['httpServer', 'loader']

/** Backend package per resolved kind — fixed composition vocabulary, not a tunable. */
const BACKEND_PACKAGES: Record<DirectoryPickerBackendKind, string> = {
  native: '@deepseek-ai/dsh-host-directory-picker-native',
  browse: '@deepseek-ai/dsh-host-directory-picker-browse',
}

/**
 * Resolve the backend from one boot-time sample and mount it as a Loader
 * entry; the effect's disposer removes the entry, so unloading this plugin
 * unloads both faces of the mounted backend with it.
 * @param ctx - cordis context carrying the injected `httpServer` and `loader`.
 */
export async function apply(ctx: Context): Promise<void> {
  const backend = resolveDirectoryPickerBackend({
    bindHost: ctx.httpServer.host,
    platform: process.platform,
    env: process.env,
  })
  await ctx.effect(async () => {
    // Root-tree create: the Loader root is in-memory (write() is a no-op), so
    // the mounted row can never be persisted back into a config file.
    const id = await ctx.loader.create({ name: BACKEND_PACKAGES[backend] })
    return () => { ctx.loader.remove(id) }
  }, 'directory-picker-auto: backend entry')
}
