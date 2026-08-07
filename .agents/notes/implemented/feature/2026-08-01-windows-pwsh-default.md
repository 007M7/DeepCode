# Agent Note: Windows defaults to pwsh

Status: implemented

English | [中文](2026-08-01-windows-pwsh-default.zh.md)

## Problem

The harness's shipped execution profile is bash-first on every platform. Windows hosts must install a bash shim (WSL or Git-Bash) or fall back to the POSIX-only `dsh-bash-local` behavior (hardcoded `bash -c` argv, process-group semantics); the model-facing bash tool teaches the bash dialect. The Windows-native foundation shipped in the [pwsh executor and tool decision](2026-08-01-pwsh-tool-and-executor.md) — a PowerShell implementation of the `ctx.bash` seam and a parity `pwsh` tool — but shipped compositions still mounted the bash stack on Windows, so a Windows host without a shim could not run the shipped shell.

## Decision

Windows hosts booting a shipped profile (`dsh web`, `dsh --profile headless`, one-shot tasks) get the PowerShell stack by default; POSIX hosts are unchanged.

- **The platform layer is a data file, not a roster rewrite.** `@deepseek-ai/dsh-base` ships [`windows.cordis.patch.yml`](../../../../packages/bundle/base/windows.cordis.patch.yml) alongside its universal `cordis.patch.yml`: it disables `bash-sandbox`/`tool-bash` (the POSIX-only executor and its dialect tool) and inserts `pwsh-local`/`tool-pwsh`. Windows has no OS sandbox runner (landlock/bwrap/seatbelt are POSIX-only), so the layer drops the sandbox stack entirely — `sandbox`, `sandbox-policy`, and `fs-sandbox` are disabled and the unconfined `dsh-fs-local` provides `ctx.fs` — and degrades to danger-full-access: `permission`/`ui-permission` leave the roster (dsh-permission requires a confining executor — presets bundle a sandbox mode the unconfined executor cannot honor; see its constructor guard — and the client knob would advertise a boundary that does not exist), and the `approval` service is disabled — nothing in the Windows roster asks for approval, so the model is never told approval exists or that asks are auto-rejected. Keeping fs-only path rules would be theater: the unconfined shell can bypass them with one command, so the honest Windows posture is full access rather than a boundary only the fs tools pretend to enforce.
- **The launcher injects the layer by platform.** `apps/cli/src/windows-shell.ts` resolves it from the base bundle layer's `packageDir` between the bundle layers and the user layers on `win32` hosts, in every composition path (boot, config-only HMR recomposition, config dumps). Overriding the shipped default is a composition decision: a Windows host that prefers the bash stack — or confinement — re-enables the bash rows through its profile or home `cordis.patch.yml`. Custom profiles without the base bundle are skipped (they own their shell stack); a base bundle that ships no Windows shell patch fails loud.
- **Module resolution is restored for cold starts.** The profiles-rework CLI dropped the pwsh packages from `apps/cli`'s dependency closure, so `healProfilesModuleFallback` never linked them into `$DSH_HOME/profiles/node_modules` and a fresh Windows host could not resolve the inserted rows. `apps/cli` and `dsh-base` re-declare `dsh-pwsh-local`/`dsh-tool-pwsh`, and `dsh-base` also declares `dsh-fs-local`; the base bundle lists every row plugin as a dependency by house style.

The pwsh GUI rendering stage (stage 2 of the original roadmap) shipped earlier with the [pwsh UI presentation matches bash decision](2026-08-05-pwsh-ui-bash-parity.md); the [pwsh tool bash parity decision](2026-08-02-pwsh-tool-bash-parity.md) ships the tool's surface. Nothing in this decision changes POSIX behavior.

## Alternatives considered

**Default Windows to pwsh inside `dsh-bash-local` (one executor, dialect switch).** Rejected for the same reason the executor decision rejected a mode switch: the executor's identity is the shell it spawns, and platform-gated composition is a deployment choice, not an executor config.

**Ship the platform layer from `apps/cli` code instead of a bundle data file.** Rejected: the patch belongs next to the rows it replaces, in the bundle that owns them, so the shipped roster stays visible as composition data and dumps carry its provenance; the launcher contributes only the win32 gate.

**Keep `permission`/`ui-permission` on Windows.** Rejected: `dsh-permission` hard-requires `ctx.bash.sandboxMode` and fails loud at load over an unconfined executor; making it tolerate an unconfined shell would advertise presets the shell cannot honor.

**Keep fs path-rule confinement on Windows (`sandbox-policy` + `fs-sandbox` without OS runners).** Rejected: the shell is the model's primary tool and unconfined on Windows, so fs-only path rules are trivially bypassable and would overstate the boundary; the honest posture is full degradation to danger-full-access.

**Ship a `DSH_WINDOWS_SHELL` environment escape hatch.** Rejected: decisive behavior changes belong in composition config, which already overrides the platform layer row by id; a second override channel would split the single source of truth for roster decisions.

## Consequences

- A Windows host running a shipped `dsh` surface gets `pwsh` as its shell tool and PowerShell as the `ctx.bash` executor without configuration; `bash` is absent from the model-visible roster there (its tool row is disabled).
- Windows has no sandbox at all: the fs tools run unconfined (`dsh-fs-local`), the approval service is absent (nothing asks for approval, and the model is never told approval exists), and the permission switcher is gone. The model-visible posture is honest full access rather than a boundary the shell can bypass.
- POSIX hosts are unchanged: the platform layer never applies, and the bash stack remains the universal `cordis.patch.yml` rows.
- Windows hosts that prefer the bash stack (e.g. with WSL/Git-Bash on PATH) override the shipped default through their profile or home `cordis.patch.yml` — disabling `pwsh-local`/`tool-pwsh` and re-enabling `bash-sandbox`/`tool-bash` (both executors register the same `bash` service, so an incomplete recipe fails loud at load) — composition config is the one override channel.

## Verification

- Unit: `apps/cli/tests/windows-shell.spec.ts` pins the win32 default, the custom-profile skip, and the missing-patch failure, with the platform injected; `packages/bundle/base/tests/base.spec.ts` pins the shipped Windows roster (disables, inserts, and the absent approval service).
- Keyless: a win32 `dsh --profile <name> --dump-config` shows the pwsh rows with `windows.cordis.patch.yml` provenance and the bash rows disabled; the POSIX dump (CI Linux) is unchanged.
- The real-composition smoke boots the web profile on win32 with the pwsh stack mounted (the exact roster this note describes).
