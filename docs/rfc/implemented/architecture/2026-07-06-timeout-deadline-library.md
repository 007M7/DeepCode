# RFC: A shared timeout/deadline primitive, with hard-kill left to each capability

Status: implemented

## Problem

Timeout handling was drifting apart across the tool-bearing capabilities, and the divergence was not superficial — it was the same logic re-implemented three ways, each with its own subtle correctness burden.

- **bash** ([packages/bash/bash-local/src/run.ts](../../../../packages/bash/bash-local/src/run.ts)) had a full, correct timeout inside the process plumbing: a config-clamped `timeoutMs`, two independent triggers — a `killTimer` for the timeout and an `onAbort` listener for upstream cancellation — each calling one `kill()` closure that escalates SIGTERM→grace→SIGKILL on the process group, and two orthogonal outcome booleans (`timedOut`, `aborted`) latched independently.
- **web_fetch** ([packages/web/web-fetch-local/src/provider.ts](../../../../packages/web/web-fetch-local/src/provider.ts)) had a correct but *hand-rolled* timeout: it constructed an `AbortController`, wired `setTimeout(() => controller.abort(new WebError(…, 'WEB_FETCH_TIMEOUT')))`, manually added and removed the upstream-signal listener, cleared the timer in a `finally`, and recovered the timeout reason from `signal.reason` in a `translateAbortOrNetwork` helper because the reader surfaces a bare `AbortError`.
- **web_search** ([packages/web/tool-web/src/search.ts](../../../../packages/web/tool-web/src/search.ts)) had **no timeout at all**: `WebSearchRequest` ([packages/web/web/src/types.ts](../../../../packages/web/web/src/types.ts)) carries no `timeoutMs` field, and each provider's `search()` only forwards `exec.signal`. (web_search stays untimed here — see Consequences.)

