# RFC: 单文件可执行的 SDK 运行时分发（single-exe）

Status: implemented

[English](2026-07-10-single-file-executable-sdk-runtime-distribution.md) | 中文

## 问题

DeepSeek Harness 需要为 Python 库专门提供一个免安装 Node、可直接在目标平台运行的 SDK 分发形态：一个单文件可执行程序（下称 exe），对外提供 stdio JSON-RPC 服务面（`HarnessSdkServer`，Python SDK 的对端），且实际启动的插件与配置完全由 exe 外部输入的 `cordis.yml` 决定。

- 与 Python SDK 通信的 JSONRPC 协议已经过验证
- 需要提供标准化的 cordis.yml 加载所有插件（ESModule）的能力
- 分发物要自带 Node 运行时，并支持本地源码链接的调试模式

## 决策

### 打包路线：@yao-pkg/pkg 的 `--sea` 模式

exe 用 [@yao-pkg/pkg](https://github.com/yao-pkg/pkg)（vercel/pkg 归档后的活跃维护 fork）的 **`--sea`（enhanced SEA）模式**打包。相比 Node 原生 SEA，pkg 在其上加装 `/snapshot` VFS 与运行时模块钩子，ESM 入口原样交给 Node 默认 ESM loader，不依赖任何 ESM→CJS 转译。
> 实测（macos-arm64、node24 target、pkg 6.21.0）：VFS 内裸包名 ESM 动态 import（含顶层 await）、CJS 互操作、`node:sqlite`、集合外包名 fail loud、VFS 外磁盘 ESM import 全部通过，`import.meta.url` 原样为 `file:///snapshot/...`。

`--sea` 要求 target ≥ node22，exe 统一以 node24 为 target；单次 pkg 调用只打一个 target，多平台各调一次。

术语提醒：pkg 的 `/snapshot` VFS 与本仓库测试体系的「snapshot」（ACP replay goldens、`$DSH_SNAPSHOT`）无关，本文用「VFS」指前者。

### serving 面是插件：ui/jsonrpc + ui/jsonrpc-agent 两包

确定性协议实现（`server.ts` / `transport.ts`）按 `ui/acp` + `ui/acp-agent` 的既有模式落为两包——serving 面本身也是插件：

- [`packages/ui/jsonrpc`](../../../../packages/ui/jsonrpc/README.md)（`@deepseek-ai/dsh-jsonrpc`）：纯协议插件，apply 时在进程 stdio 上挂 `HarnessSdkServer` + 行式 JSON-RPC transport，disposal 走 `ctx.effect()`。是否服务由 `cordis.yml` 决定；一份 yml 没挂它就是一个不 serve 的合法进程。协议级退出归插件（`shutdown` 请求应答后 dispose 自身 fiber 再 `exit(0)`；HMR 式卸载只停服务不退进程）。
- [`packages/ui/jsonrpc-agent`](../../../../packages/ui/jsonrpc-agent/README.md)（`@deepseek-ai/dsh-jsonrpc-agent`）：薄 app bin——`installFailLoud` + `loadEnv` + 配置发现 + [`dsh-app-boot`](../../../../packages/ui/app-boot/src/index.ts) 的 `boot()`，boot 完即毕，server 由 yml 里的 `dsh-jsonrpc` 条目带起。依赖只有 app-boot。进程级退出归 bin（stdin EOF/SIGTERM → dispose 后 0，SIGINT → 130）。

配置发现两通道，缺失即报错：`DSH_CORDIS_CONFIG` 环境变量优先（SDK 客户端约定），argv 位置参数次之；无任何默认路径或内置回退——「实际启动的插件由外部 cordis.yml 决定」是硬语义。

### 插件解析：VFS 装真实包树，闭包清单即 deploy root

exe 的 VFS 内是**构建产物形态的真实包树**（各包 `lib/` + 真实 `node_modules`），Loader 解析插件名走标准动态 `import()`：裸包名从 VFS 内 Loader 位置沿 `node_modules` 向上解析，天然落在 VFS 内。封闭集不需要白名单代码——集合就是 VFS 里装了什么，引用集合外的名字 import 失败。

deploy root 是 [`python/sdk-runtime/package.json`](../../../../python/sdk-runtime/package.json)（`dsh-jsonrpc-agent-pkg`，pnpm workspace 成员、零代码纯依赖清单）——「exe 装什么插件」与「Python runtime 分发什么」的合一事实源。往 exe 加插件 = 清单加一行依赖再重打包。[`scripts/verify-runtime-closure.ts`](../../../../scripts/verify-runtime-closure.ts) 遍历该清单覆盖的全部 workspace 包，要求每个非 optional workspace peer 显式列在 runtime root，并报告「引用包 → 缺失 peer」的完整链路；CI static、pre-push 与 single-exe 构建都会在打包前运行该门禁。deploy 还会按各包 `files` 打包，因此 tsdown 拆出的共享 chunk 必须被 `files` 覆盖。

### 构建管线与产物

[`scripts/build-exe-for-python-sdk.ts`](../../../../scripts/build-exe-for-python-sdk.ts)：runtime 闭包校验 → `pnpm run build` →（清空后）`pnpm --filter dsh-jsonrpc-agent-pkg deploy --legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true` **直落** `python/sdk-runtime/src/deepseek_harness_runtime/runtime/node/`→ 注入 pkg 配置（`bin` 指闭包内 `node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js`，`assets` 全量 glob——动态 import 对 pkg 静态分析不可见，必须显式全量打入）→ 每 target 一次 `pkg --sea` → 可执行文件 `dsh-jsonrpc-agent-pkg-<platform>-<arch>` 落 `dist-exe/` 并拷回 runtime 目录。CI 把它们作为测试中间输入，只保留对应的平台 wheel。deploy 四 flag 均有实测依据：`--legacy` 是未开 inject-workspace-packages 时的必选路径；hoisted 产出零符号链接文件树（pkg VFS 最稳、物理保证 cordis 单实例）；关 peer 自动安装避免未发布包名触发 registry 解析；link-workspace-packages 让闭包指向 workspace/vendor 源。

CI：[`.github/workflows/build-exe-for-python-sdk.yml`](../../../../.github/workflows/build-exe-for-python-sdk.yml)，仅显式触发——`workflow_dispatch` 手动派发，或给 PR 打 `build-exe` 标签；linux-x64 / linux-arm64（`ubuntu-24.04-arm`）/ macos-arm64 三平台原生构建，并缓存 `~/.pkg-cache`；macOS ad-hoc 签名由 pkg 处理。每个平台都以 mock SSE 模型分别通过默认配置和自定义 `cordis.yml` 驱动 SDK，再以 NDJSON JSON-RPC 直接驱动 exe，校验 JSONL 与最终响应，最后把 release 形态的 wheel 安装到干净 venv 中并在不传 `runtime_bin` 的情况下运行；Linux 还检查 GLIBC 依赖并在 manylinux 2.28 容器中运行。整次运行只保留 4 个产物，每个只含一个发布文件：平台无关的 SDK wheel 与 3 个原生 runtime wheel；裸 exe 和源码 bundle 只作为测试中间输入。[`.gitlab-ci.yml`](../../../../.gitlab-ci.yml) 只接受版本与根目录 `package.json` 匹配的 `python-vX.Y.Z` tag 流水线，构建一个 SDK wheel 与 3 个原生 runtime wheel，再由单个串行 job 校验并发布这 4 个文件到项目 PyPI 注册表。Windows 是非目标。

### Python SDK 分发：双载体，exe 为生产、node 为开发

Python SDK 位于 [`python/`](../../../../python/README.md)：`python/sdk`（客户端）+ `python/sdk-runtime`（运行时载体包）。runtime 包数据目录三类内容：检入的默认 `runtime/cordis.yml`、构建注入的平台 exe、构建注入的 `runtime/node/` 闭包树。`resolve_bundled_launch_args()` 自动解析**只找 exe**；node 载体仅显式 `DSH_RUNTIME_MODE=node` 启用（跑 `runtime/node/node_modules/@deepseek-ai/dsh-jsonrpc-agent/lib/bin.js`，需系统 node ≥22.19），定位是本仓库成员的开发验证通道，不进 wheel 分发物。

[`scripts/build-python-release.py`](../../../../scripts/build-python-release.py) 从仓库根目录 `package.json` 读取权威的稳定 `X.Y.Z`，并以该版本暂存两个包，同时让 SDK 精确依赖 `deepseek-harness-runtime-bin==X.Y.Z`。可选的 `python-vX.Y.Z` 发布 tag 只是一项一致性断言，与仓库版本不同时会被拒绝；源码 `pyproject.toml` 中的开发占位版本从不决定发布版本。SDK 是 `py3-none-any` wheel；只提供 wheel 的 runtime 包恰好包含一个 exe，tag 为 `py3-none-manylinux_2_28_x86_64`、`py3-none-manylinux_2_28_aarch64` 或 `py3-none-macosx_11_0_arm64`。其 Hatch 钩子拒绝 sdist、通用 tag、混合可执行载荷以及不支持的平台。

exe「必须显式配置」的硬语义不变；零配置体验由 wrapper 恢复：调用方没给 `cordis`、没显式指定 runtime、环境无 `DSH_CORDIS_CONFIG` 时，客户端把检入的默认 `cordis.yml`（agent-core + 预载 llm-deepseek + JSONL 持久化 + bash-local + `dsh-jsonrpc` serving 条目，`!!js` 环境变量兜底）显式注入 `DSH_CORDIS_CONFIG`。

### 命名血统

`@deepseek-ai/dsh-jsonrpc-agent`（包）→ `dsh-jsonrpc-agent`（bin）→ `dsh-jsonrpc-agent-pkg`（闭包清单；无 scope 前缀，刻意避开 constraints 对 `@deepseek-ai/dsh-*` 的包形状规则）→ `dsh-jsonrpc-agent-pkg-<platform>-<arch>`（exe 产物）。wire `serverInfo.name` 保持 `deepseek-harness-sdk-runtime`（协议稳定值）；Python dist 名为 `deepseek-harness` / `deepseek-harness-runtime-bin`。

## 工作线程插件

exe 内支持 `dsh-workflow-workerthread` 与 `dsh-code-runtime-worker`。两个后端的构建入口都通过 `fileURLToPath()` 转换相邻 worker 的 URL，再将所得文件系统字符串传给 `Worker`；pkg 的 Worker 钩子可以用这种形式解析 VFS 内文件。工作流引擎在未构建的源码执行中仍保留 data URL 引导程序，只有构建后的相邻入口使用文件系统字符串。自定义配置的可执行文件冒烟测试会加载两个后端，实际调用 `run_code` 与不启动 agent 的 `workflow`，并要求两个 worker 都从 pkg 的 VFS 内返回 `42`。

## 测试

验证面分三层。机制层：`--sea` 链路的实测结论内嵌在「决策」各节（VFS 内 ESM 动态 import、cordis 单实例、fail-loud 配置链路、`node:sqlite`、macOS ad-hoc 签名可运行）。SDK 层：完整的 keyless pytest 套件以假运行时对端覆盖客户端协议、子进程清理、绝对 cwd 传递、双载体启动与载体解析；根 CI 在 Python 3.10 上运行全部用例。端到端层：每个平台构建都通过默认 SDK 路径、自定义配置和直接二进制协议对着 mock 端点完成一个轮次，并校验最终文本与 JSONL。自定义配置还会通过打包进 VFS 的真实 worker 文件执行 `run_code` 和不启动 agent 的 `workflow`。随后把平台 wheel 安装进干净 venv，在不传 `runtime_bin` 的情况下运行。JSON-RPC 协议不在 ACP snapshot 体系内，无 snapshot 层（点名后的明确空缺，非遗漏）。

手工驱动注意：bin 视 stdin EOF 为「客户端已走」并立即 dispose，短命管道会中止在飞回合——管道驱动必须保持 stdin 打开到回合结束。

## 曾考虑的替代方案

**Node 原生 SEA 裸用。** 注入主脚本必须是 CJS 单文件、blob 内无文件系统与模块解析，动态 import 裸包名无从解析，只能把插件静态编译进主脚本并手工注册——绕过标准模块解析、插件集合被硬编码，与「配置决定一切」相悖。最终路线实为「官方 SEA 地基 + pkg 的 VFS/模块钩子层」，否掉的是裸用而非 SEA 本身。

**pkg standard 模式。** PoC 判死，非取舍：它把 ESM 经 esbuild 转 CJS + V8 字节码，运行时 vm 编译未接动态 import 回调，任何 `import()` 一律抛 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`，`--options experimental-require-module` 无效；且依赖社区补丁 Node 二进制（macos-arm64 无预编译，现场源码编译约 10 分钟）。对本仓库架构零可行性。

**每包 ESM→CJS 预打包进 VFS。** 保持真实解析语义、只降级模块格式的折中；`--sea` 直接通过实测，这层构建复杂度无需引入。

**jsonrpc-agent 背全量闭包依赖。** app bin 声明 53+ 个它不 import 的依赖，「打包清单」冒充真实依赖关系，且迫使 constraints 为其开 cordis-in-dependencies 与 files-通配两个例外。闭包清单落在 python 侧的清单包上，constraints 无需任何例外，bin 保持与 acp-agent 同构的正常包形状。

**开放插件集（磁盘加载用户插件）。** 本期封闭集；PoC 顺带证实 VFS 外磁盘 ESM import 可行（经 `ctx.baseUrl` 相对路径通道），列为后续演进，需另解外部插件与 exe 内 cordis 实例的共享问题。

## 后果

**买到的**：目标平台零依赖单文件分发；插件语义与源码运行严格一致（同一棵真实包树，无转译无注册表）；serving 面、插件集、配置三者全部收敛到 `cordis.yml` + 一份依赖清单两个事实源；exe 与 node 双载体同树同语义，开发验证不必等打包；官方 Node 二进制消除了补丁二进制供应链顾虑。

**付出的**：产物 174MB 级且源码原样进 blob（无字节码混淆，闭源分发诉求需另行评估）；pkg 的 VFS/模块钩子层仍是社区维护（构建脚本钉死 `@yao-pkg/pkg@6.21.0`，升级走显式改动）；`--sea` 每个 target 调用一次（与 CI 每平台一腿匹配，本地多平台构建串行）。
