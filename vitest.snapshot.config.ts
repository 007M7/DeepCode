import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Snapshot tests: `pnpm run test:snapshot`, file pattern *.snapshot.ts.
// REPLAY by default — they boot the real acp-agent subprocess against a
// recorded session JSONL fixture (no API key, no network) and diff the
// normalized stdout transcript + re-persisted log against committed goldens.
// `pnpm run test:snapshot:record` (DSH_SNAPSHOT=record + -u) re-records the
// fixtures against the real API and refreshes the goldens.
// `pnpm run test:snapshot:refresh` (DSH_SNAPSHOT=refresh) stays keyless: it
// replays the committed model scripts and writes the current stdout/log goldens
// without calling the live LLM.
//
// Replay loads no .env (it must never reach the network — a recorded fixture
// drives the model), and refresh uses that same keyless replay path. Record
// reads DEEPSEEK_API_KEY from the env or a gitignored repo-root .env, so a
// contributor with a key only in .env can still record.
if (process.env.DSH_SNAPSHOT === 'record') {
  try {
    process.loadEnvFile(new URL('.env', import.meta.url).pathname)
  } catch (error) {
    // ENOENT (no .env) is fine — the key may already be in the environment.
    // Surface any other failure rather than silently recording with wrong env.
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
}

export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the root tsconfig paths map; the native option cannot do this.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })],
  test: {
    include: ['examples/*/tests/**/*.snapshot.ts'],
    // Each test boots a subprocess; give it room, and run files one at a time
    // (a record run hits the live API, and replay subprocess boot is heavy).
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
