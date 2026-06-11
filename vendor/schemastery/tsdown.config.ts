import { defineConfig } from 'tsdown'

/**
 * schemastery has no `"type": "module"` and publishes dual-format output
 * (package.json: main → lib/index.cjs, module → lib/index.mjs). Pin the
 * extensions explicitly — the defaults for a CommonJS package would emit
 * .mjs/.js instead.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'es2024',
  outExtensions: ({ format }) => ({ js: format === 'es' ? '.mjs' : '.cjs' }),
  dts: false,
  clean: false,
})
