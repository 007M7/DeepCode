import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const STANDALONE_ERROR = 'apps/web is not a standalone application: bare Vite cannot inject window.__DSH_BOOT__. '
  + 'Build with `pnpm run build && pnpm run build:web`, then run `dsh web` (repository checkout: `pnpm run dsh -- web`). '
  + 'For client-plugin HMR, run `pnpm run dsh -- web --dev` together with `pnpm run dev:web`.'

/** Fail before a Vite dev or preview server can expose the boot-manifest-free shell. */
function rejectStandaloneServe(): Plugin {
  return {
    name: 'dsh-reject-standalone-web-serve',
    config(_config, env) {
      if (env.command === 'serve') throw new Error(STANDALONE_ERROR)
    },
  }
}

export default defineConfig({
  plugins: [rejectStandaloneServe(), react()],
  resolve: {
    // Workspace packages resolve to SOURCE: package.json exports point at lib
    // for Node/type consumers, but the browser bundle must compile src directly
    // so CSS rides vite's pipeline instead of the CSS-externalized lib bundle.
    // Only the shell's normal-package surface is aliased — plugin packages are
    // NEVER bundled here (web2 shell self-sufficiency); they arrive as runtime
    // bundles through the client module system. Order matters — subpath
    // aliases must win over bare-name prefixes.
    alias: [
      // Browserization of the vendored cordis Loader: its only node-only
      // import; the two process probes are mapped by `define` below.
      { find: /^node:module$/, replacement: src('./src/node-module-stub.ts') },
      { find: /^@deepseek-ai\/dsh-client-web$/, replacement: src('../../packages/client/web/src/boot.tsx') },
      { find: /^@deepseek-ai\/dsh-client-web-react$/, replacement: src('../../packages/client/web-react/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-slots$/, replacement: src('../../packages/client/ui-slots/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: src('../../packages/client/ui-primitives/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-schema-form$/, replacement: src('../../packages/client/schema-form/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-modules\/client$/, replacement: src('../../packages/client/modules/src/client/index.ts') },
    ],
  },
  define: {
    // vendored loader internal.ts: fromInternal() probes the Node major —
    // "0.0.0" takes neither branch, returning undefined (exactly the empty
    // internal slot the shell boot fills with the client module loader).
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    // vendored loader index.ts: envData falls to its default branch.
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
