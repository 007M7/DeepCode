/**
 * ACP snapshot suite kit: subprocess scenario harness, pure golden normalizers, and the Vitest
 * suite factory behind `pnpm run test:snapshot`. Because this entry exports `suite.ts`, importing
 * it requires a Vitest run.
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
