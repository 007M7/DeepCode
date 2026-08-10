/**
 * The Windows shell platform layer: on win32 hosts the shipped profile
 * compositions swap the POSIX-only bash stack for the sandbox-confined
 * PowerShell stack (`@deepseek-ai/dsh-pwsh-sandbox` +
 * `@deepseek-ai/dsh-tool-pwsh`). The layer is the base bundle's
 * `windows.cordis.patch.yml`, injected by the launcher between the bundle
 * layers and the user layers so a user patch can still override it — the
 * only override channel is composition config, like every other roster
 * decision. POSIX hosts never receive the layer.
 * @module @deepseek-ai/dsh/windows-shell
 */

import { join } from 'node:path'
import type { PatchOptions } from '@cordisjs/plugin-include'
import { loadOverlayPatches, type ProfileLayer } from '@deepseek-ai/dsh-app-boot'

/** The base bundle whose package carries the Windows shell patch. */
export const BASE_BUNDLE = '@deepseek-ai/dsh-base'

/** The Windows shell patch filename inside the base bundle package. */
export const WINDOWS_SHELL_PATCH_FILENAME = 'windows.cordis.patch.yml'

/** One Windows shell platform layer: its patch file and parsed patches. */
export interface WindowsShellLayer {
  /** The patch file path, used as the config-dump provenance label. */
  label: string
  /** The parsed patch entries, applied after the bundle layers. */
  patches: PatchOptions[]
}

/**
 * Resolve the Windows shell platform layer for a profile composition.
 * @param platform - the host platform (`process.platform` at call sites).
 * @param layers - the profile's bundle layers, in application order.
 * @param binName - the diagnostic prefix on thrown errors (`dsh`).
 * @returns the pwsh layer on win32, else `undefined`. A custom profile that
 *   mounts no base bundle is skipped (it owns its shell stack); a base
 *   bundle whose Windows shell patch is missing fails loud in
 *   {@link loadOverlayPatches} — the shipped package always carries it, so
 *   a miss is a broken installation.
 */
export function resolveWindowsShellLayer(
  platform: NodeJS.Platform,
  layers: readonly ProfileLayer[],
  binName: string,
): WindowsShellLayer | undefined {
  if (platform !== 'win32') return undefined
  const base = layers.find(layer => layer.packageName === BASE_BUNDLE)
  if (base === undefined) return undefined
  const label = join(base.packageDir, WINDOWS_SHELL_PATCH_FILENAME)
  return { label, patches: loadOverlayPatches(binName, label) }
}
