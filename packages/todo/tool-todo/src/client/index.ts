/**
 * Browser half-entry of the todo domain: a pure re-export of the package's
 * types outlet. Client code imports ONLY the client namespace (repo
 * discipline), so `./client/types` projects the same single-source content
 * `./types` serves to host consumers — zero duplication.
 *
 * @module @deepseek-ai/dsh-tool-todo/client/types
 */

export type * from '../types.ts'
