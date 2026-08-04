# `@deepseek-ai/dsh`

[English](README.md) | 中文

`dsh` 命令有三种入口模式：必需的原始配置 overlay、一次性 headless 提示词，以及 Web UI。[`src/args.ts`](src/args.ts) 拥有 Commander 命令行语法，[`src/bin.ts`](src/bin.ts) 只会动态导入选中模式的运行器。未知命令和误传入其他模式的选项都会以非零代码退出。

## 原始配置

原始 `dsh` 要求显式传入一份 patch 列表配置：

```sh
dsh --config ./app.cordis.yml
```

指定文件会通过 Include 插件的 patch 算法，直接应用在 [`config/base.cordis.yml`](config/base.cordis.yml) 之上。它不是完整替换树，系统也不会添加个人 `$DSH_HOME/config.yaml` 或其他 surface overlay。base 有意不包含启动 agent（智能体）或交互入口；必需的 overlay 负责选择这些部署细节。相对配置路径以调用目录为基准解析。配置解析、schema 校验、模块解析或插件启动失败都会被报告，并以非零代码退出。SIGINT 和 SIGTERM 会在退出前 dispose（资源释放）已挂载的根上下文。

patch 通过 `id` 定位 base 配置项，并替换该配置项的完整 `config` 值，而不是深度合并各个键。它也可以插入新配置项：

```yaml
- id: agent-loop
  config:
    agents:
      - id: main
        provider: deepseek-official
        model: deepseek-v4-flash
```

可以在不启动应用的情况下检查有效配置树：

```sh
dsh --dump-default-config
dsh --config ./app.cordis.yml --dump-config
```

`--dump-default-config` 只打印随附 base。`--dump-config` 要求提供 `--config`，并打印带来源注释的 base 与 overlay。组合过程使用 `@cordisjs/plugin-include` 的 `applyEntryPatches` 和 `entryListSchema`；`!!js` 表达式保持未求值状态，未匹配的 patch 目标会报告到 stderr。

## Web 与 headless

`dsh web` 会启动 `base.cordis.yml` 加 [`config/web.cordis.yml`](config/web.cordis.yml)，并在 `$DSH_HOME/config.yaml` 存在时继续应用该文件。`dsh web --config <path>` 会以显式 patch 列表替换个人层。`--host`、`--port`、`--workspace-root` 和可重复的 `--trusted-host` 值会转为 Web 宿主 patch；各自所属插件的 schema 会在启动时校验它们。`--dev` 会挂载客户端插件 HMR（热模块替换）接收器，要实现无需刷新的客户端 bundle 更新，还需单独运行 `pnpm run dev:web` watcher。

```sh
dsh web
dsh web --config ./web-profile.cordis.yml
dsh web --dump-default-config
dsh web --dump-config
```

生产 Web 运行器需要已构建的包（package）与前端产物（`pnpm run build`）。它默认通过 `http://127.0.0.1:3080` 提供服务。绑定所有网络接口时，系统也会信任本机探测到的 LAN IP 字面量；`--trusted-host` 可添加 `/api` 浏览器信任边界所接受的具名权威。

`dsh -p "task"` 使用相同的 base 与 Web 组合及启动时个人配置，在由操作系统分配的端口上启动 Web 宿主，运行一个全新的持久会话，打印最终答案后退出。它不接受 `--config` 或原始配置输出标志。

Web 与 headless 的进程关闭流程最多给插件树 5 秒执行 dispose。第一次 `SIGINT`/`SIGTERM` 会启动这次优雅排空；第二次信号会立即强制退出。如果 headless 的正常完成流程已经卡在 dispose 中，第一次 `Ctrl+C` 就会触发强制退出：进程立即结束，该信号不再被吞掉。

两种模式都以调用目录作为默认 workspace 根目录，加载适用的 `AGENTS.md` 或 `CLAUDE.md` 指令，渲染预算为 65,536 字节，并使用内存 SQLite 会话内容索引。Web 会持续应用有效的个人配置编辑；headless 只在启动时读取该文件一次。层次优先级、凭据存储、实时更新失败行为与 `$DSH_HOME` 解析均由 [app-boot 个人配置契约](../../packages/ui/app-boot/README.md#personal-config) 统一定义。

新会话默认使用 `workspace-write` 权限 preset。Bash 和文件系统写操作受限于会话 workspace 与平台临时根目录；读取、网络访问与进程可见性不受限制。`DSH_PERMISSION_MODE` 会改变进程回退值。已存储的常规设置权限会影响之后的 Web 会话，不会更改已打开的会话。

`DSH_TOOLS_MODE` 为 Web/headless 进程选择 `native`、`code` 或 `both`；其他值会在启动时失败。[`config/core-web.cordis.yml`](config/core-web.cordis.yml) 是可选的 Web overlay，它在保留随附宿主、浏览器、workspace、持久化与权限组合的同时，将面向原生模型的工具缩减为持久 `bash` 和 `str_replace_editor`。

## 共享部署行为

base 会挂载原生 DeepSeek 适配器、设置与凭据提供方、稳定的 `web_search`、仓库插件支持与会话遥测。提供方凭据位于 `$DSH_HOME/.env` 或环境中，且仍可轮换，因为启动器绝不会把凭据文件提升进 `process.env`。搜索使用 `DEEPSEEK_API_KEY` 并接受 `DEEPSEEK_SEARCH_BASE_URL`；除非 overlay 插入提供方并启用 `web_fetch`，否则后者处于禁用状态。

会话事件默认以 OTLP/HTTP 日志的形式流式发送。`DSH_TELEMETRY_OTLP_URL` 用于选择其他 collector。`DSH_TELEMETRY_DISABLED` 的任何非空值都会在启动前禁用遥测配置项。随附 base 没有遥测脱敏规则，因此导出记录可能包含消息文本、工具参数与结果，以及 workspace 路径；该部署决策由[遥测 Agent Note](../../.agents/notes/implemented/feature/2026-07-31-web-telemetry-default-mount.md) 统一定义。

空的 `repository-plugins` 配置项允许 Web/headless 个人配置与原始 overlay 挂载已准备的不可变仓库插件 generation。详见[仓库插件契约](../../packages/cordis/repository-plugin/README.md#standalone-app-configuration)。CLI（命令行界面）还将 `@deepseek-ai/dsh-mcp-client` 作为 overlay 依赖发布，但默认不启用任何 MCP 服务器，因为每条服务器命令都是 agent 沙箱之外的受信任可执行代码。

## 源码启动器

将以源码运行的启动器链接到 PATH：

```sh
ln -sf "$(pwd)/bin/dsh" ~/.local/bin/dsh
```

它会通过自身实际路径解析该检出，并使用 `node --import tsx/esm` 启动 `apps/cli/src/bin.ts`。`TSX_TSCONFIG_PATH` 固定指向检出根目录，因此 workspace 包解析不受调用目录影响。`pnpm run dsh` 使用同一入口并转发参数。构建后的形式是执行 `pnpm run build` 后的 `apps/cli/lib/bin.js`。
