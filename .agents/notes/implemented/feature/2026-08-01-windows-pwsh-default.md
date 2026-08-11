# Agent Note: Windows defaults to pwsh

Status: implemented

English | [中文](2026-08-01-windows-pwsh-default.zh.md)

## Problem

The harness's shipped execution profile is bash-first on every platform. Windows hosts must install a bash shim (WSL or Git-Bash) or fall back to the POSIX-only `dsh-bash-local` behavior (hardcoded `bash -c` argv, process-group semantics); the model-facing bash tool teaches the bash dialect. The Windows-native foundation shipped in the [pwsh executor and tool decision](2026-08-01-pwsh-tool-and-executor.md) — a PowerShell implementation of the `ctx.bash` seam and a parity `pwsh` tool — but shipped compositions still mounted the bash stack on Windows, so a Windows host without a shim could not run the shipped shell.

## Decision

Windows hosts booting a shipped profile (`dsh web`, `dsh --profile headless`, one-shot tasks) get the PowerShell stack by default; POSIX hosts are unchanged.

- **The platform layer is a data file, not a roster rewrite.** `@deepseek-ai/dsh-base` ships [`windows.cordis.patch.yml`](../../../../packages/bundle/base/windows.cordis.patch.yml) alongside its universal `cordis.patch.yml`. It disables the POSIX-only `bash-sandbox`/`tool-bash` rows and inserts `pwsh-sandbox`/`tool-pwsh`. The later [Windows ACL sandbox decision](2026-08-08-windows-acl-restricted-token-sandbox.md) filled the win32 runner chain and superseded this note's original unconfined roster: `sandbox`, `sandbox-policy`, `fs-sandbox`, `permission`/`ui-permission`, and `approval` now stay enabled exactly as on POSIX, while the ACL backend truthfully reports its Everyone and hard-link gaps as partial enforcement.
- **The launcher injects the layer by platform.** `apps/cli/src/windows-shell.ts` resolves it from the base bundle layer's `packageDir` between the bundle layers and the user layers on `win32` hosts, in every composition path (boot, config-only HMR recomposition, config dumps). Overriding the shipped default is a composition decision: a Windows host that prefers the bash stack re-enables the bash rows and disables both pwsh rows through its profile or home `cordis.patch.yml`. Custom profiles without the base bundle are skipped (they own their shell stack); a base bundle that ships no Windows shell patch fails loud.
- **Module resolution is restored for cold starts.** The profiles-rework CLI dropped the pwsh packages from `apps/cli`'s dependency closure, so `healProfilesModuleFallback` never linked them into `$DSH_HOME/profiles/node_modules` and a fresh Windows host could not resolve the inserted rows. `apps/cli` and `dsh-base` declare `dsh-pwsh-sandbox`/`dsh-tool-pwsh`; the executor's dependency chain supplies `dsh-pwsh-local`, and the base bundle lists every row plugin as a dependency by house style.

The pwsh GUI rendering shipped earlier with the [pwsh UI presentation matches bash decision](2026-08-05-pwsh-ui-bash-parity.md); the [pwsh tool bash parity decision](2026-08-02-pwsh-tool-bash-parity.md) ships the tool's surface. Nothing in this decision changes POSIX behavior.

## Alternatives considered

**Default Windows to pwsh inside `dsh-bash-local` (one executor, dialect switch).** Rejected for the same reason the executor decision rejected a mode switch: the executor's identity is the shell it spawns, and platform-gated composition is a deployment choice, not an executor config.

**Ship the platform layer from `apps/cli` code instead of a bundle data file.** Rejected: the patch belongs next to the rows it replaces, in the bundle that owns them, so the shipped roster stays visible as composition data and dumps carry its provenance; the launcher contributes only the win32 gate.

**Keep `permission`/`ui-permission` on Windows without a confining runner.** Rejected by the original delivery: `dsh-permission` hard-requires `ctx.bash.sandboxMode` and fails loud at load over an unconfined executor. The later ACL runner removed that premise, so the current roster retains both rows.

**Keep fs path-rule confinement on Windows without an OS runner.** Rejected by the original delivery: an unconfined shell could bypass fs-only path rules. The current ACL runner confines the shell and the fs provider under one policy, so this rejected half-boundary is no longer the shipped shape.

**Ship a `DSH_WINDOWS_SHELL` environment escape hatch.** Rejected: decisive behavior changes belong in composition config, which already overrides the platform layer row by id; a second override channel would split the single source of truth for roster decisions.

## Consequences

- A Windows host running a shipped `dsh` surface gets `pwsh` as its shell tool and PowerShell as the `ctx.bash` executor without configuration; `bash` is absent from the model-visible roster there (its tool row is disabled).
- Windows commands and fs operations share the sandbox policy, permission switcher, and approval service. The ACL runner confines writes but reports `enforcement: 'partial'`; explicit `danger-full-access` remains the approved bypass rather than the platform default.
- POSIX hosts are unchanged: the platform layer never applies, and the bash stack remains the universal `cordis.patch.yml` rows.
- Windows hosts that prefer the bash stack (e.g. with WSL/Git-Bash on PATH) override the shipped default through their profile or home `cordis.patch.yml` — disabling `pwsh-sandbox`/`tool-pwsh` and re-enabling `bash-sandbox`/`tool-bash` (both executors register the same `bash` service, so an incomplete recipe fails loud at load) — composition config is the one override channel.

## Verification

- Unit: `apps/cli/tests/windows-shell.spec.ts` pins the win32 default, custom-profile skip, missing-patch failure, cold-start dependency closure, and real composed roster; `packages/bundle/base/tests/base.spec.ts` pins that the Windows layer disables only the bash rows, inserts the confined pwsh rows, and leaves sandbox, permission, fs, and approval ownership untouched.
- Keyless: a win32 `dsh --profile <name> --dump-config` shows the pwsh rows with `windows.cordis.patch.yml` provenance and the bash rows disabled; the POSIX dump (CI Linux) is unchanged.
- The real-composition smoke boots the web profile on win32 with the pwsh stack mounted (the exact roster this note describes).
