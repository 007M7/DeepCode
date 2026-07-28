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

// Replay is the keyless default: boot real subprocess paths from recorded model responses and diff
// assembled requests, normalized protocol or transcript output, and persisted-log expected outputs.
// `record` calls the real API and updates fixtures and expected outputs; `refresh` replays committed scripts
// and updates current expected outputs. Replay/refresh never load `.env`; only record reads a key from the
// environment or root `.env`.
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
  // through the tsconfig.base.json paths facade; the native option cannot do
  // this (the root tsconfig is a solution file with no paths).
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    setupFiles: ['./scripts/test-invariants.ts'],
    include: [
      'scripts/**/*.snapshot.ts',
      // The assembled Web snapshot executes generated client bundles; source
      // mode remains the zero-build path, while lib mode requires a prior build.
      ...(process.env.DSH_EXAMPLE_MODE === 'lib' ? ['apps/web/tests/**/*.snapshot.ts'] : []),
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
