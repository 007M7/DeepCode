# `dsh` CLI（命令行界面）行为参考

[English](README.md) | 中文

本参考定义原始配置、Web 和无头命令模式。参数由 [`src/args.ts`](../src/args.ts) 统一解析，[`src/bin.ts`](../src/bin.ts) 只动态导入选中的运行器。

## 原始配置

原始 `dsh` 必须提供显式 patch 列表配置：

```sh
dsh --config ./app.cordis.yml
```

指定文件通过 Include 插件的 patch 算法直接应用到 [`config/base.cordis.yml`](../config/base.cordis.yml) 之上。它不是完整替代树，也不会添加个人 `$DSH_HOME/config.yaml` 或其他 surface overlay。基础配置刻意不包含启动 agent（智能体）或交互前端入口；必填 overlay 负责选择这些部署细节。相对配置路径从调用目录解析。配置解析、schema 校验、模块解析或插件启动失败会得到报告并以非零状态退出。收到 SIGINT 或 SIGTERM 时，挂载的根节点会先 dispose（资源释放）再退出。

patch 通过 `id` 定位基础配置行，并替换该行完整的 `config` 值，而不是深度合并各键。patch 列表也可插入新行，只要随附 Loader 能解析其插件模块：

```yaml
- id: agent-loop
  config:
    agents:
      - id: main
        provider: deepseek-official
        model: deepseek-v4-flash
```

可在不启动的情况下检查生效的配置树：

```sh
dsh --dump-default-config
dsh --config ./app.cordis.yml --dump-config
```

`--dump-default-config` 只打印随附基础配置。`--dump-config` 必须与 `--config` 同时使用，并打印基础配置和带来源注释的 overlay。组合使用 `@cordisjs/plugin-include` 的 `applyEntryPatches` 与 `entryListSchema`；`!!js` 表达式保持未求值，找不到目标的 patch 会报告到 stderr。

## Web 与无头模式

`dsh web` 启动 `base.cordis.yml` 加 [`config/web.cordis.yml`](../config/web.cordis.yml)，并在 `$DSH_HOME/config.yaml` 存在时继续加载它。`dsh web --config <path>` 用显式 patch 列表替代该个人层。`--host`、`--port`、`--workspace-root` 和可重复的 `--trusted-host` 值会成为 Web 宿主 patch；负责这些值的插件 schema 会在启动时验证它们。`--dev` 挂载客户端插件 HMR（热模块替换）接收器；若要无刷新更新客户端 bundle，还需单独运行 `pnpm run dev:web` watcher。

```sh
dsh web
dsh web --config ./web-profile.cordis.yml
dsh web --dump-default-config
dsh web --dump-config
```

生产 Web 运行器需要已构建的包和前端产物（`pnpm run build`）。默认服务地址是 `http://127.0.0.1:3080`。绑定所有接口时，还会信任机器自动发现的 LAN IP 字面量；`--trusted-host` 可添加 `/api` 浏览器信任围栏接受的具名 authority。

`dsh -p "task"` 使用同一基础配置和 Web 组合，并加载启动时的个人配置；它在 OS 分配的端口上启动 Web 宿主，运行一个新的持久化会话，打印最终答案并退出。它不接受 `--config` 或原始配置 dump flag。

Web 和无头进程关闭时会给插件树最多 5 秒完成 dispose。第一次 `SIGINT`/`SIGTERM` 启动该优雅排空；第二次信号强制立即退出。如果无头模式正常结束时已经卡在 dispose 中，第一次 `Ctrl+C` 就会升格并立即退出，而不会被吞掉。

两种模式都将调用目录作为默认 workspace 根目录，以 65,536 字节渲染预算加载适用的 `AGENTS.md` 或 `CLAUDE.md` 指令，并使用内存 SQLite 会话内容索引。Web 监视有效的个人配置编辑；无头模式只在启动时读取该文件。[app-boot 个人配置契约](../../../packages/ui/app-boot/README.md#personal-config)负责配置层优先级、凭据存储、实时更新失败行为和 `$DSH_HOME` 解析。

新会话默认使用 `workspace-write` 权限预设。Bash 和文件系统修改仅限于会话 workspace 与平台临时根目录；读取、网络访问和进程可见性不受限制。`DSH_PERMISSION_MODE` 更改进程后备值。General settings 中存储的权限影响后续 Web 会话，不改变已打开的会话。

`DSH_TOOLS_MODE` 为 Web／无头进程选择 `native`、`code` 或 `both`；其他值会导致启动失败。[`config/core-web.cordis.yml`](../config/core-web.cordis.yml) 是可选 Web overlay：它在保留随附宿主、浏览器、workspace、持久化和权限组合的同时，把原生模型 surface 缩减为持久 `bash` 和 `str_replace_editor`。

## 共享部署行为

基础配置挂载原生 DeepSeek 适配器、settings 与凭据提供方、稳定的 `web_search`、repository Plugin 支持和会话遥测。提供方凭据存放在 `$DSH_HOME/.env` 或环境中；启动器从不把凭据文件提升到 `process.env`，因此凭据可以轮换。搜索使用 `DEEPSEEK_API_KEY` 并接受 `DEEPSEEK_SEARCH_BASE_URL`；只有 overlay 插入提供方并启用 `web_fetch` 后，该工具才可用。

会话事件默认作为 OTLP/HTTP 日志流式发送。`DSH_TELEMETRY_OTLP_URL` 选择其他 collector。任何非空 `DSH_TELEMETRY_DISABLED` 都会在启动前禁用遥测配置行。随附基础配置没有遥测脱敏规则，因此导出的记录可能包含消息文本、工具参数与结果以及 workspace 路径；该部署决策由[遥测 Agent Note](../../../.agents/notes/implemented/feature/2026-07-31-web-telemetry-default-mount.md)负责。

空 `repository-plugins` 行让 Web／无头个人配置和原始 overlay 能够挂载已准备的不可变 repository Plugin generation。参见 [repository Plugin 契约](../../../packages/cordis/repository-plugin/README.md#standalone-app-configuration)。CLI 还随附 `@deepseek-ai/dsh-mcp-client` 作为 overlay 的依赖，但默认不启用 MCP 服务器，因为每条服务器命令都是 agent 沙箱之外的受信任可执行代码。

## 源码启动器

把源码运行启动器链接到 PATH：

```sh
ln -sf "$(pwd)/bin/dsh" ~/.local/bin/dsh
```

它通过 real path 解析 checkout，并使用 `node --import tsx/esm` 启动 `apps/cli/src/bin.ts`。`TSX_TSCONFIG_PATH` 固定到 checkout 根目录，因此 workspace 包解析不依赖调用目录。`pnpm run dsh` 使用同一入口并转发参数。运行 `pnpm run build` 后，构建形式为 `apps/cli/lib/bin.js`。
