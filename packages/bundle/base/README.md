# `@deepseek-ai/dsh-base`

English | [中文](README.zh.md)

The shared dsh core as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) inserts every base plugin row — model adapters, tools, persistence, policy, settings/credentials, repository Plugins, telemetry — over the empty profile root, as the first layer of every profile's `dsh.profile.bundles` list. Later bundle layers (e.g. [`dsh-web-app`](../web-app/README.md)) and the user's profile `cordis.patch.yml` override these rows by id; a patch replaces a row's whole `config`, so mode-specific values live in mode bundles, not here. The package has no runtime API; the profile composer resolves the universal patch through the `dsh.bundle.patch` manifest field, and the launcher reads the Windows platform layer below from code on win32 hosts.

Windows hosts booting a shipped profile additionally receive [`windows.cordis.patch.yml`](windows.cordis.patch.yml): it disables the POSIX-only bash stack (`bash-sandbox`/`tool-bash`) and inserts the sandbox-confined PowerShell stack (`@deepseek-ai/dsh-pwsh-sandbox`, `@deepseek-ai/dsh-tool-pwsh`). The permission surface stays exactly as on POSIX: `sandbox`/`sandbox-policy` enforce the file-effect policy through the Windows ACL restricted-token runner (the win32 chain of `dsh-sandbox-local` → `@deepseek-ai/dsh-sandbox-windows-acl`), the permission switcher and the approval service run unchanged, and `fs-sandbox` keeps fencing `ctx.fs` writes — mounting `dsh-fs-local` alongside it would double-register `ctx.fs` and fail the load. The launcher applies the layer between the bundle layers and the user layers on win32 hosts; a Windows host that prefers the unconfined local pwsh executor or full access overrides these rows through its profile or home `cordis.patch.yml` (the bash-restore recipe must be complete: disable `pwsh-sandbox`/`tool-pwsh` AND re-enable `bash-sandbox`/`tool-bash` — both executor families register the same `bash` service, so an incomplete recipe fails loud at load). POSIX hosts never receive it.

The row set and its rationale are documented inline in the patch file; the [generated composition graph](../../../apps/cli/composition.md) renders it.

## Model Experience

Indirectly, through the inserted rows: this bundle selects the shipped persona-less prompt base, tool set, and DeepSeek adapter that mode bundles specialize, and contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **A patch replaces whole row configs** — profile overrides must restate every field a row keeps; there is no deep-merge layer.
- **The Windows temp grant is a private per-session subdirectory** — `workspace-write` confines writes to the workspace plus the session's own temp subdirectory (`<temp>\dsh-<hash>`, TMP/TEMP rewritten for confined children); `read-only` grants nothing. See `@deepseek-ai/dsh-sandbox-windows-acl`.
