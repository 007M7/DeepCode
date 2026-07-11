/**
 * Code-execution seam for running one model-written program against host bindings.
 * @module @deepseek-ai/dsh-code-runtime
 */

import { Context, Service } from 'cordis'
import type { CodeRunRequest, CodeRunResult } from './types.ts'

export type {
  CodeBindingFunction,
  CodeBindingNamespace,
  CodeLogEntry,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    codeRuntime: CodeRuntime
  }
}

/**
 * Abstract code-execution service. Subclass, implement {@link run} and the two descriptors,
 * and load the subclass as a plugin — it registers as `ctx.codeRuntime` (one implementation
 * per context; loading a second throws, cordis' standard duplicate-service behavior).
 */
export abstract class CodeRuntime extends Service {
  /**
   * The source language {@link run} expects `program` to be written in, as a
   * lowercase identifier. Informational, not gating — a consumer that
   * generates language-specific presentation (typed SDK stubs, usage
   * instructions) switches on it and fails loud on a language it cannot
   * present. Well-known value: `'typescript'`.
   */
  abstract readonly language: string

  /**
   * The execution substrate, as a lowercase identifier. Informational, not
   * gating — a descriptor so deployments and diagnostics can tell backends
   * apart, not a security claim. Well-known values: `'worker-thread'`,
   * `'process'`, `'container'`.
   */
  abstract readonly isolation: string

  constructor(ctx: Context) {
    super(ctx, 'codeRuntime')
  }

  /**
   * Execute one program against the request's bindings and capture what it
   * emitted. See the class doc for the resolution contract (error is a result
   * field; rejection means seam misuse only).
   * @param request - the program, its bindings, and the abort signal; the
   *   request carries everything the runtime acts on, with no hidden defaults.
   * @returns the run's outcome: completion value (when transferable), the
   *   ordered log capture, and the failure (if any).
   */
  abstract run(request: CodeRunRequest): Promise<CodeRunResult>
}

export default CodeRuntime
