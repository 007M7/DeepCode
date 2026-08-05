/**
 * @deepseek-ai/dsh-base — the shared dsh core as a profile bundle. The
 * package's substance is `cordis.patch.yml` (declared by the `dsh.patch`
 * manifest field): every profile's first patch layer, inserting the base
 * plugin rows over the empty profile root. This module only names the patch
 * for consumers that need the path programmatically (the profile composer
 * resolves it through the manifest field, not through this export).
 * @module @deepseek-ai/dsh-base
 */

import { fileURLToPath } from 'node:url'

/** Absolute path of this bundle's profile patch. */
export const patchPath: string = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
