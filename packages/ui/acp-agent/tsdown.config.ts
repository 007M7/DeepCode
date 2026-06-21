import { defineConfig } from 'tsdown'

/**
 * acp-agent ships TWO entries: the plugin (`index`) and the CLI `bin` (`bin`),
 * the latter referenced by package.json `bin`/`exports["./bin"]`. The root
 * tsdown builds only `src/index.ts`, so this override adds `bin.ts`.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
