# DeepSeek Harness Python SDK

[English](README.md) | 中文

通过 JSON-RPC stdio 驱动 DeepSeek Harness 的 Python 子进程 SDK。运行时继承常规的 DeepSeek Harness 环境变量（如 `DEEPSEEK_BASE_URL` 与 `DEEPSEEK_API_KEY`），调用方可以直接用真实模型端点，也可以在跑基准测试时把它们指向本地代理。

安装 `deepseek-harness` 会同时安装版本完全相同的 `deepseek-harness-runtime-bin` 平台 wheel。因此常规入口不需要传可执行文件参数：

```py
from deepseek_harness import DeepSeekHarness

result = DeepSeekHarness().run("Say hi.")
```

默认情况下，SDK 启动 `deepseek-harness-runtime-bin` 包内置的单文件 `dsh-jsonrpc-agent` 可执行程序，并通过 `DSH_CORDIS_CONFIG` 注入该包的默认配置（stdio JSON-RPC 服务器、agent core、预载的 DeepSeek 适配器、JSONL 会话持久化、本地 bash）。要运行自己用插件组合需要在配置里保留 `@deepseek-ai/dsh-jsonrpc` 条目，并传入 Cordis 配置路径。

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    model="deepseek-v4-flash",
    cordis="examples/dsbench-coding-agent/cordis.yml",
) as harness:
    result = harness.run("Make the requested code change.")
```

`TurnResult.final_response` 是本轮次最后一个 `assistant/message` 事件的文本内容。完整的事件流（包括中间的助手消息与工具活动）用 `TurnResult.events` 获取。

同样的行为也可以用 `DSH_CORDIS_CONFIG` 为运行时子进程选定。注入逻辑位于 `HarnessClient.start()`，因此低层客户端的默认启动同样享有它：当启动解析到内置运行时，且 `cordis` 与非空的 `DSH_CORDIS_CONFIG` 均未设置时（运行时把空值当作缺省，注入检查与之一致），使用内置的默认配置；显式给出 `runtime_bin` 或 `launch_args_override` 则完全禁用注入。运行时载体（生产用 exe 与仅限开发的 node 闭包）及其获取方式见 [sdk-runtime README](../sdk-runtime/README.md)。

`cwd` 与 `runtime_cwd` 会在启动子进程、注入环境变量和协议握手前解析为绝对路径。公开 API 只暴露真正生效的选项：部署 persona 与持久化配置归 `cordis.yml` 管理，而 `session_root` 继续作为设置 `DSH_SESSION_ROOT` 的高层便捷选项。
