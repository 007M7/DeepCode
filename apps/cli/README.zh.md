# `@deepseek-ai/dsh`

[English](README.md) | 中文


Argv 只会通过 [Commander](https://github.com/tj/commander.js) 适配器（[`src/args.ts`](src/args.ts)）解析一次：同一个程序的默认形式（无子命令）是 TUI／无头界面（`--config`、`-p`/`--prompt`、`--resume`），`meta` 子命令是以本 checkout 为 workspace 的同一个 TUI，`upgrade` 子命令是无选项的引导会话入口，`web` 子命令则是浏览器 UI。`src/bin.ts` 按解析后的 mode 分支，仅动态导入该 mode 的模块。`dsh --help` 列出所有 mode，`dsh web --help` 渲染 Web 用法，`dsh --version` 打印此应用的版本；未知选项或拼错的 `--resume` 会明确报错（stderr，退出码 1），而不会被错路由。凡与默认界面不共享任何选项的子命令（`upgrade`、`web`、`meta`）都会拒绝泄漏进来的 `--config`/`-p`/`--resume`，而不会照常运行并丢弃它。`dsh web` 的 `--host`/`--port` 是未验证的直通覆盖：`dsh-host-webserver` schema 是默认值（标志缺失时使用已交付的 Web 覆盖层值）和有效性的唯一真源，并在启动时拒绝错误值。`--trusted-host` 为 /api 浏览器信任栅栏追加具名权威；全接口绑定还会自行推导本机的 LAN IP 字面量（[`src/app-cli-entry.ts`](src/app-cli-entry.ts)），因此打印出的 LAN URL 无需任何标志即可使用。

TUI 界面：

- 通过 [`dsh-app-boot`](../../packages/ui/app-boot/README.md) 启动 `base.cordis.yml` 与 `tui.cordis.yml`；`--config <path>` 应用一个补丁列表覆盖并替代个人覆盖，而 `--config-replace <path>` 将指定文件作为完整配置树启动；
- 使用 `dsh --resume <session-id>` 恢复已持久化会话。当 Node 宿主公开 `process.execve` 时，还会提供 TUI 的原地移交宿主：选择器预检并刷新当前会话后，宿主会释放应用，并以规范化的恢复调用替换进程；不支持进程替换的运行时会让会话继续运行并给出提示。会话身份与退出行由本 CLI 拥有，而非由配置指定：它创建或选定 `main` 会话 id，并把该 id 以及可复现本次调用的确切命令一起提供到启动上下文（[`MAIN_SESSION_ID_KEY`](../../packages/ui/tui/README.md) 与 `TUI_GOODBYE_MESSAGE_KEY`）。任何 `cordis.yml` 键都无法移除恢复能力；缺失或无法读取的 id 会明确报错，而不会创建新会话；
- 将 **调用目录** 视为 workspace：会话、相对路径和 workspace 指令都从 cwd 解析（`dsh meta` 是唯一例外，见下文）；
- 告知 agent 自身源码所在位置：启动后添加一个命名此 harness checkout 的提示词段。该路径从启动器的真实路径解析，因此在 PATH 符号链接和任意 cwd 下仍然有效，使自指的 `cordis` 工具集可以读取并修改它；
- 应用 `~/.dsh` 中的个人覆盖（参见 [app-boot 的个人配置](../../packages/ui/app-boot/README.md#personal-config)）：`config.yaml` 修补已启动的树，而那里的 `.env` 是凭据 provider 自己的存储（绝不会被提升进环境，因此密钥始终可轮换）。环境优先级为环境中已有的值 > 项目 `.env`。

`dsh meta` 是以本 harness checkout 为 workspace 的同一个 TUI，因此开发 dsh 自身无需 `cd`。它在环境确定之后才 chdir 到 checkout 根目录（从启动器的真实路径解析，与源码路径提示词段所指的根目录相同），因此环境优先级不变，而会话 cwd 与 HMR 监视根目录会一并移动。Meta 始终创建新会话，不接受默认界面的任何选项；恢复已持久化会话应使用普通的 `dsh --resume <id>`。

`dsh upgrade` 是默认 TUI 界面之上的引导式全新会话入口：它在调用目录中创建一个全新会话，并以内置 `dsh-upgrade` skill 播种其首轮，效果等同于用户手动键入 `/skill:<name>`。启动器将 skill 名称提供到启动上下文（[`INITIAL_SKILL_KEY`](../../packages/ui/tui/README.md)），TUI 在聊天就绪后自动调用它。两者都不接受任何选项——`--config`、`-p`、`--resume` 都会明确报错——且仅在首次启动时播种，因此之后 `dsh --resume <id>` 恢复该会话时是普通 TUI 会话，不会重复注入。


Web 和无头界面启动 `base.cordis.yml` 与 `web.cordis.yml`，随后应用 `$DSH_HOME/config.yaml`；显式的 `--config <path>` 会替代该个人覆盖。除此之外，两者共享同一套组合：两者都将调用目录视为默认项目和 Workspace 根目录，除非通过 `--workspace-root <path>` 覆盖，否则会在该根目录下创建具名 Workspace；它们会把适用的 `AGENTS.md`/`CLAUDE.md` 指令加载到每个 agent-loop 请求前缀中，渲染预算为 65,536 字节，并选用首条消息模型标题。无头界面唯一的差异是监听操作系统分配的端口（并行 `dsh -p` 运行绝不冲突；stderr 打印的 URL 会在浏览器中打开实时会话）。两者都需要先构建前端 dist 和客户端 bundle（`pnpm run build && pnpm run build:web`）。

已交付的 TUI 和 Web 组合会注册原生 DeepSeek 适配器，以及 pi-ai 的 OpenAI 和 Anthropic 提供方配置。凭据和端点覆盖来自启动分层环境中的提供方标准变量对：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`、`OPENAI_API_KEY` / `OPENAI_BASE_URL` 和 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`。

`DSH_TOOLS_MODE` 为整个 Web／无头进程选择工具呈现模式：可选值为 `native`（未设置时的 schema 默认值）、`code`（仅含 `run_code` 的 Code Mode 协议接口）或 `both`；任何其他值都会经由 `dsh-tools` 配置 schema 在启动时明确报错。它是一个临时 seam：Loader 组合是静态的，因此该设置作用于整个进程；待 Web UI 负责逐会话工具模式选择后便会移除。TUI 界面会忽略该变量（其配置树固定了自身模式）。

## 安装（开发机）

将从源码运行的启动器符号链接到 PATH 上；它通过自身真实路径解析 checkout，因此代码更改会在下次启动时生效，无需构建：

```sh
ln -sf "$(pwd)/bin/dsh" ~/.local/bin/dsh
```

源码启动会通过 tsx 的 ESM-only hook（`node --import tsx/esm`）运行 `apps/cli/src/bin.ts`，由它转换 TypeScript 并将根 tsconfig 的 `paths` 映射投射到模块解析中。不使用 Node 原生 TypeScript 模式：Node 26 移除了 `--experimental-transform-types`，而 strip-only 模式无法接受源码图依赖的语法（vendor 中的参数属性、装饰器、运行时 enum/namespace）。CJS hook 保持关闭，因为源码图是纯 ESM，而 CJS 解析器会增加约 0.4s 启动耗时。`bin/dsh` 将 `TSX_TSCONFIG_PATH` 固定到 checkout 的根 tsconfig，使解析与 cwd 无关；node-compat 门禁 `dsh-source-launch-smoke` 会在每条受支持的 Node 版本线上运行这一精确启动向量。tsx 应用 `paths` 映射时不检查依赖声明，声明完整性由静态门禁保障：TUI 配置通过 `examples/package.json` 解析裸插件，Web／无头 `cordis.yml` 通过本包的 `dependencies` 解析；`verify-cordis-config` 要求每个已配置的裸插件均已声明，同时允许存在无关依赖。

`pnpm run dsh` 从仓库根目录运行同一入口并直接转发参数，例如 `pnpm run dsh -p "task"`。构建形式（`lib/bin.js`，通过 `pnpm run build`）会在普通 Node 下启动同一配置。
