/** Register source-only tsconfig paths resolution before a TypeScript entry loads. */

import { register } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tsconfigPath = process.env.TSX_TSCONFIG_PATH === undefined
  ? fileURLToPath(new URL('../tsconfig.json', import.meta.url))
  : resolve(process.env.TSX_TSCONFIG_PATH)

register(new URL('../apps/cli/src/tsconfig-paths-loader.ts', import.meta.url), {
  parentURL: import.meta.url,
  data: { tsconfigPath },
})
