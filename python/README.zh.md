# DeepSeek Harness Python SDK

[English](README.md) | 中文

以子进程方式驱动 DeepSeek Harness 的 Python 包：客户端 SDK spawn `dsh-jsonrpc-agent` 二进制，并通过 stdio 上按行分隔的 JSON-RPC 与之通信。运行时载体是本仓库产出的单文件可执行文件；设计、构建与验收细节见 [docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md](../docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md)。

## 包

| 目录 | 分发名 / 模块 | 职责 |
|---|---|---|
| [sdk](sdk/) | `deepseek-harness` / `deepseek_harness` | 客户端 SDK：高层回合 API `DeepSeekHarness` 与低层 JSON-RPC 客户端 `HarnessClient` |
| [sdk-runtime](sdk-runtime/) | `deepseek-harness-runtime-bin` / `deepseek_harness_runtime` | 运行时载体：定位内置的运行时二进制，并携带默认的 agent（智能体）配置 |

## 构建运行时可执行文件

各平台可执行文件是构建产物，不检入 git。在仓库根目录执行：

```sh
pnpm install
pnpm exec tsx scripts/build-exe-for-python-sdk.ts                 # host platform, ~2 min
pnpm exec tsx scripts/build-exe-for-python-sdk.ts --skip-build    # lib/ artifacts already built
pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets=node24-linux-x64,node24-linux-arm64,node24-macos-arm64
```

产物落入 `dist-exe/`，并同步进本包的 `sdk-runtime/src/deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-<platform>-<arch>`（platform：`linux`/`macos`；arch：`x64`/`arm64`），本地构建完成后 SDK 不需要额外设置就能找到可执行文件。`build-exe-for-python-sdk` CI 工作流（手动触发，或给 PR 打 `build-exe` 标签）会测试同样的二进制，但只保留 4 个发布用 wheel 包。exe 内置哪些插件、载体如何组织，见 [sdk-runtime README](sdk-runtime/README.md)；构建还会顺带刷新仅供开发使用的 `node` 载体（见下文「对着 Node 源码运行」）。

## 用可执行文件验证 SDK

```sh
export UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv"   # keep the venv out of python/
uv sync --project python/sdk --group test
uv run --project python/sdk pytest python/sdk/tests/test_bundled_runtime.py   # boots the real carriers
uv run --project python/sdk pytest                                            # full suite; keyless tests included
```

交互式验证（需要环境变量或仓库根 `.env` 中的 `DEEPSEEK_API_KEY`）：

```python
from deepseek_harness import DeepSeekHarness
with DeepSeekHarness() as harness:
    print(harness.run("say hi").final_response)   # auto-resolution picks the bundled exe
```

## 对着 Node 源码运行 SDK（不用可执行文件）

两种方式，均面向仓库成员：

- **已构建的 `node` 载体**——设置 `DSH_RUNTIME_MODE=node`，SDK 会用系统 Node（>= 22.19）运行 `runtime/node/node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js`。这棵树每次运行构建脚本都会刷新，与 exe 打入 pkg 虚拟文件系统（VFS）的是同一份依赖闭包，因此插件语义一致。它不会被自动选中，也不进入分发物。
- **未构建的源码（tsx）**——把客户端直接指向 `bin` 的 TypeScript 源码，用于编辑、运行和调试：`launch_args_override=("./node_modules/.bin/tsx", "packages/ui/jsonrpc-agent/src/bin.ts")`，`cwd` 设为仓库根，再通过 `cordis=...` 传入配置（或使用默认配置注入）。[sdk/tests/manual_sdk_agent_smoke.py](sdk/tests/manual_sdk_agent_smoke.py) 是现成范例。

## 分发 Python 包

根目录 [`package.json`](../package.json) 的版本是两个 Python 分发物的权威版本。统一暂存脚本读取这个版本并注入两个 wheel 包，同时在 SDK 元数据中钉死相同版本的 `deepseek-harness-runtime-bin==X.Y.Z`；可选的 `python-vX.Y.Z` 发布标签只有与仓库版本匹配时才会被接受。纯 SDK wheel 包只构建一次，运行时 wheel 包则在每个原生平台各构建一个：

```sh
version="$(node -p "require('./package.json').version")"
python scripts/build-python-release.py --package sdk --output-dir dist-python
python scripts/build-python-release.py --package runtime --platform macos-arm64 --runtime-exe dist-exe/dsh-jsonrpc-agent-pkg-macos-arm64 --output-dir dist-python
pip install --find-links dist-python deepseek-harness=="$version"
```

运行时分发物只提供 wheel 包，并拒绝 sdist 构建、缺失可执行文件以及混合平台载荷。三个 wheel 包标签分别是 `py3-none-manylinux_2_28_x86_64`、`py3-none-manylinux_2_28_aarch64` 与 `py3-none-macosx_11_0_arm64`；SDK 保持 `py3-none-any`。匹配的 `python-vX.Y.Z` 标签流水线统一构建并发布这 4 个互不冲突的文件，因此常规的 `pip install deepseek-harness==X.Y.Z` 会选中匹配平台的运行时 wheel 包，`import deepseek_harness` 不需要 `runtime_bin`。

## 零配置语义

运行时二进制本身始终要求显式配置（`$DSH_CORDIS_CONFIG`，或作为首个 argv 参数的配置路径），没有内置兜底，也只启动配置里列出的内容。零配置是 SDK 包装层的行为：调用方没有使用任何显式通道时，客户端把运行时包检入的默认配置（[runtime/cordis.yml](sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml)）注入 `DSH_CORDIS_CONFIG`；任一显式通道存在即优先采用，并禁用注入。注入条件的完整定义见 [sdk README](sdk/README.md)，默认配置的内容与硬语义见 [sdk-runtime README](sdk-runtime/README.md)。

可执行文件也支持直接调用；在 NDJSON JSON-RPC 交互期间保持 stdin 打开，并显式提供配置：

```sh
DSH_CORDIS_CONFIG=/absolute/path/cordis.yml ./dsh-jsonrpc-agent-pkg-macos-arm64
```

## 测试布局

`test_client.py` 完全无需密钥（对端是 Python 假运行时）。`test_bundled_runtime.py` 逐个启动内置载体，某个载体产物缺失时跳过对应用例。`test_runtime_resolution.py` 覆盖载体解析规则，不 spawn 任何进程。
