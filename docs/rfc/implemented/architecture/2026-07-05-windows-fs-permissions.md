# RFC: Windows write-permission semantics — inherited DACLs, not mode bits

Status: implemented

## Problem

`writeFileAtomic` in `@deepseek-ai/dsh-fs-local` protects write-in-progress content with POSIX mode bits: the staging directory is created `0o700`, the temp file is opened `0o600`, and new files default to `0o600`. On POSIX this keeps temporary content owner-only regardless of the parent directory's permissions.

Windows has no working equivalent behind the same API. Node's `chmod` there drives only the read-only attribute (every mode this package passes carries owner-write, so the calls are benign no-ops), and `stat().mode` reports synthetic `0o666`/`0o444` bits. The real security state is the file's DACL, which this code never sets; a newly created file or directory inherits its DACL from its parent directory.

## Decision

Production code is unchanged: no platform fork, no DACL management. The Windows privacy invariant is structural rather than mode-driven — the staging directory is created inside the target's parent directory (`dirname(absolutePath)`), so it and the temp file inherit exactly the destination directory's DACL, and write-in-progress content is never exposed more widely than the destination itself. In the typical deployment (a coding agent writing the user's own project tree under `C:\Users\<user>\`) the inherited DACL is owner + SYSTEM + Administrators, matching the POSIX intent.

Tests assert mode bits on POSIX only. There is no Windows-side ACL assertion because there is no Windows-side code behavior to pin: an ACL check on a `mkdtemp(tmpdir())` fixture would verify Windows DACL inheritance plus the machine's `%TEMP%` ACL — the operating system, not this package — and no change to this package could turn it red.

## Alternatives considered

**Explicit protected DACLs.** Granting owner-only access would require per-write FFI or a subprocess, break inheritance, and surprise users whose project directories are deliberately shared. This becomes appropriate only if the threat model includes hostile local readers of broadly accessible target directories.

**Test-side ACL verification.** A `Get-Acl` SID allowlist or `icacls` would verify Windows inheritance and the machine's `%TEMP%` ACL rather than package behavior; `icacls` also localizes well-known account names, making parsing locale-fragile.

**Skip `chmod` on Windows.** Platform-guarding benign no-op calls adds branches without changing behavior.

## Consequences

POSIX keeps the stronger guarantee: owner-only temp content regardless of the parent directory. Windows guarantees only "no wider than the destination": a target inside a broadly accessible directory (a share, a permissive `D:\` root) gets equally accessible write-in-progress content. The gap is deliberate and documented, not an oversight.

Mode preservation across a replace degenerates to a no-op on Windows: a writable file probes as `0o666`, and replaying that through `chmod` leaves the read-only attribute clear. A read-only target cannot be replaced at all there — `rename` over it fails before the preserved mode would matter.
