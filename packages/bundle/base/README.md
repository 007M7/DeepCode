# `@deepseek-ai/dsh-base`

English | [中文](README.zh.md)

The shared dsh core as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) inserts every base plugin row — model adapters, tools, persistence, policy, settings/credentials, repository Plugins, telemetry — over the empty profile root, as the first layer of every profile's `dsh.profile.bundles` list. Later bundle layers (e.g. [`dsh-web-app`](../web-app/README.md)) and the user's profile `cordis.patch.yml` override these rows by id; a patch replaces a row's whole `config`, so mode-specific values live in mode bundles, not here. The package has no runtime API; the profile composer resolves the universal patch through the `dsh.bundle.patch` manifest field, and the launcher reads the Windows platform layer below from code on win32 hosts.

Windows hosts booting a shipped profile additionally receive [`windows.cordis.patch.yml`](windows.cordis.patch.yml): it disables the POSIX-only sandboxed stacks — the bash executor/tool, the permission switcher (dsh-permission requires a confining executor), the sandbox/fs-policy stack, and the approval service — and inserts the PowerShell executor and tool (`@deepseek-ai/dsh-pwsh-local`, `@deepseek-ai/dsh-tool-pwsh`) plus the unconfined `dsh-fs-local`. Windows has no OS sandbox runner (landlock/bwrap/seatbelt are POSIX-only), so the shipped posture is honest danger-full-access rather than a boundary only the fs tools pretend to enforce; nothing in the roster asks for approval, so the approval service is absent. The launcher applies the layer between the bundle layers and the user layers on win32 hosts; a Windows host that prefers the bash stack restores it through its profile or home `cordis.patch.yml` (disable `pwsh-local`/`tool-pwsh` and re-enable `bash-sandbox`/`tool-bash` — both executors register the same `bash` service, so an incomplete recipe fails loud at load). POSIX hosts never receive it.

The row set and its rationale are documented inline in the patch file; the [generated composition graph](../../../apps/cli/composition.md) renders it.

## Model Experience

Indirectly, through the inserted rows: this bundle selects the shipped persona-less prompt base, tool set, and DeepSeek adapter that mode bundles specialize, and contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **A patch replaces whole row configs** — profile overrides must restate every field a row keeps; there is no deep-merge layer.
- **Windows has no sandbox and no approval** — no OS runner exists on win32 (landlock/bwrap/seatbelt are POSIX-only), so the Windows platform layer removes the whole sandbox stack (`sandbox`/`sandbox-policy`/`fs-sandbox` disabled, `dsh-fs-local` provides `ctx.fs`), the permission switcher leaves the roster, and the approval service is disabled — nothing on Windows asks for approval, so the model is never told approval exists. Everything degrades to danger-full-access: the shell is unconfined and the fs tools make no confinement claims.
