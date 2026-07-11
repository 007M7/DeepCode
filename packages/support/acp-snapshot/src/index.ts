/**
 * ACP snapshot suite kit — the shared machinery behind the keyless snapshot tier (`pnpm run
 * test:snapshot`).
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
