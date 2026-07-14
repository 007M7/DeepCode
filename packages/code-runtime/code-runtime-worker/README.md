# @deepseek-ai/dsh-code-runtime-worker

Worker-thread implementation of the [`@deepseek-ai/dsh-code-runtime`](../code-runtime/README.md) seam: `WorkerCodeRuntime` runs each program in ONE fresh Node `worker_threads.Worker` — TypeScript in, type-stripped host-side, bindings bridged over the message port, `{ value, logs, error? }` out. **Containment, not a security boundary**: trust posture is bash-equivalent by design (the [Code Mode RFC](../../../docs/rfc/implemented/feature/2026-06-15-code-mode.md) § Trust posture), with containment bash does not have — separate isolate, empty environment, heap cap, hard termination.

## Config

```yaml
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker'
  config:
    computeMs: 60000              # busy-time budget (measured event-loop active time)
    maxWallMs: 600000             # wall-clock ceiling; never pauses for anything
    maxLogBytes: 65536            # shared byte budget for captured log text
    maxValueBytes: 32768          # rendered-completion-value cap
    maxOldGenerationSizeMb: 512   # worker heap cap (resourceLimits)
```

Every field is validated (positive numbers) and defaulted; there are no other tunables.

## Design

- **One fresh worker per run, no pooling** — a program's world dies with its worker: no cross-run state to log, state bleed unrepresentable, runs reconstructable from the session log alone.
- **Type-strip host-side, in execution context** — the program is wrapped in an async-function shell, stripped with `node:module`'s `stripTypeScriptTypes` (erasable syntax only — `enum`/namespaces are rejected as a program `exception` and no worker spawns), and sliced back out byte-positioned; it then executes as the body of an `AsyncFunction`, so top-level `await`/`return` work.
- **The port assumes a hostile peer** — model code can reach `parentPort` and forge traffic, so every inbound message is shape-validated and REBUILT before anything reads it (`null`, primitives, junk types, and malformed payloads drop without a throw; forged extra fields never ride along), the host answers each call id at most once, resolves binding names as OWN properties only (a forged `constructor` cannot walk a prototype chain), drops post-settlement replies, and converts a non-cloneable binding resolution into an error reply. Forged `log`/`done` messages cannot bypass the caps: one host-side ledger bounds everything that lands in `logs`, and the completion value is re-capped host-side. Worker-side namespaces are null-prototype with `defineProperty`, so `__proto__`-shaped binding names are ordinary keys.
- **Two independent budgets, because the peer is hostile** — `computeMs` meters the worker's MEASURED busy time (`worker.performance.eventLoopUtilization()` polling): a hot loop cannot hide behind a pending decoy dispatch, and a program awaiting a slow tool accrues nothing. `maxWallMs` backstops what busy time cannot see (awaiting a promise nobody resolves). Both funnel into `worker.terminate()`, which ends hot synchronous loops too; heap overflow surfaces as the worker's OOM exit (`kind: 'worker-exit'`).
- **Logs stream eagerly** — console/stdout/stderr text crosses the port in emission order, so a timed-out or killed program still shows what it printed. ONE shared `maxLogBytes` ledger bounds everything: streamed text, forged port traffic, and pipe bytes that bypass the patched streams (appended after), with the overflow marked in-band once.
- **Empty environment** — the worker gets `env: {}` and `execArgv: []`: no ambient credentials (stronger than the scrubbed-env rule for spawned commands) and no inherited loader flags.
- **Dispose to quiescence** — teardown fails in-flight runs as `abort` and AWAITS each worker's exit before resolving.

## The worker entry, unbuilt and built

Source mode loads erasable-only `src/worker.ts` through Node's native type stripping. Built mode passes the sibling `lib/worker.cjs` as a filesystem path because pkg's VFS Worker hook expects CommonJS; the same path works under ordinary Node. `tests/built-lib.e2e.ts` pins the real load path required by [docs/testing.md](../../../docs/testing.md).

The SDK surface is the default/named `WorkerCodeRuntime` class plus `Config`. The operational `./worker` subpath exists only as the packaged spawn entry; the wire protocol and bootstrap helpers are source-private implementation details.

## Model Experience

Indirectly, through Code Mode in [`dsh-tools`](../../core/tools/README.md), which renders this worker's capped printed or returned data and exact `[dsh-code-runtime-worker] log capture truncated at <maxLogBytes> bytes` and `… [truncated]` markers into a retained `run_code` result. Binding traffic and worker internals stay outside context.

## Known Limitations and Deferred Work

- **OS processes a program spawns survive termination** — `worker.terminate()` ends the thread only, weaker than bash-local's process-group kill; orphan cleanup is a deployment concern until a container backend exists.
- **Type-strip rides Node's experimental `stripTypeScriptTypes` API** — the relied-on behavior is pinned by unit tests, with amaro/sucrase as named drop-in replacements if it shifts.
- **`computeMs` expiry can overshoot by up to one poll interval** — busy time is sampled every 25 ms (an internal constant, deliberately not config).
- **Programs get a five-method `console` shim** (`log`/`info`/`warn`/`error`/`debug`) — deliberately not Node's full console surface.
- **A non-cloneable or oversize completion value does not cross as a value** — it arrives as a bounded, truncation-marked `util.inspect` rendering in `value`'s place.
