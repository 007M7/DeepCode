# DeepSeek Harness Python SDK

English | [中文](README.zh.md)

Python packages for driving DeepSeek Harness as a subprocess: a client SDK that spawns the `dsh-jsonrpc-agent` binary and talks newline-delimited JSON-RPC over stdio. The runtime carrier is the single-file executable produced by this repo; design, build, and acceptance details live in [.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md](../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).

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

Products land in `dist-exe/` and are synced into this package as `sdk-runtime/src/deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-<platform>-<arch>` (platform: `linux`/`macos`; arch: `x64`/`arm64`); macOS builds also sync the matching `-spawn-helper` required by `node-pty`. After a local build the SDK finds the runtime with no further setup. The `build-exe-for-python-sdk` CI workflow (manual dispatch, or the `build-exe` PR label) exercises the same products. A full three-target run retains four release wheels; a subset dispatch retains the SDK wheel and selected platform wheels. Which plugins the exe bundles and how the carriers are organized: [sdk-runtime README](sdk-runtime/README.md); the build also refreshes the dev-only node carrier (see "against the Node source" below).

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
with DeepSeekHarness() as harness:
    print(harness.run("say hi").final_response)   # auto-resolution picks the bundled exe
```

## Running the SDK against the Node source (no executable)

Two flavors, both for repo members:

- **Built node carrier** — set `DSH_RUNTIME_MODE=node` and the SDK runs `runtime/node/node_modules/@deepseek-ai/dsh-jsonrpc-demo/lib/bin.js` on the system Node (>= 22.19). The tree is refreshed on every build-script run and is the same dependency closure the exe snapshots, so plugin semantics are identical. Never auto-selected, never distributed.
- **Unbuilt source (tsx)** — point the client straight at the bin's TypeScript source for edit-run loops and debugging: `launch_args_override=("./node_modules/.bin/tsx", "packages/examples/jsonrpc-demo/src/bin.ts")` with `cwd` at the repo root, plus a config via `cordis=...` (or rely on the default-config injection). [sdk/tests/manual_sdk_agent_smoke.py](sdk/tests/manual_sdk_agent_smoke.py) is the worked example.

## Distributing the Python packages

The root [`package.json`](../package.json) version is authoritative for both Python distributions. The common staging script reads that version, injects it into both wheels, and pins the SDK metadata to the same `deepseek-harness-runtime-bin==X.Y.Z`; an optional `python-vX.Y.Z` release tag is accepted only when it matches the repository version. Build the pure SDK wheel once and one runtime wheel on each native platform:

```sh
version="$(node -p "require('./package.json').version")"
python scripts/build-python-release.py --package sdk --output-dir dist-python
python scripts/build-python-release.py --package runtime --platform macos-arm64 --runtime-exe dist-exe/dsh-jsonrpc-agent-pkg-macos-arm64 --output-dir dist-python
pip install --find-links dist-python deepseek-harness=="$version"
```

The runtime distribution is wheel-only and rejects sdist builds, missing executables, and mixed-platform payloads. Its three wheel tags are `py3-none-manylinux_2_28_x86_64`, `py3-none-manylinux_2_28_aarch64`, and `py3-none-macosx_11_0_arm64`; the SDK remains `py3-none-any`. A matching `python-vX.Y.Z` tag pipeline builds these four non-conflicting files and publishes them together, so a normal `pip install deepseek-harness==X.Y.Z` selects the matching runtime wheel and `import deepseek_harness` needs no `runtime_bin`.

## Zero-config semantics

The runtime binary itself always requires an explicit config (`$DSH_CORDIS_CONFIG`, or a config path as the first argv argument), has no built-in fallback, and boots only what the config lists. Zero-config is SDK wrapper behavior: when the caller uses no explicit channel, the client injects the runtime package's checked-in default configuration ([runtime/cordis.yml](sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml)) via `DSH_CORDIS_CONFIG`; any explicit channel wins and disables the injection. The full injection conditions live in the [sdk README](sdk/README.md); the default config's contents and the hard semantic in the [sdk-runtime README](sdk-runtime/README.md).

The executable is also a supported direct interface; keep stdin open for the NDJSON JSON-RPC exchange and supply a config explicitly:

```sh
DSH_CORDIS_CONFIG=/absolute/path/cordis.yml ./dsh-jsonrpc-agent-pkg-macos-arm64
```

## Test layout

`test_client.py` is fully keyless (a Python fake runtime is the peer). `test_bundled_runtime.py` boots each bundled carrier and skips per carrier when its artifact is missing. `test_runtime_resolution.py` covers the carrier-resolution rules without spawning anything.
