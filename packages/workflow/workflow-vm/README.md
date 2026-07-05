# @deepseek-ai/dsh-workflow-vm

The first [`WorkflowService`](../workflow/README.md) implementation: an in-process **`node:vm` engine**. It parses the Claude Code-format script (`export const meta = {...}` + plain-JS body), runs the body in a fresh vm context with the workflow hooks injected, and fans `agent()` calls out to [`ctx.subagents`](../../subagent/README.md).

## Trust premise

Workflow scripts are **model-written** — the same trust level as the model's existing bash access — so this engine defends against **buggy** scripts, never hostile ones. vm is NOT a security boundary and no attempt is made to contain adversarial values: property reads on script values may run script code (a getter, a `toString`, a proxy trap) on the host stack, and a script determined to hang the process can simply spin past its first await (see the limitations below). What the engine DOES guarantee, because benign scripts hit these constantly: `result` never rejects, a dropped hook promise never becomes an unhandled rejection (the app boot layer exits the process on those), values that JSON cannot carry are rejected **loud** instead of silently mangled, and hook misuse is fatal instead of dissolving into a per-item `null`. Genuine sandboxing is an engine swap behind the seam (worker-thread/isolated-vm, where the boundary is serialization by construction), not incremental host-side defenses here.

## The script contract it executes

- **Meta extraction** (`extractMeta`): a string/comment-aware brace scanner finds the leading `export const meta` literal (template interpolation rejected — the literal must be pure), evaluates it ALONE in an empty timed vm context, materializes the result to plain JSON data, validates the shape (`name`/`description` required; unknown fields rejected loud), and blanks the statement line-preservingly so error stacks keep the script's own line numbers.
- **Hooks**: `agent(prompt, {label, phase, schema, model})` (schema = the [structured-output subset](../../core/tools/README.md), forwarded as `outputSchema`; result = validated object, or final text without a schema; a failed child resolves `null`), `parallel(thunks)`, `pipeline(items, ...stages)` with NO cross-stage barrier and `(prev, item, index)` stage callbacks, `phase(title)`, `log(message)`, and the `args` global. Anything else — `effort`/`isolation`/`agentType`, unknown options, malformed arguments, schemas outside the subset — throws a FATAL `WorkflowError` that `parallel`/`pipeline` re-throw rather than nulling (see the seam README's failure discipline).
- **Determinism bans**: `Date.now()`, `Math.random()`, and argless `new Date()` throw (kept even though resume is deferred, so scripts stay resume-compatible); no timers, filesystem, or Node APIs exist in the context.

## The value boundary

Values ENTERING the host (the meta literal, hook options/schemas, the script's return) are materialized by `materializeFromRealm`: a plain recursive walk that rejects loud everything JSON cannot carry (exotic prototypes, functions, symbols, cycles, sparse arrays, non-finite numbers, nested `undefined`), copying into host containers via `defineProperty` so a `"__proto__"` key becomes a data property, never a prototype mutation. Getters are read ordinarily — the RESULT is what crosses; a read that throws fails loud. Values ENTERING the realm (`args`, `agent()` results, hook promises and their failures, combinator arrays) are handed over directly as host values — the script is trusted, so host prototypes are not a leak; `args` is `structuredClone`d once at start so a script scribbling on it cannot mutate the caller's object. One script-visible consequence: an error thrown by a hook is a HOST error, so `e instanceof Error` inside the script is `false` — branch on `e.name`/`e.code` instead (the combinators recognize fatality by host `instanceof`, which a script-built object can never pass, so fatal-vs-null cannot be forged or dissolved).

## Limits, cancellation, disposal

Per-run: a concurrency semaphore (`maxConcurrentAgents`), a total-`agent()` cap (`maxTotalAgents`), and a per-call item cap (`maxItemsPerCall`), all config. `cancel()` aborts every child (a shared `AbortSignal`), rejects waiting `agent()` slots, and makes every future hook call throw `CANCELLED` — the script dies at its next await and the run settles `cancelled`; a cancellation that lands before the body runs (or before it settles) reports `cancelled` even if the script itself needed no hooks, and a script that STILL has not settled `disposeGraceMs` after the cancel (parked on a promise no hook owns, like `await new Promise(() => {})`) is ABANDONED with `result` force-settling `cancelled` — a consumer awaiting `result` is never wedged past a cancellation. Once a run settles, stray children a script fired without awaiting are aborted too, and `dispose()` waits for those children to finish disposing (bounded by the grace) before returning. Every hook-returned promise carries a no-op rejection consumer, so a dropped promise cannot surface an unhandled rejection; thrown script values are rendered by a total host-side renderer (stack, then message, then `String()`, with a fixed label if rendering itself throws) — `result` cannot reject.

**Documented limitations** (the accepted cost of the in-process mechanism; the seam exists so a worker-thread/isolated-vm engine can swap in): `start()` runs the script's initial synchronous slice inline, so the caller blocks until the first await or the vm `timeout`; that `timeout` covers ONLY the initial slice, so a synchronous spin past it (an await continuation, a thenable's `then` invoked by promise resolution, or script code the host runs while rendering a thrown value) cannot be killed; `dispose()` waits `disposeGraceMs` then ABANDONS such a script (its settlement stays contained, but an abandoned spin would still occupy the event loop). A returned promise or thenable resolves per JavaScript semantics BEFORE materialization — that is what makes an un-awaited `return agent('x')` work — and the value-boundary guard applies to the resolution.

## Config

| Key | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | The `ctx.subagents` provider children run on. |
| `maxConcurrentAgents` | `0` (auto) | Concurrent `agent()` ceiling; `0` resolves to `min(16, max(1, cores - 2))`. |
| `maxTotalAgents` | `1000` | Total `agent()` calls one run may start (runaway-loop backstop). |
| `maxItemsPerCall` | `4096` | Items accepted by one `parallel()`/`pipeline()` call. |
| `syncTimeoutMs` | `5000` | vm timeout for the initial synchronous slice and the meta evaluation. |
| `disposeGraceMs` | `5000` | How long `dispose()` waits for a cancelled script and its children before abandoning them. |
