/** Internal identity shared by the independently bundled loop and invariant companion. */

const LOOP_REQUEST = Symbol.for('@deepseek-ai/dsh-agent-loop/request')

/**
 * Mark a request as owned by the agent loop before it is frozen.
 * @param request - mutable request object being assembled by the loop.
 * @returns the same request with a non-enumerable loop identity.
 */
export function markLoopRequest<T extends object>(request: T): T {
  Object.defineProperty(request, LOOP_REQUEST, { value: true })
  return request
}

/**
 * Test whether a request carries the agent loop's internal identity.
 * @param request - request observed at the LLM stream boundary.
 * @returns whether the loop marked this exact request object.
 */
export function isLoopRequest(request: object): boolean {
  return Reflect.get(request, LOOP_REQUEST) === true
}
