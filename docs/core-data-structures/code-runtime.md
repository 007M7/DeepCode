# Code Runtime

The code-execution seam — a [capability seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md) whose interface ([dsh-code-runtime](../../packages/code-runtime/code-runtime), `ctx.codeRuntime`) runs one model-written program against host-provided async bindings and reports what it printed and returned. Code execution is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). Backends differ by execution substrate and source language, both readonly descriptors on the service; the worker-thread backend and the tool-registry consumer (Code Mode) are specified in the [Code Mode RFC](../rfc/proposed/feature/2026-06-15-code-mode.md).

Source: [`packages/code-runtime/code-runtime/src/types.ts`](../../packages/code-runtime/code-runtime/src/types.ts)

## The run: request in, result out

A `CodeRunRequest` carries **everything the runtime acts on** — per the "explicit > implicit at package seams" rule, defaulting (time budgets, output caps) is the implementation's validated config, never a hidden `??` inside `run()`:

```ts type-equiv
interface CodeRunRequest {
  /**
   * The program source, in the runtime's {@link ../index.ts | language}. It
   * runs as the body of an async function: top-level `await` and `return`
   * are available, and the completion value becomes
   * {@link CodeRunResult.value}.
   */
  program: string
  /** Host functions exposed to the program, one global object per namespace. */
  bindings: CodeBindingNamespace[]
  /**
   * Abort the run: the runtime stops the program (hard, even mid-loop) and
   * resolves with a {@link CodeRunFailure} of kind `'abort'`. In-flight
   * binding calls are the CALLER's to settle — the runtime only stops asking.
   */
  signal?: AbortSignal
}
```

The result reports an error as a **field**, never a rejection of `run()` — reporting a failed program is the caller's job, not an exception path (mirroring `BashExecutor.run`'s resolve-on-failure contract):

```ts type-equiv
interface CodeRunResult {
  /**
   * The program's completion value (its top-level `return`), when it ran to
   * completion and the value survived the runtime's serialization boundary;
   * a non-transferable value is replaced by a string rendering, and a failed
   * or value-less run leaves this absent.
   */
  value?: unknown
  /** Everything the program emitted, in order (capped by the implementation). */
  logs: CodeLogEntry[]
  /** Present iff the run failed; see {@link CodeRunFailure} for the taxonomy. */
  error?: CodeRunFailure
}
```

## Bindings: host functions as program globals

Each `CodeBindingNamespace` becomes one global object of async callables inside the program (the Code Mode consumer passes one: `tools`). Arguments and resolutions must be structured-cloneable — a runtime may bridge calls across a serialization boundary — and a runtime treats binding names as hostile input (`__proto__` is an ordinary own property, never a prototype collision):

```ts type-equiv
interface CodeBindingNamespace {
  /** The global identifier the program sees (must be a valid JS identifier). */
  global: string
  /** The callable members, keyed by the exact name the program calls. */
  functions: Record<string, CodeBindingFunction>
}
```

```ts type-equiv
type CodeBindingFunction = (args: unknown) => Promise<unknown>
```

## Captured output and the failure taxonomy

Logs arrive in emission order, attributed to their channel (the runtime's `console` shim, or stray writes to the underlying streams):

```ts type-equiv
interface CodeLogEntry {
  /** Which channel produced the text. */
  source: 'console' | 'stdout' | 'stderr'
  /** The console method used; present only when `source` is `'console'`. */
  level?: 'log' | 'info' | 'warn' | 'error' | 'debug'
  /** The captured text (possibly truncated by the implementation's caps, marked in-band). */
  text: string
}
```

Failure kinds are **orthogonal outcomes reported independently** (per [defensive-patterns](../defensive-patterns.md)): a budget expiry is not an exception, an abort is not a timeout, and a substrate death (e.g. OOM) is neither:

```ts type-equiv
interface CodeRunFailure {
  /** The failure class (see the interface doc for each kind's meaning). */
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit'
  /** Human-readable detail, suitable for feeding back to a model to self-correct. */
  message: string
}
```

## The service

`CodeRuntime` (`ctx.codeRuntime`, abstract — defined in [`packages/code-runtime/code-runtime/src/index.ts`](../../packages/code-runtime/code-runtime/src/index.ts)) is `run(request)` plus two readonly descriptors: `language` (what the program must be written in — `'typescript'` is the well-known value; a consumer generating language-specific presentation switches on it and fails loud on one it cannot present) and `isolation` (the execution substrate — `'worker-thread'`, `'process'`, `'container'`; a diagnostic label, **not a security claim**). Implementations must keep runs isolated from each other (no cross-run state) and dispose to quiescence: in-flight runs are terminated and awaited before teardown completes.
