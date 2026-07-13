# @deepseek-ai/dsh-sandbox-local

Local implementation of the [`dsh-sandbox`](../sandbox/) seam. It selects and caches one platform runner: Linux prefers a working `bwrap` then Landlock; macOS uses Seatbelt. Multiple candidates are probed in order, while a sole candidate is selected directly.

Unsupported platforms and unusable runners fail closed with `SANDBOX_UNAVAILABLE`; execution never silently falls through unconfined. Each wrap carries runner-failure signatures so consumers can distinguish a broken sandbox from a command failure. The [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) owns selection rationale and profile differences.

Policy is per call; the provider stores only the mechanism and cached runner verdict. Each wrap reports enforcement completeness plus backend-specific denial and runner-failure signatures. `runnerCommand` is an operator assertion of a bwrap-shaped runner and skips probes, but missing or unexecutable commands still fail closed at execution. Because its mechanism is unknown, it carries both Linux denial dialects. `probeTimeoutMs` bounds functional probes. The [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md) owns selection and failure semantics.

The Seatbelt profile is allow-default with `(deny file-write*)` plus write allow-lists, so exactly the mode's promised file effects are governed: `read-only` grants the `/dev/null` literal alone; `workspace-write` adds the workspace root, `/tmp`, and the per-user darwin temp dir (`os.tmpdir()` — the platform's real temp area for mkstemp-family tools), every root canonicalized because Seatbelt matches resolved paths (`/tmp` IS `/private/tmp`). Apple marks the `sandbox-exec` CLI deprecated but ships it on every macOS; the functional probe is what fails closed if that ever changes.

[`node-addon-landlock-run`](https://www.npmjs.com/package/node-addon-landlock-run) supplies the platform launcher, functional probe, and CLI argument vocabulary. This provider owns only mode-to-grant mapping and runner selection. Keeping path resolution and probe parsing with the versioned binary prevents contract drift.

Each rung has a self-skipping keyless world-effect test; CI runs platform legs against real kernels and rejects a silent all-skip. The packed-install test exercises the registry launcher and executable mode through a plain-Node consumer.

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
```

Consumers: [`@deepseek-ai/dsh-bash-sandbox`](../../bash/bash-sandbox/); see [`examples/sandbox-acp-agent`](../../../examples/sandbox-acp-agent/) for the runnable composition.
