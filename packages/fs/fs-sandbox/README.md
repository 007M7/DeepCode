# dsh-fs-sandbox — the sandbox-enforcing filesystem backend

`SandboxedFileSystem` extends [`LocalFileSystem`](../fs-local/README.md) and registers as `ctx.fs`. It inherits every text-storage mechanic verbatim (resolve, stat, read/stream, list, the atomic write, the read-match-write edit critical section) and adds only a per-call MODE fence on `writeText`/`editText`. Reads always pass through — every mode permits reading.

Loading it INSTEAD OF `dsh-fs-local`, together with a [`ctx.sandboxPolicy`](../../sandbox/sandbox-policy/README.md), is the whole swap; the model-facing tools (`dsh-tool-fs`) are untouched. Injects `sandboxPolicy` for the default mode and the `workspace-write` boundary root — the SAME policy home bash reads, so the two families never confine to different roots.

## The fence

The per-call mode is the tool-stamped effective mode (session override or escalation grant), falling back to the deployment default:

- `read-only` — denies every mutation with the structured `FS_SANDBOX_DENIED`.
- `workspace-write` — allows a mutation only when the target canonicalizes under a writable root: the workspace root plus the platform temp areas (`/tmp`, `os.tmpdir()`), the SAME set the Seatbelt profile grants, derived from the one [`writableRoots`](../../sandbox/README.md) function so the fs fence and the bash runner cannot drift. Canonical spellings use a lexical fast path; an identity-based ancestor fallback recognizes alias-equivalent roots such as Windows long names and 8.3 names without treating unrelated prefixes as contained. The target is re-canonicalized immediately before delegating, so an ancestor symlink swapped since the tool resolved it is caught.
- `danger-full-access` — delegates unfenced.

## Threat model: a policy fence, not a kernel boundary

The fence is a check in TRUSTED code over a MODEL-CONTROLLED path — the operations are the seam's own (open, rename), only the target path is untrusted, so canonicalize-then-contain is the complete answer to this surface. This mirrors the `code-runtime` stance: containment, not a security boundary. Kernel-grade isolation of untrusted CODE stays `ctx.bash`'s job ([`dsh-bash-sandbox`](../../bash/bash-sandbox/README.md)). The residual TOCTOU (an ancestor symlink swapped between the containment re-check and the syscall) is narrowed by re-canonicalizing immediately before the write and is accepted for this threat model; a kernel-tight boundary needs `openat2`-class primitives not worth their portability cost here.

A denial is a structured `FsError` (`FS_SANDBOX_DENIED`, carrying the effective mode) — no stderr text inference (unlike bash's kernel denials), because an in-process fence knows exactly what it refused. The model-facing `[sandbox: file access denied under <mode> mode]` marker and the one-approved-wider retry live in the tool layer (`dsh-tool-fs`), exactly as bash's do. See [the cross-family fs sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md).

## Model Experience

Indirectly, through `dsh-tool-fs`, which renders this backend's `FS_SANDBOX_DENIED` refusals as the `[sandbox: file access denied under <mode> mode]` marker plus the same-turn escalation hint.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **A policy fence, not a kernel boundary** — the check is trusted code over a model-controlled path, so the residual resolve-to-syscall TOCTOU is narrowed (by the in-place re-canonicalization) but not eliminated; adversarial host processes are out of scope. Kernel-grade isolation of untrusted code stays `ctx.bash`'s.
- **Fence-vs-runner parity is derived, not asserted** — the writable set comes from `writableRoots`, shared with the Seatbelt profile and pinned by a parity test; a runner profile that changed its writable set without that function would drift.
- **Requires `ctx.sandboxPolicy`** — the backend reads the default mode and workspace root from it and does not confine without it composed.
