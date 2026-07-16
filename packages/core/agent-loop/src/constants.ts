/**
 * Loop-level tunable defaults shared between the plugin entry (`index.ts`) and
 * the tool-call scheduler (`tool-calls.ts`). Kept in a leaf module so importing
 * a default never pulls in the service class or the scheduler.
 *
 * @module dsh-agent-loop/constants
 */

/**
 * Default cap on simultaneously in-flight tool calls within one assistant step
 * when the agent-loop config omits one. Matches the rolling-pool size Claude
 * Code uses; a larger group is not truncated — the cap limits concurrency, not
 * the group.
 */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10
