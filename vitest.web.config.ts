import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Web smoke lane (GUI, gate-exempt — not part of the CI sequence yet): built
// page + real chromium, so it lives outside the unit/e2e includes. The
// real-host test self-skips without DEEPSEEK_API_KEY; the fixture test is
// keyless and deterministic.
try {
  // Node >= 21.7 native; throws when the file does not exist.
  process.loadEnvFile(new URL('.env', import.meta.url).pathname)
} catch {
  // No .env — fine, the environment may already carry the variables.
}

export default defineConfig({
  resolve: {
    alias: {
      // apps/web/tests is outside the root tsconfig include, so the shared
      // tsconfig-paths plugin never maps it; alias the one bare import to source.
      '@deepseek-ai/dsh-host-webserver': fileURLToPath(new URL('packages/host/webserver/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['apps/web/tests/**/*.e2e.ts'],
    // Browser boot + real-model turns are slow; files share one browser, run serial.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