Each new external-process or network tool re-derived the same four things — clamp the requested value, start a timer, fuse the timeout with upstream cancellation, and distinguish "timed out" from "cancelled" on the way out — and the fusion and reason-recovery are exactly the parts that are easy to get subtly wrong (web_fetch's `signal.reason` dance is evidence). At the same time, the *termination* each performs is irreducibly different: bash kills an OS process group (work runs in a child process, outside this runtime, reachable only by signal), while web aborts an in-process `fetch` (undici tears down the socket). There is no single mechanism that can stop all of them.

The two reference agents surveyed converged on the same split. Codex models "what will end this exec early" as one value (`ExecExpiration`, an enum fusing timeout and a cancellation token) whose `wait_with_outcome()` returns `TimedOut | Cancelled`, while the actual `kill_process_group` lives outside it — and that abstraction is reused *only* across the exec family, with MCP, model-stream, and guardian each keeping their own bespoke `tokio::time::timeout`. Claude Code shares nothing: bash and ripgrep each own a private SIGTERM→SIGKILL kill and distinguish timeout from cancellation by throwing distinct error types, while file I/O has no timeout. Both confirm the boundary drawn here: the timing-and-classification half is worth sharing within a family of like-terminated operations; the termination half is not shareable and stays in each capability.

## Decision

`@deepseek-ai/dsh-timeout` lives under `packages/util/` (peer to `dsh-brand`) and owns the *timing and classification* half of timeout; the *termination* half — the hard kill — stays in each capability's implementation. It is a library of pure functions, **not** a cordis service or plugin: it takes no `ctx`, registers nothing, holds no cross-call state, and emits no events. There is deliberately no central "timeout service" that would have to know how to stop every capability's work — that knowledge is exactly what a microkernel keeps out of shared layers, and what Codex's exec-only `ExecExpiration` scope demonstrates.

### The library surface

Three functions plus one reason type:

```ts ignore-check
/** The internal reason attached to a timeout abort, so consumers can classify it after the fact. */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

/** Validate/fill a caller's optional positive hint from the backend's default, then cap at its max. */
export function clampTimeout(
  requested: number | undefined,
  def: number,
  max: number,
  name = 'timeoutMs',
): number

/**
 * Build a deadline signal that aborts on upstream cancellation OR on timeout,
 * with the timeout carrying a `TimeoutReason`. `timeoutMs <= 0` means "no
 * timeout" (background tasks): forward only the upstream signal, arm no timer.
 * The returned object's `[Symbol.dispose]` clears the timer — `using` for a
 * scope-lifetime consumer, a manual call for an event-lifetime one.
 */
export function deadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): { signal: AbortSignal; [Symbol.dispose](): void }

/** Recover the TimeoutReason from an aborted signal (or error); `code` scopes the match to this deadline's timer. */
export function timeoutOf(x: AbortSignal | { reason?: unknown }, code?: string): TimeoutReason | undefined
```

`deadline` is `AbortSignal.any([upstream, <timeout controller>])` with three things the standard library does not give: a typed, identifiable `TimeoutReason` on the timeout abort (native `AbortSignal.timeout()` yields a fixed `TimeoutError`, indistinguishable across timeout kinds), an internal `timeoutMs <= 0` "no timeout" sentinel for backend-owned background work, and a `Symbol.dispose` cleanup that works with both `using` and manual disposal. `AbortSignal.any` is a Node ≥ 20 primitive; it is the single mechanism that fuses two abort sources into one, adopting the reason of whichever fires first. External request hints validate as positive finite numbers via `clampTimeout` before they reach `deadline`; `0` is not a model-/plugin-facing "disable timeout" value. When `timeoutMs <= 0` and no upstream signal is present, `deadline()` returns a never-aborting signal plus a no-op disposer so callers keep one call shape. `TimeoutReason` is an internal classification reason: providers translate it into seam-specific public errors or result fields before returning to callers. `timeoutOf`'s optional `code` scopes classification to the caller's own deadline: when the `upstream` is itself a deadline (a future `tools/execute` middleware arming a per-call deadline), `AbortSignal.any` preserves the outer `TimeoutReason` if it fires first, and an unscoped match would misreport the outer timeout as the inner capability's own; scoping to `code` reads a foreign timeout as an ordinary upstream cancel.

### The division of labor

| Concern | Owner |
|---|---|
| Validate request hint and clamp default/max | `dsh-timeout` (`clampTimeout`) — pure arithmetic plus the shared positive-finite request contract |
| Arm timer, abort on deadline, carry reason, fuse with upstream cancel | `dsh-timeout` (`deadline`) |
| Clear the timer | `dsh-timeout` (`[Symbol.dispose]`) |
| Classify the first abort reason after abort | `dsh-timeout` (`timeoutOf`) |
| **Actually terminate the work** | the capability's implementation |
| The default/max *values* | the capability's config |
| The timeout `code` string | the capability (`WEB_FETCH_TIMEOUT` ≠ `BASH_TIMEOUT`) |

The signal only *notifies*; termination is always the listener's job, and the listener differs by capability. bash writes its own `addEventListener('abort', kill)` because the OS process lives outside this runtime and nothing else will kill it; web hands `d.signal` to `fetch` and undici tears down the socket. This is why file read/write/edit take **no** `timeoutMs`: a local syscall is best-effort-abortable at most, a timeout could not force `fsync`/`rename` to stop, and adding one would be an implicit default that violates explicit-over-implicit. Both reference agents leave file I/O untimed for the same reason.

### How each capability consumes it

- **web_fetch** — the tool stays validate-and-forward; the provider's hand-rolled controller + `setTimeout` + manual listener + `finally` + `signal.reason` recovery is replaced by provider-owned `deadline`/`timeoutOf`. A pre-aborted upstream signal still throws `WEB_ABORTED` up front; otherwise `fetch` runs against the fused `d.signal`, and `translateAbortOrNetwork` classifies a thrown error by the signal (`timeoutOf` → `WEB_FETCH_TIMEOUT`, else aborted → `WEB_ABORTED`, else network → `WEB_PROVIDER_ERROR`). The public error-code contract is unchanged, and `TimeoutReason` never crosses the web seam as the public error.
- **bash** — `resolve()` stays a pure request-to-spec step: it clamps with `clampTimeout(request.timeoutMs, config.timeoutMs, config.maxTimeoutMs, 'bash-local: request.timeoutMs')` and carries `request.signal` through unchanged. Foreground `run()` owns the timeout: `using d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')`, then `runBash` receives only `d.signal`. `runBash` no longer owns any timer — it listens for abort and runs its existing SIGTERM→grace→SIGKILL process-group kill, and its `SpawnSpec`/`SpawnOutcome` no longer carry `timeoutMs`/`timedOut`/`aborted` (the executor classifies from the deadline signal instead). `run()` computes `timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined` and `aborted = d.signal.aborted && !timedOut`, so the public seam booleans (`BashRunResult.timedOut`/`aborted`) are mutually exclusive — the shared deadline reports the cause that first cut the command short, and the `code` scope keeps a nested outer deadline from being misread as bash's own timeout. Background `start()` creates no deadline and forwards only the upstream signal, so background tasks stay timeout-free; a task's killed-vs-completed status reads its own `spec.signal.aborted`.

## Consequences

- `runBash`'s outcome no longer independently latches `timedOut` and `aborted`; a timeout and a user abort racing before process close now report a single first-abort cause instead of both being true. The uniform SIGTERM→grace→SIGKILL kill is unchanged, and the seam type `BashRunResult` keeps both booleans (now mutually exclusive), so `dsh-tool-bash`'s result rendering is untouched.
- `SpawnSpec.timeoutMs` and `SpawnOutcome.timedOut`/`aborted` were removed rather than kept as always-zero/always-false vestiges: with `runBash` owning no timer and the executor owning classification, they were read nowhere. This is the one deviation from the literal proposal shape (which passed `timeoutMs: 0` into `runBash`); an always-0 field read by nothing is dead weight under the per-file coverage gate.
- web_fetch shed its bespoke controller/timer/listener/reason-recovery; the classifier now keys off the deadline signal (`timeoutOf` + `aborted`) rather than the thrown error's shape, which is robust across both the request-phase reject-with-reason and the read-phase bare-`AbortError`.
- `AbortSignal.any` and `using`/`Symbol.dispose` enter the repo for the first time here (Node ≥ 24 baseline, already met).

Out of scope, named to mark the boundary: `web_search` can gain an optional model-facing `timeout_ms` once its tool-schema/snapshot coverage is planned; future ripgrep-backed fs discovery tools can consume the same provider-owned deadline shape once they exist; a `tools/execute` waterfall middleware could arm a default deadline for every tool call by driving `exec.signal` — that would be a plugin that *consumes* this library and still only notifies, the hard kill remaining each capability's job.

## Alternatives considered

**A unified timeout *plugin* / `ctx.timeout` service.** Rejected on microkernel grounds. A service that could stop any tool's work would have to understand every capability's termination mechanism (process-group SIGKILL, socket teardown, syscall-boundary checks) — the "kernel knows too much" the architecture forbids. Codex's `ExecExpiration` is scoped to the exec family precisely because the kill it drives (`killpg`) is process-family-specific; MCP and model-stream keep their own. There is no coherent middle layer that owns termination for everything, so the shared piece can only be the pure timing/classification half — a library, not a service.

**Per-tool ad-hoc timeout, no shared code (the prior status quo, and Claude Code's choice).** Rejected because it was already producing divergence and duplicated correctness burden: web_fetch hand-rolled the exact controller/reason logic that future network/process-backed tools would each have to re-derive, and the fusion + `signal.reason` recovery are the error-prone parts. Claude Code tolerates full duplication; this repo has a single shared abort channel (`exec.signal` on every `execute`) that makes a small shared primitive strictly cleaner, so the cost/benefit differs.

**A `withTimeout(promise, ms)` wrapper instead of a signal factory.** Rejected because racing a promise against a timer resolves the *tool-call* promise on deadline without stopping the underlying work — the child process or fetch socket leaks on. Handing out a signal and requiring the capability to listen is what forces a real termination path to exist. This mirrors the "dispose must reach quiescence, not just request it" defensive rule.

**Keep bash's two independent triggers (`killTimer` + `onAbort`) rather than fusing.** Rejected for the convergence goal: fusing into one `deadline` signal removes bash's bespoke timer and gives every capability one shape. The trade-off is that bash's `timedOut`/`aborted` booleans become first-abort classifications rather than independent facts that can both be true when timeout and user abort race before process close. That is acceptable because the result reports the cause that first cut the command short; the termination action stays the same uniform SIGTERM→grace→SIGKILL kill. Note the deliberate non-alignment with Codex: Codex forks its kill by outcome (timeout → immediate SIGKILL; cancel → SIGTERM + 50 ms grace → SIGKILL), whereas the fused signal drives one uniform `kill()` for both, matching Claude Code's unified bash kill. Splitting the kill by `timeoutOf` is possible later if a need appears; there is none now.
