import type { UserConfig } from 'tsdown'
import { clientBundle } from '../tsdown.client.ts'

/**
 * Standard dual-entry shape plus the loader lib half: exports["./loader"]
 * promises lib/loader.js (the web shell statically imports the machinery —
 * a loader cannot load itself), and the shared preset only emits
 * lib/{index,invariant}.js, so the extra config supplies it.
 */
const configs = clientBundle('@deepseek-ai/dsh-client-runtime', ['lib/types/index.js', 'lib/types/invariant.js'])

const loaderLib: UserConfig = {
  entry: { loader: 'lib/types/client/loader/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default [...configs, loaderLib]
