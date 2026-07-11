# DeepSeek Harness Python SDK

English | [中文](README.zh.md)

Python packages for driving DeepSeek Harness as a subprocess: a client SDK that spawns the `dsh-jsonrpc-agent` binary and talks newline-delimited JSON-RPC over stdio. The runtime carrier is the single-file executable produced by this repo; design, build, and acceptance details live in [docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md](../docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).

## Packages

| Directory | Dist / module | Role |
|---|---|---|
| [sdk](sdk/) | `deepseek-harness` / `deepseek_harness` | Client SDK: the `DeepSeekHarness` high-level turns API and the lower-level `HarnessClient` JSON-RPC client |
| [sdk-runtime](sdk-runtime/) | `deepseek-harness-runtime-bin` / `deepseek_harness_runtime` | Runtime carrier: locates the bundled runtime binaries and ships the default agent configuration |

## Building the runtime executable

The platform executables are build artifacts, not checked into git. From the repo root:

```sh
pnpm install
pnpm exec tsx scripts/build-exe-for-python-sdk.ts                 # host platform, ~2 min
pnpm exec tsx scripts/build-exe-for-python-sdk.ts --skip-build    # lib/ artifacts already built
pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-linux-x64,node24-linux-arm64,node24-macos-arm64
```

Products land in `dist-exe/` (CI artifact shape) and are synced into this package at `sdk-runtime/src/deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-<platform>-<arch>` (platform: `linux`/`macos`; arch: `x64`/`arm64`) — after a build the SDK finds the executable with no further setup. Alternatively, download the platform artifact from the `build-exe-for-python-sdk` CI workflow (manual dispatch, or the `build-exe` PR label) and place it at that same path. Which plugins the exe bundles and how the carriers are organized: [sdk-runtime README](sdk-runtime/README.md); the build also refreshes the dev-only node carrier (see "against the Node source" below).

## Validating the SDK against the executable

```sh
export UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv"   # keep the venv out of python/
uv sync --project python/sdk --group test
uv run --project python/sdk pytest python/sdk/tests/test_bundled_runtime.py   # boots the real carriers
uv run --project python/sdk pytest                                            # full suite; keyless tests included
```

For an interactive check (needs `DEEPSEEK_API_KEY` in the environment or the repo-root `.env`):

```python
from deepseek_harness import DeepSeekHarness
print(DeepSeekHarness().run("say hi").final_response)   # auto-resolution picks the bundled exe
```

## Running the SDK against the Node source (no executable)

Two flavors, both for repo members:

- **Built node carrier** — set `DSH_RUNTIME_MODE=node` and the SDK runs `runtime/node/node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js` on the system Node (>= 22.19). The tree is refreshed on every build-script run and is the same dependency closure the exe snapshots, so plugin semantics are identical. Never auto-selected, never distributed.
- **Unbuilt source (tsx)** — point the client straight at the bin's TypeScript source for edit-run loops and debugging: `launch_args_override=("./node_modules/.bin/tsx", "packages/ui/jsonrpc-agent/src/bin.ts")` with `cwd` at the repo root, plus a config via `cordis=...` (or rely on the default-config injection). [sdk/tests/manual_sdk_agent_smoke.py](sdk/tests/manual_sdk_agent_smoke.py) is the worked example.

## Distributing the Python packages

Build one wheel per package; the runtime wheel embeds whatever executables are present under `runtime/` at build time (and always the default `cordis.yml`), and excludes `runtime/node/`:

```sh
(cd python/sdk-runtime && uv build)   # or: hatch build
(cd python/sdk && uv build)
pip install dist/deepseek_harness_runtime_bin-*.whl dist/deepseek_harness-*.whl
```

Once the binaries are in place (built or downloaded), installing the two wheels (or `pip install ./python/sdk-runtime ./python/sdk` straight from the directories) gives a working zero-config `DeepSeekHarness()`. Two pre-release caveats: the runtime wheel is currently tagged `py3-none-any` while embedding platform-specific binaries — build it with only the matching platform's exe in place (one wheel per platform), or drop all three exes in for a fat universal wheel (~500 MB); and versioning/publishing policy (`0.0.0-dev`, no registry) is deliberately unset until the first tagged release.

## Zero-config semantics

The runtime binary itself always requires an explicit config (`$DSH_CORDIS_CONFIG`, or a config path as the first argv argument), has no built-in fallback, and boots only what the config lists. Zero-config is SDK wrapper behavior: when the caller uses no explicit channel, the client injects the runtime package's checked-in default configuration ([runtime/cordis.yml](sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml)) via `DSH_CORDIS_CONFIG`; any explicit channel wins and disables the injection. The full injection conditions live in the [sdk README](sdk/README.md); the default config's contents and the hard semantic in the [sdk-runtime README](sdk-runtime/README.md).

## Test layout

`test_client.py` is fully keyless (a Python fake runtime is the peer). `test_bundled_runtime.py` boots each bundled carrier and skips per carrier when its artifact is missing. `test_runtime_resolution.py` covers the carrier-resolution rules without spawning anything.
