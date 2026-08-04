/**
 * Config-dump entry for raw `dsh --config` and `dsh web`: compose through the
 * include plugin's patch algorithm without booting or evaluating `!!js`.
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
const WEB_OVERLAY = fileURLToPath(new URL('../config/web.cordis.yml', import.meta.url))

/* v8 ignore start -- built-bin acceptance drives this boot-free dispatch */
/**
 * Print a raw or Web composition with provenance comments.
 * @param surface - raw base-plus-config composition, or the Web composition.
 * @param defaultOnly - omit the explicit user layer.
 * @param config - explicit overlay path; required for a non-default raw dump.
 */
export function runDumpConfig(surface: 'config' | 'web', defaultOnly: boolean, config?: string): void {
  const layers: ConfigDumpLayer[] = []
  if (surface === 'config') {
    if (!defaultOnly) {
      /* v8 ignore next -- parseDshArgs requires this combination */
      if (config === undefined) throw new Error('dsh: raw config dump requires an overlay')
      layers.push({ label: config, patches: loadOverlayPatches(NAME, config) })
    }
  } else {
    layers.push({ label: basename(WEB_OVERLAY), patches: loadOverlayPatches(NAME, WEB_OVERLAY) })
    if (!defaultOnly && config !== undefined) {
      layers.push({ label: config, patches: loadOverlayPatches(NAME, config) })
    }
  }
  process.stdout.write(renderConfigDump(NAME, BASE_CONFIG, layers))
}
/* v8 ignore stop */
