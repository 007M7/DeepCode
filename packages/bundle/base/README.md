# `@deepseek-ai/dsh-base`

English | [中文](README.zh.md)

The shared dsh core as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) inserts every base plugin row — model adapters, tools, persistence, policy, settings/credentials, repository Plugins, telemetry — over the empty profile root, as the first layer of every profile's `dsh.profile.bundles` list. Later bundle layers (e.g. [`dsh-web-app`](../web-app/README.md)) and the user's profile `cordis.patch.yml` override these rows by id; a patch replaces a row's whole `config`, so mode-specific values live in mode bundles, not here. The package has no runtime API; the profile composer resolves the universal patch through the `dsh.bundle.patch` manifest field, and the launcher reads the Windows platform layer below from code on win32 hosts.

Windows hosts booting a shipped profile additionally receive [`windows.cordis.patch.yml`](windows.cordis.patch.yml): it disables the POSIX-only bash executor/tool and the permission stack (dsh-permission requires a confining executor), and inserts the PowerShell executor and tool (`@deepseek-ai/dsh-pwsh-local`, `@deepseek-ai/dsh-tool-pwsh`). The launcher applies it between the bundle layers and the user layers on win32 hosts; a Windows host that prefers the bash stack overrides these rows through its profile or home `cordis.patch.yml`. POSIX hosts never receive it.

The row set and its rationale are documented inline in the patch file; the [generated composition graph](../../../apps/cli/composition.md) renders it.

## Model Experience

Indirectly, through the inserted rows: this bundle selects the shipped persona-less prompt base, tool set, and DeepSeek adapter that mode bundles specialize, and contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **A patch replaces whole row configs** — profile overrides must restate every field a row keeps; there is no deep-merge layer.
- **Windows loses the permission switcher** — `dsh-permission` hard-requires a confining `ctx.bash` executor, so the Windows platform layer disables `permission`/`ui-permission` with the bash stack. The fs tools keep the sandbox policy and the approval service, so file confinement and escalation still apply on Windows.
