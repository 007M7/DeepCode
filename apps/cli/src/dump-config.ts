/**
 * `dsh --dump-config` / `dsh web --dump-config` — print the composed config
 * tree without booting: the shipped base, the surface overlay, and (unless
 * `--dump-default-config`) any `--config` overlay, composed
 * through the include's own patch algorithm so the printed tree is exactly
 * what that surface would mount. `!!js` expressions print verbatim,
 * unevaluated — the dump shows composition, not one process's environment.
 * Launcher-provided boot-context values (session identity, CLI-flag patches)
 * are per-invocation facts outside the config tree and do not appear.
 * @module @deepseek-ai/dsh/dump-config
 */

import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadOverlayPatches,
  renderConfigDump,
  type ConfigDumpLayer,
} from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh'

const BASE_CONFIG = fileURLToPath(new URL('../config/base.cordis.yml', import.meta.url))
const SURFACE_OVERLAYS = {
  tui: fileURLToPath(new URL('../config/tui.cordis.yml', import.meta.url)),
  web: fileURLToPath(new URL('../config/web.cordis.yml', import.meta.url)),
} as const

/* v8 ignore start -- composition over the unit-tested renderConfigDump; the
   built-bin e2e drives this path end to end */
/**
 * Print one surface's composed config tree to stdout, with a comment
 * separator naming the file each section of rows comes from (and the layers
 * that patched it).
 * @param surface - which surface overlay to compose over the shared base.
 * @param defaultOnly - stop at the surface overlay (no `--config` layer).
 * @param config - the `--config` overlay path to compose over the shipped
 * tree, or `undefined` for the shipped composition alone.
 */
export function runDumpConfig(surface: 'tui' | 'web', defaultOnly: boolean, config?: string): void {
  const overlay = SURFACE_OVERLAYS[surface]
  const layers: ConfigDumpLayer[] = [
    { label: basename(overlay), patches: loadOverlayPatches(NAME, overlay) },
  ]
  if (!defaultOnly && config !== undefined) {
    layers.push({ label: config, patches: loadOverlayPatches(NAME, config) })
  }
  process.stdout.write(renderConfigDump(NAME, BASE_CONFIG, layers))
}
/* v8 ignore stop */
