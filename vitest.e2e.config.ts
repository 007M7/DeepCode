import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Real-API end-to-end tests: `yarn test:e2e`, file pattern *.e2e.ts.
// Separate from the default suite (`yarn test`, *.spec.ts) on purpose —
// these hit the live DeepSeek API, spend tokens, and need a key.
//
// Secrets: tests gate themselves with
// `describe.skipIf(!process.env.DEEPSEEK_API_KEY)`, so the suite passes
// (all-skipped) without credentials — CI has none and stays green. Put the
// key in the environment or in a gitignored `.env` at the repo root:
//
//     DEEPSEEK_API_KEY=sk-…
//     DEEPSEEK_BASE_URL=https://…   # optional, defaults to the public API
try {
  // Node >= 21.7 native; throws when the file does not exist.
  process.loadEnvFile(new URL('.env', import.meta.url).pathname)
} catch {
  // No .env — fine, the environment may already carry the variables.
}

export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the root tsconfig paths map; the native option cannot do this.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.test.json'] })],
  test: {
    include: ['packages/*/tests/**/*.e2e.ts', 'examples/*/tests/**/*.e2e.ts'],
    // Real model calls: generous timeouts, one retry for transient flakes,
    // no coverage (unit suites own the coverage gate).
    testTimeout: 120_000,
    hookTimeout: 30_000,
    retry: 1,
  },
})
