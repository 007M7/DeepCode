import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Workspace packages resolve to SOURCE: package.json exports point at lib
    // for Node/type consumers, but the browser bundle must compile src directly
    // so CSS rides vite's pipeline instead of the CSS-externalized lib bundle.
    // Only the shell's static surface is aliased — UI plugin packages are NOT
    // bundled here; they arrive as dynamic bundles through the client loader.
    // Order matters — subpath aliases must win over bare-name prefixes.
    alias: [
      { find: /^@deepseek-ai\/dsh-client-web$/, replacement: src('../../packages/client/web/src/boot.tsx') },
      { find: /^@deepseek-ai\/dsh-client-web-react\/store$/, replacement: src('../../packages/client/web-react/src/store/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-web-react$/, replacement: src('../../packages/client/web-react/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-slots$/, replacement: src('../../packages/client/ui-slots/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: src('../../packages/client/ui-primitives/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-runtime\/loader$/, replacement: src('../../packages/client/runtime/src/client/loader/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-runtime$/, replacement: src('../../packages/client/runtime/src/index.ts') },
    ],
  },
})
