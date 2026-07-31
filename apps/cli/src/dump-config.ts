/**
 * `dsh --dump-config` / `dsh web --dump-config` — print the composed config
 * tree without booting: the shipped base, the surface overlay, and (unless
 * `--dump-default-config`) the `--config` or personal overlay, composed
 * through the include's own patch algorithm so the printed tree is exactly
 * what that surface would mount. `!!js` expressions print verbatim,
 * unevaluated — the dump shows composition, not one process's environment.
 * Launcher-provided boot-context values (session identity, CLI-flag patches)
 * are per-invocation facts outside the config tree and do not appear.
 * @module @deepseek-ai/dsh/dump-config
 */

import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadOverlayPatches,
  loadPersonalPatches,
  PERSONAL_CONFIG_FILENAME,
  renderConfigDump,
  type ConfigDumpLayer,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-paths'

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
 * @param defaultOnly - stop at the surface overlay (no `--config`/personal layer).
 * @param config - the `--config` overlay path composed instead of the personal
 * one, or `undefined` to use `$DSH_HOME/config.yaml`.
 */
export function runDumpConfig(surface: 'tui' | 'web', defaultOnly: boolean, config?: string): void {
  const overlay = SURFACE_OVERLAYS[surface]
  const layers: ConfigDumpLayer[] = [
    { label: basename(overlay), patches: loadOverlayPatches(NAME, overlay) },
  ]
  if (!defaultOnly) {
    if (config === undefined) {
      const personal = loadPersonalPatches(NAME)
      // The personal file may be absent; the shipped layers still print.
      if (personal !== undefined) {
        layers.push({ label: join(resolveDshHome(), PERSONAL_CONFIG_FILENAME), patches: personal })
      }
    } else {
      layers.push({ label: config, patches: loadOverlayPatches(NAME, config) })
    }
  }
  process.stdout.write(renderConfigDump(NAME, BASE_CONFIG, layers))
}
/* v8 ignore stop */
