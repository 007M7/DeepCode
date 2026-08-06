/**
 * Config-dump entry for `dsh --profile <name> --dump-config`: compose the
 * profile's patch layers through the include plugin's patch algorithm without
 * booting or evaluating `!!js`, with one provenance layer per bundle, the
 * profile's own patch file, and each `--patch` overlay.
 * @module @deepseek-ai/dsh/dump-config
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  healProfilesModuleFallback,
  loadOverlayPatches,
  loadProfile,
  renderConfigDump,
  type ConfigDumpLayer,
} from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR } from './profile-boot.ts'

const NAME = 'dsh'

/* v8 ignore start -- built-bin acceptance drives this boot-free dispatch */
/**
 * Print a profile composition with provenance comments.
 * @param profile - the profile name.
 * @param defaultOnly - omit the profile's user layer and `--patch` overlays.
 * @param patches - `--patch` overlay paths, in argv order.
 */
export function runDumpConfig(profile: string, defaultOnly: boolean, patches: readonly string[]): void {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  // The default dump never reads the user layer: it doubles as the recovery
  // diagnostic for a broken cordis.patch.yml, so parsing that file here would
  // defeat its purpose.
  const loaded = loadProfile(NAME, profile, INSTALL_ANCHOR, undefined, { userLayer: !defaultOnly })
  const layers: ConfigDumpLayer[] = loaded.layers.map(layer => ({
    label: layer.packageName,
    patches: layer.patches,
  }))
  if (!defaultOnly) {
    if (existsSync(loaded.patchPath)) {
      layers.push({ label: loaded.patchPath, patches: loaded.patches })
    }
    for (const file of patches) {
      const absolute = resolve(file)
      layers.push({ label: absolute, patches: loadOverlayPatches(NAME, absolute) })
    }
  }
  // renderConfigDump anchors on a base entry-list file; a profile's base is
  // the empty list, materialized as a temp document.
  const emptyRoot = mkdtempSync(join(tmpdir(), 'dsh-dump-'))
  const emptyRootFile = join(emptyRoot, 'profile-root.yml')
  writeFileSync(emptyRootFile, '[]\n')
  try {
    process.stdout.write(renderConfigDump(NAME, emptyRootFile, layers))
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }
}
/* v8 ignore stop */
