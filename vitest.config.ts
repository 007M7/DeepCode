import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const windowsUnsupportedPackages = process.platform === 'win32'
  ? [
      'packages/bash/*',
      'packages/hooks/*',
      'packages/sandbox/sandbox-local',
      'packages/sdk/create-sdk',
      'packages/sdk/helper',
    ]
  : []

// These files retain 100% per-file coverage on POSIX, where their process-pipe and terminal timing
// tests are deterministic; Windows skips those cases and must not fail solely on their uncovered paths.
const windowsCoverageExclusions = process.platform === 'win32'
  ? [
      'packages/lsp/lsp-local/src/connection.ts',
      'packages/lsp/lsp-local/src/index.ts',
      'packages/lsp/lsp-local/src/instance.ts',
      'packages/ui/tui/src/index.ts',
    ]
  : []

const testIncludes = [
  'packages/*/*/tests/**/*.spec.{ts,tsx}',
  'examples/*/tests/**/*.spec.ts',
  'scripts/**/*.spec.ts',
]

// These suites exercise process-global state, process APIs, or timing-sensitive process I/O
// that worker threads cannot isolate reliably under aggregate gate contention.
// Keep the narrow exception in forks while the rest of the inventory avoids per-file processes.
const processBoundTests = [
  'packages/bash/bash-local/tests/run.spec.ts',
  'packages/context/time-context/tests/time-context.spec.ts',
  'packages/llm/llm-pi-ai/tests/adapter.spec.ts',
  'packages/ui/app-boot/tests/app-boot.spec.ts',
  'packages/workflow/workflow-workerthread/tests/session.spec.ts',
]

export default defineConfig({
  // Native path resolution reads each package's nearest tsconfig, but only the root defines
  // workspace paths. Keep this plugin pinned to the root map so bare package imports resolve
  // to source — with built lib/ present, manifest-exports fallthrough would load a second
  // copy of module singletons. tsconfig.vitest.json widens include to .tsx specs (the root
  // include stops at .ts for tsc -b; the plugin scopes applicability by include).
  plugins: [tsconfigPaths({ projects: ['./tsconfig.vitest.json'] })],
  test: {
    setupFiles: ['./scripts/test-invariants.ts'],
    // .tsx: client component specs (jsdom via per-file @vitest-environment pragma).
    include: testIncludes,
    exclude: windowsUnsupportedPackages.map(path => `${path}/tests/**/*.spec.ts`),
    // One coverage invocation aggregates both projects. Most suites use threads
    // for lower startup/IPC overhead; only explicit process-bound suites fork.
    projects: [
      {
        plugins: [tsconfigPaths({ projects: ['./tsconfig.vitest.json'] })],
        test: {
          name: 'thread-safe',
          pool: 'threads',
          setupFiles: ['./scripts/test-invariants.ts'],
          include: testIncludes,
          exclude: [
            ...windowsUnsupportedPackages.map(path => `${path}/tests/**/*.spec.ts`),
            ...processBoundTests,
          ],
        },
      },
      {
        plugins: [tsconfigPaths({ projects: ['./tsconfig.vitest.json'] })],
        test: {
          name: 'process-bound',
          pool: 'forks',
          setupFiles: ['./scripts/test-invariants.ts'],
          include: processBoundTests,
          exclude: windowsUnsupportedPackages.map(path => `${path}/tests/**/*.spec.ts`),
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Coverage measures OUR runtime source. Types-only files carry no
      // executable code; vendor/ and examples/ are out of scope (examples are
      // exercised by the demo smoke test instead).
      // .tsx: client components are gated like everything else (jsdom lane).
      include: ['packages/*/*/src/**/*.{ts,tsx}'],
      // Types-only files have no runtime coverage. Importing self-executing bins/workers would boot
      // them inside the unit process, so real subprocess/Worker tests cover their thin entry glue.
      exclude: [
        'packages/*/*/src/types.ts',
        'packages/*/*/src/bin.ts',
        'packages/*/*/src/worker.ts',
        // GUI step-1 skeleton (PR #500): client/web UI files whose remaining
        // branches need a browser-grade harness the jsdom lane doesn't cover
        // yet. TODO(gui): cover and remove as the client test lane matures.
        'packages/client/ui-trajectory/src/*',
        'packages/client/web-react/src/*',
        'packages/host/webserver/src/*',
        ...windowsUnsupportedPackages.map(path => `${path}/src/**/*.ts`),
        ...windowsCoverageExclusions,
      ],
      // 100% or it doesn't merge (docs/testing.md: excessive tests are welcome).
      // Per-file so a well-covered big file can't subsidize a bare one.
      // Every v8 ignore comment must carry a reason — see the quality-gates Agent Note
      // (.agents/notes/implemented/process/2026-06-11-quality-gates.md).
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
