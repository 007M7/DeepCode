# @deepseek-ai/dsh-workflow-vm

The first [`WorkflowService`](../workflow/README.md) implementation: an in-process **`node:vm` engine**. It parses the Claude Code-format script (`export const meta = {...}` + plain-JS body), runs the body in a fresh vm context with the workflow hooks injected, and fans `agent()` calls out to [`ctx.subagents`](../../subagent/README.md).

## The script contract it executes

- **Meta extraction** (`extractMeta`): a string/comment-aware brace scanner finds the leading `export const meta` literal (template interpolation rejected — the literal must be pure), evaluates it ALONE in an empty timed vm context, materializes the result to plain JSON data, validates the shape (`name`/`description` required; unknown fields rejected loud), and blanks the statement line-preservingly so error stacks keep the script's own line numbers.
- **Hooks**: `agent(prompt, {label, phase, schema, model})` (schema = the [structured-output subset](../../core/tools/README.md), forwarded as `outputSchema`; result = validated object, or final text without a schema; a failed child resolves `null`), `parallel(thunks)`, `pipeline(items, ...stages)` with NO cross-stage barrier and `(prev, item, index)` stage callbacks, `phase(title)`, `log(message)`, and the `args` global. Anything else — `effort`/`isolation`/`agentType`, unknown options, malformed arguments, schemas outside the subset — throws a FATAL `WorkflowError` that `parallel`/`pipeline` re-throw rather than nulling (see the seam README's failure discipline).
- **Determinism bans**: `Date.now()`, `Math.random()`, and argless `new Date()` throw (kept even though resume is deferred, so scripts stay resume-compatible); no timers, filesystem, or Node APIs exist in the context.

## Realm discipline

Values ENTERING the host (the meta literal, hook options/schemas, the script's return) are materialized by `materializeFromRealm`: a descriptor walk that never invokes accessors and rejects loud everything JSON cannot carry (accessors, exotic prototypes, functions, symbols, cycles, sparse arrays, non-finite numbers, nested `undefined`, and proxies — rejected via the trap-free `util.types.isProxy` BEFORE any inspection could run a realm-side trap on the host stack), copying into host containers via `defineProperty` so a `"__proto__"` key becomes a data property, never a prototype mutation. Values ENTERING the realm (`args`, `agent()` results) are rebuilt INSIDE the realm through the context's own `JSON.parse`, and the arrays `parallel`/`pipeline` resolve to are realm-built, so the script never holds an object whose prototype chain reaches host intrinsics.

## Limits, cancellation, disposal

Per-run: a concurrency semaphore (`maxConcurrentAgents`), a total-`agent()` cap (`maxTotalAgents`), and a per-call item cap (`maxItemsPerCall`), all config. `cancel()` aborts every child (a shared `AbortSignal`), rejects waiting `agent()` slots, and makes every future hook call throw `CANCELLED` — the script dies at its next await and the run settles `cancelled`; a cancellation that lands before the body runs (or before it settles) reports `cancelled` even if the script itself needed no hooks. Once a run settles, stray children a script fired without awaiting are aborted too, and `dispose()` waits for those children to finish disposing (bounded by the grace) before returning. Every hook-returned promise carries a no-op rejection consumer, so a dropped promise cannot surface an unhandled rejection (the app boot layer exits the process on those), and thrown script values are rendered by the total `describeThrown` (proxy-labelling, own-descriptor reads, a contained stack-getter call), so a hostile throw (`{ get stack() { throw ... } }`) cannot make `result` reject.

**Documented limitations** (the accepted cost of the in-process mechanism; the seam exists so a worker-thread/isolated-vm engine can swap in): vm is NOT a security boundary — scripts are model-written, the same trust level as the model's bash access — and the vm `timeout` covers only the initial synchronous slice, so a pathological synchronous spin after the first await cannot be killed; `dispose()` waits `disposeGraceMs` then ABANDONS such a script (its settlement stays contained, but an abandoned spin would still occupy the event loop).

## Config

| Key | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | The `ctx.subagents` provider children run on. |
| `maxConcurrentAgents` | `0` (auto) | Concurrent `agent()` ceiling; `0` resolves to `min(16, max(1, cores - 2))`. |
| `maxTotalAgents` | `1000` | Total `agent()` calls one run may start (runaway-loop backstop). |
| `maxItemsPerCall` | `4096` | Items accepted by one `parallel()`/`pipeline()` call. |
| `syncTimeoutMs` | `5000` | vm timeout for the initial synchronous slice and the meta evaluation. |
| `disposeGraceMs` | `5000` | How long `dispose()` waits for a cancelled script and its children before abandoning them. |
