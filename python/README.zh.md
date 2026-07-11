# DeepSeek Harness Python SDK

[English](README.md) | 中文

以子进程方式驱动 DeepSeek Harness 的 Python 包：客户端 SDK spawn `dsh-jsonrpc-agent` 二进制，在 stdio 上以换行分隔的 JSON-RPC 与之通信。运行时载体是本仓库产出的单文件可执行文件；设计、构建与验收细节见 [docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md](../docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md)。

## 包

| 目录 | Dist / 模块 | 职责 |
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

产物落入 `dist-exe/`（CI 产物形态），并同步进本包的 `sdk-runtime/src/deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-<platform>-<arch>`（platform：`linux`/`macos`；arch：`x64`/`arm64`），构建完成后 SDK 不需要额外设置就能找到可执行文件。也可以从 `build-exe-for-python-sdk` CI workflow（手动触发）下载对应平台的产物放到同一路径。exe 内置哪些插件、载体如何组织，见 [sdk-runtime README](sdk-runtime/README.md)；构建还会顺带刷新仅供开发用的 node 载体（见下文「对着 Node 源码运行」）。

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
print(DeepSeekHarness().run("say hi").final_response)   # auto-resolution picks the bundled exe
```

## 对着 Node 源码运行 SDK（不用可执行文件）

两种方式，均面向仓库成员：

- **已构建的 node 载体**——设置 `DSH_RUNTIME_MODE=node`，SDK 会用系统 Node（>= 22.19）运行 `runtime/node/node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js`。这棵树每次跑构建脚本都会刷新，与 exe 打进 VFS 的是同一份依赖闭包，插件语义一致。不会被自动选中，也不进入分发物。
- **未构建的源码（tsx）**——把客户端直接指向 bin 的 TypeScript 源码，用于编辑-运行循环与调试：`launch_args_override=("./node_modules/.bin/tsx", "packages/ui/jsonrpc-agent/src/bin.ts")`，`cwd` 设为仓库根，另经 `cordis=...` 传入配置（或依赖默认配置注入）。[sdk/tests/manual_sdk_agent_smoke.py](sdk/tests/manual_sdk_agent_smoke.py) 是现成范例。

## 分发 Python 包

每个包各构建一个 wheel；runtime wheel 会内嵌构建时 `runtime/` 下存在的全部可执行文件（以及始终包含的默认 `cordis.yml`），并排除 `runtime/node/`：

```sh
(cd python/sdk-runtime && uv build)   # or: hatch build
(cd python/sdk && uv build)
pip install dist/deepseek_harness_runtime_bin-*.whl dist/deepseek_harness-*.whl
```

二进制就位（构建或下载）后，安装这两个 wheel（或直接 `pip install ./python/sdk-runtime ./python/sdk` 从目录安装），就得到零配置可用的 `DeepSeekHarness()`。两个 pre-release 注意事项：runtime wheel 目前的标签是 `py3-none-any`，内容却是平台相关的二进制——构建时只放匹配平台的 exe（每平台一个 wheel），或把三个 exe 全部放入做成通用胖 wheel（约 500 MB）；版本与发布策略（`0.0.0-dev`、无 registry）刻意留待首个 tagged release 再定。

## 零配置语义

运行时二进制本身始终要求显式配置（`$DSH_CORDIS_CONFIG`，或作为首个 argv 参数的配置路径），没有内置兜底，也只启动配置里列出的东西。零配置是 SDK 包装层的行为：调用方没有走任何显式通道时，客户端把 runtime 包检入的默认配置（[runtime/cordis.yml](sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml)）注入 `DSH_CORDIS_CONFIG`；任一显式通道存在即胜出并禁用注入。注入条件的完整定义见 [sdk README](sdk/README.md)，默认配置的内容与硬语义见 [sdk-runtime README](sdk-runtime/README.md)。

## 测试布局

`test_client.py` 完全无需 key（对端是 Python 假运行时）。`test_bundled_runtime.py` 逐个启动内置载体，某载体产物缺失时对应用例跳过。`test_runtime_resolution.py` 覆盖载体解析规则，不 spawn 任何进程。
