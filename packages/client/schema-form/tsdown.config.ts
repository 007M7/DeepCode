import { defineConfig } from 'tsdown'

/**
 * schema-form is browser-only, but its lib bundle is imported under plain
 * Node through consumer lib chains (same posture as ui-primitives). CSS
 * imports are stubbed to empty modules: the hashed class maps only matter in
 * bundler contexts, which compile src directly and never read lib.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [{
    name: 'dsh-css-stub',
    resolveId(source: string) {
      if (!source.endsWith('.css')) return null
      return `\0dsh-css-stub:${source}.mjs`
    },
    load(id: string) {
      if (!id.startsWith('\0dsh-css-stub:')) return null
      return 'export default {};'
    },
  }],
})
