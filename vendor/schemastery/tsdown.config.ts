import { defineConfig } from 'tsdown'

/**
 * schemastery has no `"type": "module"` and publishes dual-format output
 * (package.json: main → lib/index.cjs, module → lib/index.mjs). The entry is
 * the JS emitted by tsc under lib/types; pin the bundled extensions
 * explicitly because the defaults for a CommonJS package would emit .mjs/.js.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'es2024',
  outExtensions: ({ format }) => ({ js: format === 'es' ? '.mjs' : '.cjs' }),
  dts: false,
  clean: false,
})
