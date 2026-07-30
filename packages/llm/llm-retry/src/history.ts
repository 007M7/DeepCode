/** Durable request-route lookup for one closed model step. @module @deepseek-ai/dsh-llm-retry/history */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Find the provider in force when one step closed, excluding later recovery mutations.
 * Request headers remain effective across turn boundaries until a newer full
 * snapshot changes them; every provider change requires a newer full snapshot.
 * @param events - session events containing the closed step.
 * @param turn - turn that owns the failed step.
 * @param step - failed step whose provider is required.
 * @returns the provider from the request header in force at that step boundary.
 */
export function providerForClosedStep(
  events: readonly SessionEvent[],
  turn: number,
  step: number,
): string | undefined {
  const stepEndIndex = events.findLastIndex(event =>
    event.type === 'step/end'
    && event.data.turn === turn
    && event.data.step === step,
  )
  if (stepEndIndex < 0) return undefined
  for (let index = stepEndIndex; index >= 0; index -= 1) {
    // The loop bounds prove this indexed read exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (event.type === 'request/header') return event.data.header.config.provider
  }
  return undefined
}
