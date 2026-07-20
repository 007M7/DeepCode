/**
 * Real-repo probe: `import type` from apiproxy's /api subpath. Its closure
 * reaches the dsh-session and dsh-llm BARRELS (augmentations + node: imports).
 * Kept in client naming for the gate-api symbol-tracing demo: the gate must
 * attribute each of the leaked keys to its source file.
 */
import './client-main.ts'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'

export type ProbeSessions = ApiProxy['sessions']
