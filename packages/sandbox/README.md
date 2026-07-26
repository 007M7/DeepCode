# sandbox/ — process-sandbox capability family

English | [中文](README.zh.md)

The confinement half of the [capability-seam split](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md): an abstract provider interface, platform backends, and the shared policy home. Consumers hand `ctx.sandbox` the exact argv they are about to spawn and spawn the returned (wrapped) argv instead; a complete `SandboxExecutionPolicy` (mode + workspace root) rides each capability call, and its confined subset becomes the provider's `SandboxPolicy`. Different sessions and consumers can therefore confine under different policies at the same instant. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `sandbox/` | Abstract process-sandbox seam (the `SandboxProvider` contract + the mode/enforcement/policy vocabulary) plus the shared ESCALATION kit (`approveEscalation`, the strictly-wider ladder, the denial/hint markers) and the `writableRoots` derivation every enforcement dialect shares | `ctx.sandbox` |
| `sandbox-local/` | Local backends by platform chain: Linux `bwrap` else the `landlock-run` launcher (the npm-distributed [`node-addon-landlock-run`](https://www.npmjs.com/package/node-addon-landlock-run) family, built and released from its own repository), darwin `sandbox-exec`/Seatbelt — multi-candidate chains functionally probed, sole candidates selected directly, verdict cached, fail-closed | (registers `ctx.sandbox`) |
| `sandbox-policy/` | The policy resolver: deployment fallbacks plus each session's durable mode and immutable cwd root. Both enforcing families consume its complete per-call result, so bash and fs cannot confine to different roots | `ctx.sandboxPolicy` |

The seam confines SAME-WORLD subprocesses only (shared filesystem and kernel). Containers, microVMs, and remote executors are NOT backends here — they replace whole capability implementations (`ctx.bash`, `ctx.fs`) as environment-coherent groups; the boundary is recorded in [the sandbox Agent Note](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md).

Consumers today: [`bash/bash-sandbox`](../bash/bash-sandbox/) (wraps `['bash', '-c', command]` through `ctx.sandbox`) and [`fs/fs-sandbox`](../fs/fs-sandbox/) (an in-process path fence, not an argv wrapper — reads `ctx.sandboxPolicy` and enforces the shared mode on write/edit). The cross-family boundary is the sandbox Agent Note's [cross-family fs sandbox](../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md) phase; the shared vocabulary lets both families teach the model one denial marker and one escalation flow.
