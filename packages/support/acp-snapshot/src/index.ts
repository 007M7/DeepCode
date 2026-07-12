/**
 * ACP snapshot suite kit — the shared machinery behind the keyless snapshot
 * tier (`pnpm run test:snapshot`). Three layers, composable per example:
 * the subprocess scenario harness ({@link runScenario}), the pure golden
 * normalizers ({@link normalizeStdout} / {@link normalizeSessionLog} /
 * {@link scrubRequestHeaders} / {@link scrubSystemPrompts}), and the suite factory
 * ({@link defineAcpSnapshotSuite}) that registers a scenario table as a full
 * describe/it tree. An example's `*.snapshot.ts` supplies only its
 * {@link AgentUnderTest} paths, its snapshots directory, and its
 * {@link Scenario} table.
 *
 * NOTE: ./suite.ts imports vitest, so this package is importable only inside a
 * vitest run — a support-tier constraint stated in the README.
 *
 * @module @deepseek-ai/dsh-acp-snapshot
 */

export {
  runScenario,
  type AgentUnderTest,
  type HarvestedLog,
  type InputScript,
  type InputStep,
  type PermissionAnswer,
  type RunOptions,
  type RunResult,
} from './harness.ts'
export {
  normalizeSessionLog,
  normalizeStdout,
  scrubRequestHeaders,
  scrubSystemPrompts,
  type NormalizeContext,
} from './normalize.ts'
export {
  defineAcpSnapshotSuite,
  type Scenario,
  type SnapshotSuiteOptions,
} from './suite.ts'
