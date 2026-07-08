# dsh-timeout-policy

Tool-call timeout policy: a single `tools/execute` around-dispatch listener that arms a per-call cooperative deadline on `exec.signal` for each configured tool and returns a structured `TOOL_TIMEOUT` result when that deadline wins. It is the reference `tools/execute` wrapper and the deployment-owned home for model-facing tool-call budgets (the timeout-library RFC's foreseen middleware).

## Plugin (namespace: `timeout-policy`)

A function/namespace plugin (`name` / `Config` / `apply`), not a service. It registers no tool and injects nothing — it consumes `ctx.tools`'s `tools/execute` waterfall, which the `dsh-tools` registry always provides.

### Config

Per-tool policy, keyed by the model-facing tool name. There is deliberately **no global default** (a global budget would silently start failing any tool that runs long once the plugin loads) and **no model-facing override** (timeout is deployment policy, not prompt semantics) in this version.

```yaml
- id: timeout-policy
  name: '@deepseek-ai/dsh-timeout-policy'
  config:
    tools:
      web_fetch:
        timeoutMs: 30000
      web_search:
        timeoutMs: 30000
```

| Key | Type | Meaning |
|---|---|---|
| `tools` | `Record<string, { timeoutMs }>` | Per-tool timeout policy; an unlisted tool gets no deadline. `timeoutMs` is required per configured tool and must be positive finite. |

A configured tool name that never registers (a typo like `web_fech`, or a stale key) would silently apply the timeout to nothing. Because the tool set is dynamic (plugins register in `cordis.yml` order, HMR re-registers), this is not a load-time error — a real tool may register later. Instead, on every `tools/change` (and once at load) the plugin `logger.warn`s each configured name still absent from `ctx.tools`, warning each name at most once so a late registration silences it. This mirrors `dsh-tool-subagent`'s lifecycle-driven handling of a configured-but-unregistered provider name.

### Behavior

For a **configured** tool the listener:

1. Arms `deadline(exec.signal, timeoutMs, 'TOOL_TIMEOUT')` — one signal fusing the caller's abort with this plugin's timer (`@deepseek-ai/dsh-timeout`).
2. Swaps that derived signal onto `exec` for the downstream dispatch, then restores the caller's own signal afterward (cordis `next()` ignores passed arguments, so the wrapper mutates the shared `exec` in place; restoring keeps `tools/post-execute` seeing the caller's signal).
3. After dispatch, if `timeoutOf(d.signal, 'TOOL_TIMEOUT')` matches — this plugin's own timer fired — replaces the result with a structured `TOOL_TIMEOUT` tool result: `{ isError: true, error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' }, content: 'Error: tool call timed out after <ms>ms' }`.

An **unconfigured** tool delegates untouched (no deadline).

The base `next()` of `tools/execute` is the registry's dispatch-with-normalization thunk, so when the timeout signal reaches a provider that throws its own upstream-abort error, dispatch first turns it into a normal error result, and this wrapper then replaces that with `TOOL_TIMEOUT`. That ordering is why the replacement is keyed off the signal (`timeoutOf`), not off the dispatched result's shape.

### Cooperative, not a hard kill

The derived signal only **notifies**; termination stays with the tool and the capability it forwards `exec.signal` to (the `dsh-timeout` library owns no kill). **"Configured" therefore means "cooperative with `exec.signal`"**: a tool that ignores the signal will not stop on timeout. A deployment must only configure tools that forward the signal to their implementation — the shipped `web_fetch`/`web_search` (which forward through `ctx.web` to providers) are the reference. `TOOL_TIMEOUT` needs no session event for reconstructability: it is the final model-facing `tool/result`, already logged by the loop.

### Composing with other `tools/execute` wrappers

Multiple `tools/execute` listeners compose by cordis registration order. Combined with a future retry/sandbox/metrics wrapper, registration order chooses the semantics — "timeout covers the whole retry operation" (timeout registered outer) versus "timeout covers each attempt" (timeout registered inner).
