# Python SDK 快速上手

[English](python-sdk.md) | 中文

本教程介绍如何安装 Python SDK、在不使用 Web UI 的情况下运行仓库内置 Cordis 组合，以及如何在自己的程序中调用同一套 API。教程使用精简且完整的 [`minimal.cordis.yml`](../../../examples/jsonrpc-agent/minimal.cordis.yml) 作为示例，其中包含可配置的系统提示词、双工具目录和持久 shell 行为，并关闭上下文压缩（context compaction）。

## 前置要求

- Python 3.10 或更高版本
- Linux x64、Linux arm64 或 macOS arm64
- DeepSeek 兼容的 API 端点与凭据
- agent 可以修改的隔离 workspace

## 安装 SDK

可以选择安装公开包或从源码构建。两种方式都会安装 `deepseek-harness-sdk` 分发包，并提供 `deepseek_harness` Python 模块。

### 从 PyPI 安装

请创建虚拟环境，并安装 SDK 及其同版本内置运行时：

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness-sdk
```

### 从源码构建

从源码构建还需要 Git、Node.js ^22.19 或 >= 24、通过 Corepack 启用的 pnpm 11，以及 `uv`。以下命令为当前受支持的宿主平台构建运行时和两个 wheel 包，并将它们安装进当前虚拟环境：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness
cd deepseek-harness
python -m pip install uv==0.11.23
corepack enable
pnpm install

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) runtime_platform=linux-x64 ;;
  Linux:aarch64|Linux:arm64) runtime_platform=linux-arm64 ;;
  Darwin:arm64) runtime_platform=macos-arm64 ;;
  *) echo "unsupported platform" >&2; exit 1 ;;
esac

pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets="node24-$runtime_platform"
version="$(node -p "require('./package.json').version")"
python scripts/build-python-release.py --package sdk --output-dir dist-python
python scripts/build-python-release.py \
  --package runtime \
  --platform "$runtime_platform" \
  --runtime-exe "dist-exe/dsh-jsonrpc-agent-pkg-$runtime_platform" \
  --output-dir dist-python
python -m pip install --find-links dist-python "deepseek-harness-sdk==$version"
```

运行时 wheel 包含 JSON-RPC 可执行文件，以及完整 [`minimal.cordis.yml`](../../../examples/jsonrpc-agent/minimal.cordis.yml) 使用的每个插件，因此两种安装方式完成后都不再需要 Node.js。

## 运行仓库内置示例

请在环境中设置凭据。如果模型不是由默认 DeepSeek 端点提供，而是通过 OpenAI 兼容代理提供，还需要设置 `DEEPSEEK_BASE_URL`。

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
# export DSH_MODEL=deepseek-v4-flash
# export DSH_SYSTEM_PROMPT='You are a helpful software engineer assistant.'
```

从仓库 checkout 运行一个任务：

```sh
python examples/jsonrpc-agent/minimal.py \
  --workspace /absolute/path/to/workspace \
  --session-root /absolute/path/to/sessions \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

脚本会打印 assistant 的最终回复。会话根目录会收到 JSONL 会话日志，其中包含组装后的模型请求与每次工具调用。

## 在自己的程序中使用 SDK

该示例是以下 SDK 调用的轻量包装层：

```python
from pathlib import Path

from deepseek_harness import DeepSeekHarness

config = Path("examples/jsonrpc-agent/minimal.cordis.yml").resolve()
workspace = Path("/absolute/path/to/workspace").resolve()
sessions = Path("/absolute/path/to/sessions").resolve()

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cwd=str(workspace),
    session_root=str(sessions),
    cordis=str(config),
) as harness:
    result = harness.run(
        "Inspect the repository and fix the failing tests.",
        session_id="example-001",
    )

print(result.final_response)
```

`DeepSeekHarness` 会延迟启动内置 JSON-RPC 运行时，并持续复用，直至退出上下文管理器。在多次调用中复用同一个 harness 和 session id，还会保留该会话拥有的 Bash 进程，包括其工作目录、已导出的变量与 shell 函数。

## 了解示例配置

| 属性 | 值 |
|---|---|
| 系统提示词 | `DSH_SYSTEM_PROMPT`；未设置时使用 `You are a helpful software engineer assistant.` |
| `minimal.py` 使用的模型 | `--model`，其次为 `DSH_MODEL`，最后为 `deepseek-v4-flash` |
| 面向模型的工具 | 仅持久 `bash` 与 `str_replace_editor` |
| Bash 超时 | 300 秒 |
| 编辑器输出上限 | 16,000 个字符 |
| 上下文压缩 | 已关闭 |
| 文件系统 | 裸本地后端；编辑器使用绝对路径，可以访问运行时进程可见的任何路径 |
| 会话持久化 | `DSH_SESSION_ROOT` 下未压缩的 JSONL |

该配置省略了 harness 身份、workspace 提示词文本、skill（技能）、一次性 Bash、任务工具、上下文压缩和其他所有面向模型的插件。沙箱策略事实记录为运行时用户上下文，而不会追加到系统提示词中。编辑器无条件要求绝对路径，因此配置中没有已经废弃的 `requireAbsolutePath` 选项。

## 选择 workspace 与 session id

`cwd` 用于选择 agent 可访问的 workspace，`session_root` 用于保存会话日志和状态。独立任务应使用新的 session id；只有下一次调用需要延续同一段对话和持久 shell 状态时，才复用原有 id。

该组合使用 `danger-full-access`。只能在可丢弃的 checkout 或容器内运行：Bash 与编辑器可以修改运行时进程有权访问的任何路径。持久 PTY 后端需要 POSIX 终端环境，因此该组合不支持 Windows agent。

完整的 SDK 生命周期与结果约定见 [Python SDK 参考](../../../python/sdk/README.md)。Cordis 组合语法见[配置](./config.md)。
