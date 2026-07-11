import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Snapshot tests: `pnpm run test:snapshot`, file pattern *.snapshot.ts.
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
