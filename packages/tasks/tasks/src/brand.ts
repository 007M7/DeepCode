/**
 * dsh-tasks' owned branded id, carried across the registry, the model-facing
 * control surface, and the client wire.
 *
 * It lives in its own leaf because the package root and `./types` both reach
 * `dsh-agent` through the owner and listener signatures, which a Client program
 * cannot resolve even as a type. A browser-safe consumer imports the id here;
 * `Branded<B>` itself comes from the zero-dependency `@deepseek-ai/dsh-brand`.
 *
 * @module @deepseek-ai/dsh-tasks/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies a background task. The registry generates `<kind>-N`; predictable
 * ids rely on owner authorization rather than secrecy.
 */
export type TaskId = Branded<'TaskId'>

/**
 * Brand a string as a {@link TaskId}.
 * @param id - the raw task-id string (the registry generates `<kind>-N`).
 * @returns the same string, branded; no validation is performed.
 */
export function TaskId(id: string): TaskId {
  return id as TaskId
}
