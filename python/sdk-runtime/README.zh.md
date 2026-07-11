# DeepSeek Harness 运行时 wheel

[English](README.md) | 中文

Python SDK 的运行时载体包（dist 名 `deepseek-harness-runtime-bin`，模块名 `deepseek_harness_runtime`）：它定位 `deepseek-harness` 客户端要 spawn 的内置运行时二进制，并附带支撑零配置运行的默认配置。

## 运行时载体

两种载体并存于 `src/deepseek_harness_runtime/runtime/` 之下，均由仓库的 `scripts/build-exe-for-python-sdk.ts` 构建注入，且均被 gitignore：

- **exe（生产）**——单文件可执行程序 `dsh-jsonrpc-agent-pkg-<platform>-<arch>`（platform：`linux`/`macos`；arch：`x64`/`arm64`）。目标机器无需安装 Node。这是唯一进入 wheel/sdist 分发物的载体。
- **node（仅限开发）**——`runtime/node/` 下的完整 deploy 闭包（`package.json` + `node_modules/`），在系统 Node >= 22.19 上以 `node runtime/node/node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js` 执行。它是当前检出的源码构建，仅用于仓库本地的开发与验证；不会被自动选中，也不进入分发物。

两种载体承载相同的内容，且只定义一次：本包根目录的 [package.json](package.json) 是 single-exe 流水线的 deploy root——一份零代码的纯依赖 manifest，其依赖闭包既是编译进 exe 的插件集，也是物化到 `runtime/node/` 的文件树。往分发物里加插件，就是在那里加一行依赖再重新构建。

载体缺失时抛出 `FileNotFoundError` 并写明获取途径：在 deepseek-harness 检出中经 `scripts/build-exe-for-python-sdk.ts` 构建，或下载 `build-exe-for-python-sdk` CI 工作流的对应平台产物（tar.gz——tar 保留可执行位）并解包到 runtime 目录。获取策略与查找接口刻意分离，之后可以换成按需下载而不动任何调用方。

## 解析 API

- `resolve_bundled_launch_args(mode=None) -> tuple[str, ...]`——启动内置运行时的 argv 元组：exe 模式下为 `(exe_path,)`，node 模式下为 `(node_path, bin_js_path)`。模式选择：显式参数 > `DSH_RUNTIME_MODE` 环境变量（`exe` | `node`）> 自动。自动解析只找生产 exe——仅限开发的 node 载体必须显式选用，从而生产部署绝不会悄悄跑在源码构建上。
- `bundled_runtime_path() -> Path`——平台 exe 路径（仅 exe 载体；node 载体没有单一路径的等价物，经由上面的 argv 元组启动）。
- `bundled_default_config_path() -> Path`——检入的默认配置（见下文）。
- `bundled_package_dir() -> Path`——已安装包的数据根目录。

## 零配置设计

运行时二进制始终要求显式配置（`$DSH_CORDIS_CONFIG`，或作为 argv 位置参数的配置路径），缺了就报错退出——这一硬语义是运行时设计的一部分，本包不软化它。bin（`dsh-jsonrpc-agent`）只启动配置里列出的插件；服务面（stdio JSON-RPC 服务器）也是其中一个条目（`@deepseek-ai/dsh-jsonrpc`），缺了它启动出的 agent 没有对外通道。本包检入 `runtime/cordis.yml`（JSON-RPC 服务条目、agent core、预载的 DeepSeek 适配器、JSONL 会话持久化、本地 bash，各项由 SDK 设置的 `DSH_*` 环境变量参数化）；调用方未走任何显式配置通道时，`deepseek_harness` 客户端把该文件路径注入 `DSH_CORDIS_CONFIG`（注入条件见 [sdk README](../sdk/README.md)）。零配置因此是 wrapper 里一次显式、可见的参数传递，不是运行时里的隐藏回退。
