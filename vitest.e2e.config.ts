import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

// Real-API suite, separate because it spends tokens. Each test self-skips without
// its provider credential for keyless CI; credentialed workflows preflight the
// secrets they require. Values may come from the environment or gitignored root
// `.env`, with provider-specific endpoint overrides where supported.
try {
  // Node >= 21.7 native; throws when the file does not exist.
  process.loadEnvFile(new URL('.env', import.meta.url).pathname)
} catch {
  // No .env — fine, the environment may already carry the variables.
}

const DEFAULT_E2E_MAX_WORKERS = 4

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const e2eMaxWorkers = positiveIntFromEnv('DSH_E2E_MAX_WORKERS', DEFAULT_E2E_MAX_WORKERS)

export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the root tsconfig paths map; the native option cannot do this.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })],
  test: {
    include: ['packages/*/*/tests/**/*.e2e.ts', 'examples/*/tests/**/*.e2e.ts'],
    // Real model calls: generous timeouts, and retries for transient flakes
    // (the shared internal key hits concurrency quotas). No coverage — the
    // unit suites own the coverage gate.
    testTimeout: 120_000,
    hookTimeout: 30_000,
    retry: 2,
    // Run files in a bounded pool: enough lower-level parallelism to keep CI
    // and local with-key runs moving, while leaving a resource knob for shared
    // API quotas (`DSH_E2E_MAX_WORKERS=1` restores serial execution).
    fileParallelism: e2eMaxWorkers > 1,
    maxWorkers: e2eMaxWorkers,
  },
})
