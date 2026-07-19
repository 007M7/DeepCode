/**
 * Public Agent execution-context types.
 *
 * @module @deepseek-ai/dsh-agent-execution/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** The exact Agent associated with one asynchronous execution chain. */
export interface AgentExecution {
  readonly agent: Agent
}
