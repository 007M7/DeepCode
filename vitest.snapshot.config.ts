import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Snapshot tests: `pnpm run test:snapshot`, file pattern *.snapshot.ts.
// REPLAY by default — they boot the real acp-agent subprocess against a
// recorded session JSONL fixture (no API key, no network) and diff the
// normalized stdout transcript + re-persisted log against committed goldens.
// `pnpm run test:snapshot:record` (DSH_SNAPSHOT=record + -u) re-records the
// fixtures against the real API and refreshes the goldens.
//
// Replay loads no .env; record reads DEEPSEEK_API_KEY from the env or a
// gitignored repo-root .env (loaded here, mirroring the e2e config), so a
// contributor with a key only in .env can still record.
try {
  process.loadEnvFile(new URL('.env', import.meta.url).pathname)
} catch {
  // No .env — fine; replay needs no key and record reads it from the env.
}

export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the root tsconfig paths map; the native option cannot do this.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.test.json'] })],
  test: {
    include: ['examples/*/tests/**/*.snapshot.ts'],
    // Each test boots a subprocess; give it room, and run files one at a time
    // (a record run hits the live API, and replay subprocess boot is heavy).
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
