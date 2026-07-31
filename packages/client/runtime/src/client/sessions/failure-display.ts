/**
 * Convert a durable failure into copy that is safe to expose in the GUI.
 * @param failure - Structured failure preserved by the session event.
 * @returns Display-safe copy for client projections.
 */
export function displayFailureMessage(failure: { code?: string; message: string }): string {
  // Provider AUTH messages may echo a masked or partially preserved credential.
  // Keep the raw diagnostic in the session log, but never project it into UI state.
  return failure.code === 'AUTH' ? 'API key is invalid' : failure.message
}
