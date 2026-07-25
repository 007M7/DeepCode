import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Web smoke lane (GUI, gate-exempt — not part of the CI sequence yet): real
// host entry points plus built-client interaction snapshots, outside the
// unit/e2e includes. Real-model cases self-skip without DEEPSEEK_API_KEY;
// fixture branches stay keyless and deterministic.
try {
  // Node >= 21.7 native; throws when the file does not exist.
  process.loadEnvFile(new URL('.env', import.meta.url).pathname)
} catch {
  // No .env — fine, the environment may already carry the variables.
}

export default defineConfig({
  // Same resolution note as vitest.config.ts: the tsconfig.base.json paths
  // facade has no include (match-all), so apps/web/tests resolves bare
  // workspace imports to source like every other lane.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: [
      'apps/web/tests/**/*.e2e.ts',
      'apps/web/tests/**/*.snapshot.ts',
    ],
    // Browser boot + real-model turns are slow; files share one browser, run serial.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
