# `@deepseek-ai/dsh`

[English](README.md) | 中文


Argv 只会通过 [Commander](https://github.com/tj/commander.js) 适配器（[`src/args.ts`](src/args.ts)）解析一次：同一个程序的默认形式（无子命令）是 TUI／无头界面（`--config`、`-p`/`--prompt`、`--resume`、`--dump-config`、`--dump-default-config`），`meta` 子命令是以本 checkout 为 workspace 的同一个 TUI，`upgrade` 子命令是无选项的引导会话入口，`web` 子命令则是浏览器 UI。`src/bin.ts` 按解析后的 mode 分支，仅动态导入该 mode 的模块。`dsh --help` 列出所有 mode，`dsh web --help` 渲染 Web 用法，`dsh --version` 打印此应用的版本；未知选项或拼错的 `--resume` 会明确报错（stderr，退出码 1），而不会被错路由。凡与默认界面不共享任何选项的子命令（`upgrade`、`web`、`meta`）都会拒绝泄漏进来的 `--config`/`-p`/`--resume`/dump 标志，而不会照常运行并丢弃它。`dsh web` 的 `--host`/`--port` 是未验证的直通覆盖：`dsh-host-webserver` schema 是默认值（标志缺失时使用已交付的 Web 覆盖层值）和有效性的唯一真源，并在启动时拒绝错误值。`--trusted-host` 为 /api 浏览器信任栅栏追加具名权威；全接口绑定还会自行推导本机的 LAN IP 字面量（[`src/app-cli-entry.ts`](src/app-cli-entry.ts)），因此打印出的 LAN URL 无需任何标志即可使用。

TUI 界面：

- 通过 [`dsh-app-boot`](../../packages/ui/app-boot/README.md) 启动 `base.cordis.yml` 与 `tui.cordis.yml`；`--config <path>` 应用一个补丁列表覆盖并替代个人覆盖，而 `--config-replace <path>` 将指定文件作为完整配置树启动；
- 使用 `dsh --resume <session-id>` 恢复已持久化会话。当 Node 宿主公开 `process.execve` 时，还会提供 TUI 的原地移交宿主：选择器预检并刷新当前会话后，宿主会释放应用，并以规范化的恢复调用替换进程；不支持进程替换的运行时会让会话继续运行并给出提示。会话身份与退出行由本 CLI 拥有，而非由配置指定：它创建或选定 `main` 会话 id，并把该 id 以及可复现本次调用的确切命令一起提供到启动上下文（[`MAIN_SESSION_ID_KEY`](../../packages/ui/tui/README.md) 与 `TUI_GOODBYE_MESSAGE_KEY`）。任何 `cordis.yml` 键都无法移除恢复能力；缺失或无法读取的 id 会明确报错，而不会创建新会话；
- 将 **调用目录** 视为 workspace：会话、相对路径和 workspace 指令都从 cwd 解析（`dsh meta` 是唯一例外，见下文）；
- 告知 agent 自身源码所在位置：启动后添加一个命名此 harness checkout 的提示词段。该路径从启动器的真实路径解析，因此在 PATH 符号链接和任意 cwd 下仍然有效，使自指的 `cordis` 工具集可以读取并修改它；
- 应用 `~/.dsh` 中的个人覆盖（参见 [app-boot 的个人配置](../../packages/ui/app-boot/README.md#personal-config)）：`config.yaml` 修补已启动的树，而那里的 `.env` 是凭据 provider 自己的存储（绝不会被提升进环境，因此密钥始终可轮换）。环境优先级为环境中已有的值 > 项目 `.env`。
- 当 `DSH_HOME` 下不存在不可变确认标记时，通过已挂载的 TUI overlay 服务呈现[版本化首次运行欢迎页](../../.agents/notes/implemented/feature/2026-07-30-versioned-tui-first-run-welcome.md)；只有 Enter 会创建该版本的标记，Escape、资源释放或进程退出仍保留展示资格。官方 DeepSeek 图标、响应式终端栅格图、所有 locale 共用的中文文案和通知版本均由静态本地文件持有；overlay 不会写入会话事件或模型上下文。
- 注册裸 `/compact`：agent 空闲时，即使未达到自动压力，也会摘要有效的较早历史；该命令拒绝参数，并只在独立替换标记对持久化后报告成功。压缩（compaction）期间提交的提示词保留其队列身份，并在该检查点之后启动；注入的上下文仍保持可见。

`dsh meta` 是以本 harness checkout 为 workspace 的同一个 TUI，因此开发 dsh 自身无需 `cd`。它在环境确定之后才 chdir 到 checkout 根目录（从启动器的真实路径解析，与源码路径提示词段所指的根目录相同），因此环境优先级不变，而会话 cwd 与 HMR 监视根目录会一并移动。Meta 始终创建新会话，不接受默认界面的任何选项；恢复已持久化会话应使用普通的 `dsh --resume <id>`。

`dsh upgrade` 是默认 TUI 界面之上的引导式全新会话入口：它在调用目录中创建一个全新会话，并以内置 `dsh-upgrade` skill 播种其首轮，效果等同于用户手动键入 `/skill:<name>`。启动器将 skill 名称提供到启动上下文（[`INITIAL_SKILL_KEY`](../../packages/ui/tui/README.md)），TUI 在聊天就绪后自动调用它。两者都不接受任何选项——`--config`、`-p`、`--resume` 都会明确报错——且仅在首次启动时播种，因此之后 `dsh --resume <id>` 恢复该会话时是普通 TUI 会话，不会重复注入。

`dsh --dump-config` 和 `dsh web --dump-config` 把合成后的配置树——已交付的基础配置、界面覆盖层，以及 `--config` 或个人覆盖层，恰好是该界面启动时组装的那些层——以 YAML 打印到 stdout 后退出，不启动任何东西；`--dump-default-config` 止步于界面覆盖层，因此对两份输出做 diff 就能精确看出用户层改了什么。每段连续的行之前都有一条 `# ==` 注释，标明该段来自哪个文件以及被哪些层修补过（例如 `# == base.cordis.yml, patched by tui.cordis.yml`），因此输出既展示来源，又仍是一份可加载的文档。合成通过 include 自己的补丁算法和 YAML 方言（`@cordisjs/plugin-include` 的 `applyEntryPatches`/`entryListSchema`）完成，因此 dump 不可能与实际启动漂移；`!!js` 表达式原样打印、不求值，目标行不存在的补丁会连同其所在层报到 stderr，与 Loader 启动时的警告一致。由启动器持有的启动上下文值（会话身份、CLI 标志补丁）是每次调用的事实，位于配置树之外，不会出现。dump 标志会拒绝仅用于启动的标志（`-p`、`--resume`、`--config-replace`）而不是静默忽略它们，`--dump-default-config` 不接受 `--config`。

Web 和无头界面启动 `base.cordis.yml` 与 `web.cordis.yml`，随后应用 `$DSH_HOME/config.yaml`；显式的 `--config <path>` 会替代该个人覆盖。除此之外，两者共享同一套组合：两者都将调用目录视为默认项目和 Workspace 根目录，除非通过 `--workspace-root <path>` 覆盖，否则会在该根目录下创建具名 Workspace；它们会把适用的 `AGENTS.md`/`CLAUDE.md` 指令加载到每个 agent-loop 请求前缀中，渲染预算为 65,536 字节，选用首条消息模型标题，采用与 TUI 相同的有界暂时性模型请求重试策略，并挂载一个可丢弃的内存 SQLite 内容索引服务。该服务在启动时处于 ACTIVE 状态，但其 `node:sqlite` 模块与数据库句柄分别要到首次内容搜索才会导入和打开。这样可使 Node 22 在尚未使用搜索时的启动输出不出现 SQLite 实验性警告；首次实际搜索仍可能发出运行时警告。每个服务实例独占自己的数据库，因此并行调用既不会共享不受支持的 SQLite 状态，也不会留下派生索引文件，首次搜索还会惰性对账实时日志与持久化日志。无头界面唯一的差异是监听操作系统分配的端口（并行 `dsh -p` 运行绝不冲突；stderr 打印的 URL 会在浏览器中打开实时会话）。两者都需要先构建前端 dist 和客户端 bundle（`pnpm run build && pnpm run build:web`）。

已交付的 TUI 和 Web 组合会注册原生 DeepSeek 适配器，以及 pi-ai 的 OpenAI 和 Anthropic 提供方配置。凭据和端点覆盖来自启动分层环境中的提供方标准变量对：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`、`OPENAI_API_KEY` / `OPENAI_BASE_URL` 和 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`。

每个界面也都只注册 `web_search` 这一个 Web 工具。搜索使用 DeepSeek 的 Anthropic 兼容 Messages 端点，每次调用都会解析同一个 `DEEPSEEK_API_KEY` 凭据引用，并接受独立的 `DEEPSEEK_SEARCH_BASE_URL` 端点覆盖；每次搜索都是一次辅助模型请求，会产生独立的延迟与 token 成本。`web_fetch` 仍处于禁用状态，组合也未挂载默认抓取提供方；需要任意页面抓取能力的部署必须通过覆盖层选择启用。部署决策及其安全边界见[默认 Web 搜索 Agent Note](../../.agents/notes/implemented/feature/2026-07-31-web-default-search.md)。

`DSH_TOOLS_MODE` 为整个 Web／无头进程选择工具呈现模式：`native`（未设置时的 schema 默认值）、`code`（仅含 `run_code` 的 Code Mode 线路）或 `both`；任何其他值都会经由 `dsh-tools` 配置 schema 在启动时明确报错。它是一个临时 seam——Loader 组合是静态的，因此该设置作用于整个进程——待 Web UI 负责逐会话工具模式选择后便会移除；TUI 界面会忽略该变量并固定为 `native`。

[`core-web.cordis.yml`](config/core-web.cordis.yml) 是一个可选启用的 `dsh web --config` 覆盖层：它保留已交付的 Web 宿主、浏览器、Workspace、持久化与权限组合，同时将默认的原生模型界面精简为以所有者为作用域的持久 `bash` 以及 `str_replace_editor`。PTY 后端和编辑器分别消费现有的 Web 沙箱与文件系统提供方。持久 shell 处于打开状态时，会阻止所属会话更改权限模式；因此，在较宽权限下创建的 shell 无法在降权后继续存活。`DSH_TOOLS_MODE` 仍控制由此得到的双工具注册表采用原生／Code Mode 呈现。

在源码 checkout 中，用以下命令启动这个精简 Web profile：

```sh
pnpm run dsh web --config apps/cli/config/core-web.cordis.yml
```

每个 `dsh` 界面——TUI、Web 与无头——都默认上报会话遥测（该行位于共享的 `base.cordis.yml`）：每条会话日志事件以 OTLP/HTTP 日志记录的形式、按 10 秒批处理节奏流向 `https://harness-telemetry.deepseeksvc.com/v1/logs`。`DSH_TELEMETRY_OTLP_URL` 可将 exporter 指向其他 collector；将 `DSH_TELEMETRY_DISABLED` 设为**任意非空值**——包括 `0` 或 `false`——都会在该行加载前将其关停（隐私开关取「宁可误关、不可误开」）。该组合当前未挂载任何脱敏规则：导出记录即原始捕获副本，包含消息正文、工具参数与结果、以及会话工作目录路径。部署口径见 [web-telemetry-default-mount Agent Note](../../.agents/notes/implemented/feature/2026-07-31-web-telemetry-default-mount.md)。

MCP 服务器不是交付默认值,因为默认值必须点名一台:`@deepseek-ai/dsh-mcp-client` 每一行只挂载一台服务器,并把它作为子进程 spawn,该进程不经 `ctx.bash`,因此也不受沙箱策略约束。该包是本 CLI 的运行时依赖,所以已安装的 `dsh` 无需源码检出即可从 `$DSH_HOME/config.yaml` 或 `--config` 覆盖层挂载你自己的服务器:

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
```

模型随后会看到 `mcp__github__*`。Streamable HTTP 传输与完整字段表见 [mcp-client README](../../packages/mcp/mcp-client/README.md)。

## 安装（开发机）

将从源码运行的启动器符号链接到 PATH 上；它通过自身真实路径解析 checkout，因此代码更改会在下次启动时生效，无需构建：

```sh
ln -sf "$(pwd)/bin/dsh" ~/.local/bin/dsh
```

源码启动会通过 tsx 的 ESM-only hook（`node --import tsx/esm`）运行 `apps/cli/src/bin.ts`，由它转换 TypeScript 并将根 tsconfig 的 `paths` 映射投射到模块解析中。不使用 Node 原生 TypeScript 模式：Node 26 移除了 `--experimental-transform-types`，而 strip-only 模式无法接受源码图依赖的语法（vendor 中的参数属性、装饰器、运行时 enum/namespace）。CJS hook 保持关闭，因为源码图是纯 ESM，而 CJS 解析器会增加约 0.4s 启动耗时。`bin/dsh` 将 `TSX_TSCONFIG_PATH` 固定到 checkout 的根 tsconfig，使解析与 cwd 无关；node-compat 门禁 `dsh-source-launch-smoke` 会在每条受支持的 Node 版本线上运行这一精确启动向量。tsx 应用 `paths` 映射时不检查依赖声明，声明完整性由静态门禁保障：TUI 配置通过 `examples/package.json` 解析裸插件，Web／无头 `cordis.yml` 通过本包的 `dependencies` 解析；`verify-cordis-config` 要求每个已配置的裸插件均已声明，同时允许存在无关依赖。

`pnpm run dsh` 从仓库根目录运行同一入口并直接转发参数，例如 `pnpm run dsh -p "task"`。构建形式（`lib/bin.js`，通过 `pnpm run build`）会在普通 Node 下启动同一配置。
