import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Vite ≥8 warns that this plugin can be replaced by the native (experimental)
  // `resolve.tsconfigPaths: true`. It cannot — keep the plugin. Tests run
  // unbuilt (see AGENTS.md): bare workspace names like `cordis` or
  // `@deepseek-ai/dsh-llm` must resolve to src/, and the only place that
  // mapping exists is the root tsconfig.json `paths` map inherited by
  // tsconfig.test.json. The native option is a bare boolean: for each
  // importing file it discovers the NEAREST tsconfig.json and applies that
  // file's own `paths`. Every workspace under packages/* and vendor/* has its
  // own tsconfig.json without `paths`, so native resolution maps nothing,
  // falls through to package.json exports (lib/, absent until `pnpm run build`),
  // and every test file fails to import (verified on vite 8.0.16 /
  // vitest 4.1.8). Making it work would mean copying the paths map into all
  // 15 workspace tsconfigs — including vendor/* ones, which are pinned
  // upstream copies (vendor/README.md). The plugin's `projects` option
  // instead applies the one root map to every importer.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.test.json'] })],
  test: {
    include: ['packages/*/*/tests/**/*.spec.ts', 'examples/*/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // Coverage measures OUR runtime source. Types-only files carry no
      // executable code; vendor/ and examples/ are out of scope (examples are
      // exercised by the demo smoke test instead).
      include: ['packages/*/*/src/**/*.ts'],
      exclude: ['packages/*/*/src/types.ts'],
      // 100% or it doesn't merge (AGENTS.md: excessive tests are welcome).
      // Per-file so a well-covered big file can't subsidize a bare one.
      // Every v8 ignore comment must carry a reason — see AGENTS.md.
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: ['text', 'html'],
    },
  },
})
