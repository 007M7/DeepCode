import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Vite ≥8 warns that this plugin can be replaced by the native (experimental)
  // `resolve.tsconfigPaths: true`.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })],
  test: {
    include: ['packages/*/*/tests/**/*.spec.ts', 'examples/*/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // Coverage measures OUR runtime source. Types-only files carry no
      // executable code; vendor/ and examples/ are out of scope (examples are
      // exercised by the demo smoke test instead).
      include: ['packages/*/*/src/**/*.ts'],
      // Self-executing bins and workers are covered by subprocess tests outside v8 collection.
      exclude: ['packages/*/*/src/types.ts', 'packages/*/*/src/bin.ts', 'packages/*/*/src/worker.ts'],
      // 100% or it doesn't merge (docs/testing.md: excessive tests are welcome).
      // Per-file so a well-covered big file can't subsidize a bare one.
      // Every v8 ignore comment must carry a reason — see the quality-gates RFC
      // (docs/rfc/implemented/process/2026-06-11-quality-gates.md).
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: process.env.CI ? ['text'] : ['text', 'html'],
    },
  },
})
