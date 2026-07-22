import { availableParallelism } from 'node:os'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const DEFAULT_SNAPSHOT_MAX_CONCURRENCY = 5

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const snapshotMaxConcurrency = positiveIntFromEnv(
  'DSH_SNAPSHOT_MAX_CONCURRENCY',
  Math.min(DEFAULT_SNAPSHOT_MAX_CONCURRENCY, availableParallelism()),
)

// Replay is the keyless default: boot real example subprocesses from recorded model scripts and diff
// normalized protocol or transcript output plus persisted-log expected outputs. `record` calls the real API
// and updates fixtures and expected outputs; `refresh` replays committed scripts and updates current expected outputs.
// Replay/refresh never load `.env`; only record reads a key from the environment or root `.env`.
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
    setupFiles: ['./scripts/test-invariants.ts'],
    include: [
      'examples/*/tests/**/*.snapshot.ts',
      'packages/sdk/*/tests/**/*.snapshot.ts',
      'packages/ui/tui/tests/**/*.snapshot.ts',
    ],
    // Each test boots a subprocess; give it room and keep the worker file singular. Replay tests
    // opt into bounded in-file concurrency, while record/refresh stay serial because they write
    // fixtures. The environment knob restores serial replay with value 1 on constrained machines.
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxConcurrency: snapshotMaxConcurrency,
  },
})
