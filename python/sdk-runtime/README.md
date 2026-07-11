# DeepSeek Harness Runtime Wheel

English | [中文](README.zh.md)

Runtime carrier package for the Python SDK (dist `deepseek-harness-runtime-bin`, module `deepseek_harness_runtime`): it locates the bundled runtime binaries the `deepseek-harness` client spawns, and ships the default configuration behind zero-config runs.

## Runtime carriers

Two carriers coexist under `src/deepseek_harness_runtime/runtime/`, both injected by the repo's `scripts/build-exe-for-python-sdk.ts` build and both gitignored:

- **exe (production)** — single-file executables `dsh-jsonrpc-agent-pkg-<platform>-<arch>` (platform: `linux`/`macos`; arch: `x64`/`arm64`). No Node installation needed on the target machine. This is the only carrier that ships in wheel/sdist distributions.
- **node (dev-only)** — the full deploy closure under `runtime/node/` (`package.json` + `node_modules/`), executed as `node runtime/node/node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js` on a system Node >= 22.19. It is the current checkout's source build, meant for repo-local development and verification only; it is never selected automatically and is excluded from distributions.

Both carriers hold the same content, defined once: the [package.json](package.json) at this package's root is the deploy root of the single-exe pipeline — a pure dependency manifest (no code of its own) whose dependency closure IS both the plugin set compiled into the exe and the tree materialized into `runtime/node/`. Adding a plugin to the distribution means adding one dependency line there and rebuilding.

Missing carriers raise `FileNotFoundError` naming the acquisition routes: build via `scripts/build-exe-for-python-sdk.ts` in a deepseek-harness checkout, or download the platform artifact of the `build-exe-for-python-sdk` CI workflow (a tar.gz — tar preserves the executable bit) and unpack it into the runtime directory. Acquisition strategy is deliberately separate from the lookup interface, so an on-demand download can replace it later without touching callers.

## Resolution API

- `resolve_bundled_launch_args(mode=None) -> tuple[str, ...]` — the argv tuple that launches the bundled runtime: `(exe_path,)` in exe mode, `(node_path, bin_js_path)` in node mode. Mode selection: explicit argument > `DSH_RUNTIME_MODE` env var (`exe` | `node`) > automatic. Automatic resolution finds the production exe ONLY — the dev-only node carrier must be opted into explicitly so a production deployment can never silently ride on a source build.
- `bundled_runtime_path() -> Path` — the platform exe path (exe carrier only; the node carrier has no single-path equivalent and launches via the argv tuple above).
- `bundled_default_config_path() -> Path` — the checked-in default config (see below).
- `bundled_package_dir() -> Path` — the installed package data root.

## Zero-config design

The runtime binary always demands an explicit config (`$DSH_CORDIS_CONFIG`, or a config path as an argv positional argument) and exits loudly without one — that hard semantic is part of the runtime's design and this package does not soften it. The bin (`dsh-jsonrpc-agent`) boots only the plugins the config lists; the serving surface (the stdio JSON-RPC server) is itself one of its entries (`@deepseek-ai/dsh-jsonrpc`), and without it the booted agent has no channel to the outside. This package checks in `runtime/cordis.yml` (the JSON-RPC serving entry, agent core, preloaded DeepSeek adapter, JSONL session persistence, local bash, each parameterized by the `DSH_*` env vars the SDK sets); when the caller uses no explicit config channel, the `deepseek_harness` client injects that file's path via `DSH_CORDIS_CONFIG` (injection conditions: [sdk README](../sdk/README.md)). Zero-config is thus an explicit, visible parameter pass in the wrapper, not a hidden fallback in the runtime.
