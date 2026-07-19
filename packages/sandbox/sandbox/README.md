# @deepseek-ai/dsh-sandbox

Abstract process-sandbox seam. Owns the `ctx.sandbox` service contract ([`SandboxProvider`](src/index.ts)) and the confinement vocabulary the harness shares: `SandboxMode` (`read-only` / `workspace-write` / `danger-full-access`, file effects only), `SandboxEnforcement` (`full` / `partial`, per kernel ABI), `SandboxPolicy` (per-CALL policy — mode + workspace root), and the fail-closed `SANDBOX_UNAVAILABLE` error. Interface package of the [capability-seam split](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md): depends only on cordis (+ the harness error base), never on a backend.

The contract in one line: `ctx.sandbox.confine(argv, policy)` returns the argv to spawn INSTEAD of your own — wrapped so the process (and everything it spawns) runs confined — plus two facts about the selected backend: the enforcement completeness it achieves and its denial dialect (`denialSignatures`, the stderr substrings its kernel prints on a denied file effect — what stderr-inferring consumers match instead of a cross-backend union); when no backend is usable it throws rather than passing the argv through unconfined.

Policy rides the call, not the provider: two consumers may confine under different policies at the same instant (bash under `read-only` while a confined child agent keeps its state directory writable), and an approved escalated retry is just a new call with a wider policy.

**Same-world confinement only.** A backend shares the host's filesystem and kernel (`bwrap`, Landlock, Seatbelt); `workspaceRoot` names a real host path. Containers, microVMs, and remote executors are NOT backends of this seam — they replace whole capability implementations (`ctx.bash`, `ctx.fs`) as environment-coherent groups. The boundary and its rationale: [the sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md).

Implementations: [`@deepseek-ai/dsh-sandbox-local`](../sandbox-local/) (Linux: `bwrap`, else the per-platform Landlock launcher; macOS: `sandbox-exec`/Seatbelt). Consumers: [`@deepseek-ai/dsh-bash-sandbox`](../../bash/bash-sandbox/) (wraps `['bash', '-c', command]`).

## Model Experience

### Confinement error, indirectly

#### What the model sees

Through [`dsh-bash-sandbox`](../../bash/bash-sandbox/README.md) and [`dsh-tool-bash`](../../bash/tool-bash/README.md), failure to enforce a requested mode produces code `SANDBOX_UNAVAILABLE` and the exact error below. An execution-time runner failure adds ` Runner failure: <detail>`.

##### Exact error

```markdown
sandbox mode "<mode>" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS) — Windows has no confinement backend yet — or switch the consumer to danger-full-access.
```

#### Token effect

Conditional error text is visible for that call and retained in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **File effects are the whole policy vocabulary** — the seam expresses no network, process, syscall, device, or credential restrictions.
- **Same-world confinement only** — containers, microVMs, and remote execution require replacing capability implementations rather than adding a provider here.
- **Denial reporting is a stderr dialect** — the seam returns backend signatures instead of a typed runtime denial channel, so consumers that need classification must infer it from the child process's output.
- **One provider per context** — composing different sandbox mechanisms simultaneously requires a provider-level ladder or separate Cordis contexts; callers choose policy per call, not backend identity.
