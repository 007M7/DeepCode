import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

/**
 * Host-only TypeRT contract prepass. The generator and its project references
 * are compiled first; the plugin then analyzes Host source and emits local and
 * Host-for-Client artifacts before either aggregate consumes Remote subpaths.
 */
export default defineConfig({
  workspace: ['packages/typert/generator'],
  entry: ['lib/types/{index,invariant}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
})
