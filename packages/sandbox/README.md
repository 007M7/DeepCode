# sandbox/ — process-sandbox capability family

The confinement half of the [capability-seam split](../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md): an abstract provider interface and platform backends. Consumers hand `ctx.sandbox` the exact argv they are about to spawn and spawn the returned (wrapped) argv instead; policy (`SandboxPolicy`: mode + workspace root) rides each call, so different consumers confine under different policies at the same instant. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `sandbox/` | Abstract process-sandbox seam (the `SandboxProvider` contract + the mode/enforcement/policy vocabulary) | `ctx.sandbox` |
| `sandbox-local/` | Local backends by platform chain: Linux `bwrap` else the `landlock-run` launcher (the npm-distributed [`node-addon-landlock-run`](https://www.npmjs.com/package/node-addon-landlock-run) family, built and released from its own repository), darwin `sandbox-exec`/Seatbelt — multi-candidate chains functionally probed, sole candidates selected directly, verdict cached, fail-closed | (registers `ctx.sandbox`) |

The seam confines SAME-WORLD subprocesses only (shared filesystem and kernel). Containers, microVMs, and remote executors are NOT backends here — they replace whole capability implementations (`ctx.bash`, `ctx.fs`) as environment-coherent groups; the boundary is recorded in [the sandbox RFC](../../docs/rfc/implemented/feature/2026-07-06-sandbox.md).

Consumers today: [`bash/bash-sandbox`](../bash/bash-sandbox/) (wraps `['bash', '-c', command]`; see [examples/sandbox-acp-agent](../../examples/sandbox-acp-agent/) for the composed leaf). In-process tools (fs/web) cannot be confined by an OS wrapper — their sandbox semantics are policy at their own seams (the sandbox RFC's cross-family phase).
