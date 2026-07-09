/**
 * The code-execution seam (`ctx.codeRuntime`): an abstract service defining
 * WHAT a code runtime does — run one model-written program against a set of
 * host-provided async bindings and report `{ value, logs, error? }` — without
 * saying HOW. Implementations subclass {@link CodeRuntime} and register
 * themselves as the `codeRuntime` service; backends may differ by execution
 * substrate (worker thread, separate process, container) and by source
 * language, both declared as readonly descriptors. The design and its
 * consumer (the tool registry's Code Mode) are specified in the Code Mode RFC
 * (docs/rfc/implemented/feature/2026-06-15-code-mode.md).
 *
 * The split mirrors the bash seam (`BashExecutor`): the runtime knows nothing
 * about tools or sessions — it is handed named async functions and a program,
 * and everything tool-shaped stays with the consumer.
 *
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
 * Abstract code-execution service. Subclass, implement {@link run} and the
 * two descriptors, and load the subclass as a plugin — it registers as
 * `ctx.codeRuntime` (one implementation per context; loading a second throws,
 * cordis' standard duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link run} resolves with an error FIELD for every program outcome —
 *   parse/transform failures, thrown exceptions, budget expiry, abort,
 *   substrate death ({@link CodeRunFailure}'s taxonomy). It REJECTS only for
 *   caller misuse of the seam itself (e.g. a run submitted after disposal).
 * - Binding calls bridge to the caller's {@link CodeBindingFunction}s
 *   verbatim; arguments and resolutions must be structured-cloneable, and the
 *   runtime treats the program as a hostile peer (arbitrary binding names are
 *   own properties, malformed traffic is rejected or ignored, never crashes
 *   the host).
 * - Runs are isolated from each other: no state survives from one run to the
 *   next through the runtime.
 * - Disposal reaches quiescence: in-flight runs are terminated AND awaited
 *   before the service's own teardown completes (no orphan substrate survives
 *   `fiber.dispose()`).
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
