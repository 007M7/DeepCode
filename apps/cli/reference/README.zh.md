# `dsh` CLI（命令行界面）行为参考

[English](README.md) | 中文

本参考定义 `deepseek` 终端入口，以及 profile 启动、本地 CLI 别名、web 别名、插件管理和配置 dump 等命令模式。`deepseek` 选择随包的 `cli` profile；`dsh` argv 由 [`src/args.ts`](../src/args.ts) 统一解析一次，两个 bin 通过 [`src/launcher.ts`](../src/launcher.ts) 共用分派实现。

## Profile 启动

`dsh --profile <name>` 启动位于 `$DSH_HOME/profiles/<name>` 的 profile。生效配置树以空根节点为起点，依次叠加 profile manifest（元数据清单）的 `dsh.profile.bundles` 列表中指定的各组合包 patch、profile 自身的 `cordis.patch.yml`、home 级的 `$DSH_HOME/cordis.patch.yml`（这是各 profile 共享的机器本地偏好，因此优先于逐 profile 配置层），以及按 argv 顺序指定的各个 `--patch <path>` 覆盖层。对同一配置行，后应用的层优先。patch 会替换目标行的整个 `config` 值，而不是深度合并其中的键；patch 也可以插入新行。配置解析、schema 校验、模块解析或插件启动失败时，系统会报告错误并以非零状态退出。收到 SIGINT 或 SIGTERM 时，挂载的根节点会先 dispose（资源释放）再退出。

组合包名称先从 dsh 安装目录解析，再从 profile 目录解析。因此，内置组合包（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-cli-app`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`）始终来自当前运行的 `dsh` 所属的安装；树外组合包则来自 profile 中由 pnpm 管理的 `node_modules`。patch 行中的裸插件 `name` 会从 profile 目录开始，按照 Node 的模块解析规则逐级向父目录查找，直至由 dsh 维护的安装后备目录 `$DSH_HOME/profiles/node_modules`。该目录为 dsh 安装中的应用和组合包所依赖的每个包各维护一个符号链接，并在每次启动时修复这些链接。

`cli`、`web` 和 `headless` profile 首次使用时会从随附模板自动初始化（`cli`：base + cli-app；`web`：base + web-app；`headless`：base + headless）。其他缺失的 profile 会显式报错，并提示运行 `dsh plugin --profile <name> add <package>`。

### 应用参数

启动器自身的 flag 必须写在最前面，并在遇到第一个无法识别的 token 时结束；从该 token 开始的所有内容都会通过 `ctx.cmdlineArgs` 原样交给已启动的 profile，注入该 profile 的任意应用插件都可以解析这些内容（[`dsh-cmdline`](../../../packages/boot/cmdline/README.md)）。因此，`dsh --profile web --port 8080` 会将 `--port` 交给 web 应用；`dsh --profile web --help` 只打印该应用的帮助信息，不启动应用；`dsh --help` 没有可供交付参数的 profile，因此会打印启动器自身的帮助信息。`-V`/`--version` 位于应用参数边界之前时，会打印启动器的版本。

每套组合只会挂载一次。普通插件注入 `cmdlineArgs`，解析所属应用的参数，并将解析结果作为服务提供。每个从 flag 取值的配置行都会注入该服务；Loader 会等到服务激活后，再对该行的配置求值（`port: !!js ctx.webStartup.port ?? 3080`），因此 flag 的优先级高于配置行中写明的值。要维持这一优先级，配置行必须保留该表达式；如果用户 patch 用字面量替换整个 `config`，也会随之移除运行时读取。帮助参数和被拒绝的参数都会请求退出：参数被拒绝时以非零状态退出，显示帮助时以 0 退出；依赖该提供方服务的配置行不会激活。在线编辑 `cordis.patch.yml` 时，系统会根据仍在运行的服务重新计算表达式，因此不会重置当前正在使用的端口。

启动器的 flag 必须写在应用参数之前，且启动器的解析器会消耗掉一个 `--`：必须以字面量 `--` 送达应用的参数需要写成 `-- --`。如果应用的第一个参数恰好等于 `cli`、`web` 或 `plugin`，会选择对应的子命令。`ctx.cmdlineArgs.get()` 是共享的不可变读取：多个插件可以解析同一份快照，没有读取方的 profile 则会忽略自己的应用参数。

随附的应用接受以下命令行参数：

| Profile | 参数 |
|---|---|
| `cli` | 不接受位置参数；`--help` 打印本地 CLI 帮助 |
| `web` | `--host`、`--port`、可重复的 `--trusted-host` |
| `headless` | 任务文本，作为位置参数 |

本地交互 profile（`deepseek`、`dsh cli` 或 `dsh --profile cli`）为调用目录创建一个持久化 Agent，并跨 turn 复用。TTY 使用一个非全屏 Ink tree 展示欢迎卡、转录、流式回答、工具状态、状态栏、composer、审批、问题和遮罩 secret。非 TTY 流使用不含 ANSI 转义的排队纯文本 reader。已提交的 `assistant/chunk` 文本增量会立即输出；只有未产生文本增量的 step 才由 `assistant/message` 补充。runner 等待每个 turn 进入 idle，并在接受下一次输入前刷新 Session。

内置命令为 `/login`、`/logout`、`/status`、`/model`、`/models`、`/new`、`/sessions`、`/resume`、`/clear`、`/help` 和 `/exit`。认证通过当前 provider 在 settings 中声明的 credential reference 和 `ctx.credentials` 完成，不经过 argv 或 Session event。模型选择通过 `ctx.llm` 解析 provider、精确 model id 和可选 reasoning effort，再更新当前 Agent，并在可能时保存默认值。会话列举和恢复仅限调用工作区中的 root session；带 Agent preset 的会话会被拒绝，因为本 profile 无法复现其组合。其他 slash command 通过 `ctx.commands` 分派；随包树中包括 `/compact` 和 `/goal`。

Enter 发送；Ctrl+J 或 Shift+Enter 换行；Up/Down 浏览历史或 picker；Tab 补全唯一匹配的 slash command；Ctrl+A/E/U/K/W 提供行编辑；Ctrl+L 清屏；Ctrl+O 切换工具详情；Ctrl+N 新建会话；Escape/Ctrl+C 取消运行中的工作。空闲 Ctrl+C 和空缓冲区 Ctrl+D 退出。Ink tree 不进入 alternate screen，因此完成的输出会保留在终端 scrollback 中。

Agent 或可取消插件命令运行时按下 Ctrl+C 只取消当前操作，待其完成清理后返回 composer。空闲时按下 Ctrl+C 或 stdin 到达 EOF 会关闭 surface；关闭流程会注销 answerer、问题提供方和事件监听器，等待 Agent 空闲，刷新 Session，dispose 自己持有的 Agent 句柄，最后向启动器请求成功退出。base 组合包提供文件系统策略与工具、审批策略、权限预设和平台 shell。在 POSIX 上，CLI 组合包会成组挂载持久终端 Service Definition、bash 提供方和终端工具 Consumer；Windows 则成组禁用这三个插件，继续使用 base 的一次性 PowerShell 工具，本版本不声称支持 ConPTY。

一次性任务（`dsh --profile headless "run the tests"`）通过核心注册表创建一个全新的持久化 Agent（智能体），提交任务、等待完全停稳并对会话执行 flush，再从其持久化事件区间中推导最后一个非空 assistant 文本与最终 `turn/end` 原因。它在 stdout 打印文本，并在原因为 `completed` 时以 0 退出，否则以 1 退出。没有任务的调用是该应用的用法错误。随附 headless profile 不挂载 ApiProxy、Host、HTTP 服务器、Web 运行时或浏览器客户端；成功运行不会向 stderr 写入任何内容，也不会打开监听端口。

可在不启动的情况下检查组合出的配置树：

```sh
dsh --profile web --dump-default-config
dsh --profile web --patch ./extra.yml --dump-config
```

`--dump-default-config` 只打印组合包各层；`--dump-config` 额外加上 profile 的 `cordis.patch.yml`、home 级的 `$DSH_HOME/cordis.patch.yml` 和 `--patch` overlay。两者都会打印注释，标明每行由哪个文件提供，以及哪些 overlay 修改过它；`!!js` 表达式保持未求值，找不到目标的 patch 会报告到 stderr。dump 操作不会运行应用的命令行参数提供方，因此展示的是解析任何应用参数之前的组合配置树；如果调用中包含应用参数，dump 会拒绝该调用。

## 插件管理

`dsh plugin --profile <name> <args...>` 在 profile 缺失时先初始化它（有随附模板的用模板，其他名称只装 `@deepseek-ai/dsh-base`），然后以 profile 目录为工作目录，把 `<args...>` 转发给 `pnpm`：`add`、`remove`、`why`、`update` 及其他所有 pnpm 子命令都照常可用；pnpm 必须在 PATH 上。相对路径 spec（`.`、`../plugin` 及其 `file:`/`link:` 形式）会先锚定到调用目录，因此在插件 checkout 中执行 `add .` 安装的是该 checkout，而不是 profile。每次成功运行后，系统都会根据当前安装状态更新 `dsh.profile.bundles`：如果某项依赖解析到的包在 manifest 中声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，该依赖就会加入配置层栈；如果某项依赖在 `update` 后获得该声明，也会随即激活。没有组合包声明的依赖仍作为普通依赖保留，并显示一次性警告；已移除的依赖则从配置层栈中删除。

```sh
dsh plugin --profile tui add github:deepseek-harness/turtle-ui
dsh plugin --profile tui remove turtle-ui
dsh --profile tui
```

随源码发布的 Git 托管插件会在安装期间通过 `prepare` 脚本构建，而 pnpm ≥10 默认会阻止该脚本，直到使用方明确允许。首次运行 `add` 会失败，并显示 pnpm 的 `allowBuilds` 提示；dsh 还会提示应修改该 profile 的 `pnpm-workspace.yaml`。将输出的键复制到该文件后，重新运行命令即可。安装已经构建好的 tarball 或本地 checkout 时，无需加入 `allowBuilds`。

## Web 别名

`dsh web` 是 `--profile web` 的硬编码别名；写在它之后的 flag 属于 web 应用，由组合包中的普通提供方解析。`--host` 和 `--port` 覆盖承载它们的那些行的组合取值，可重复的 `--trusted-host` 通过 `ctx.webRuntime.trustedHosts` 提供本次调用的 authority（部署表达式会拼接自己的 authority），客户端插件 HMR（热模块替换）接收器始终挂载，在单独运行的 `pnpm run dev:web` watcher 重建客户端 bundle 之前保持空闲。

```sh
dsh web
dsh web --patch ./extra.cordis.yml
dsh web --dump-config
dsh web --help
```

生产 Web 运行器需要已构建的包和前端产物（`pnpm run build`）。默认服务地址是 `http://127.0.0.1:3080`。CLI 目前有意不支持 `--host 0.0.0.0`，并会以用法错误退出；`--trusted-host` 可添加 `/api` 浏览器信任围栏接受的具名 authority。

进程关闭时，插件树最多有 5 秒完成 dispose。首次收到 `SIGINT` 或 `SIGTERM` 时会开始优雅排空：`SIGTERM` 是监督进程发出的常规停止请求，在所有运行模式下都以 0 退出；`SIGINT` 则报告 130。第二次收到信号时会立即强制退出。如果一次性运行在正常结束时已经卡在 dispose 阶段，第一次按下 `Ctrl+C` 就会直接升级为强制退出，而不会被忽略。

所有模式都将运行命令时所在的目录作为默认 workspace 根目录，以 65,536 字节渲染预算加载适用的 `AGENTS.md` 或 `CLAUDE.md` 指令，并使用内存 SQLite 会话内容索引。每次启动 profile 时，系统都会监视 profile 与 home 两个 `cordis.patch.yml` 配置层的有效变更，并以事务方式重新应用；一次性运行模式通过有界关闭流程退出，该流程会先 dispose 监视器。

新会话默认使用 `workspace-write` 权限预设。Bash 和文件系统修改仅限于会话 workspace 与平台临时根目录；读取、网络访问和进程可见性不受限制。`DSH_PERMISSION_MODE` 更改进程后备值。General settings 中存储的权限影响后续 Web 会话，不改变已打开的会话。

`DSH_TOOLS_MODE` 为进程选择 `native`、`code` 或 `both`；其他值会导致启动失败。随附的 `minimal` agent preset 会保留该部署的呈现方式，将完整系统提示词固定为 `You are a helpful software engineer assistant.`，并且仅组合持久 `bash` 和 `str_replace_editor`。创建 Web 会话时请选择极简模式；该 agent 不包含任何其他提示词段落或面向模型的插件，而共享的浏览器、workspace、持久化、沙箱与权限宿主保持不变。

## 共享部署行为

基础组合包挂载原生 DeepSeek 适配器、settings 与凭据提供方、稳定的 `web_search` 和已禁用的会话遥测。提供方凭据依次从继承环境、`$DSH_HOME/.credentials.yaml`、调用目录的 `.env` 和 `$DSH_HOME/.env` 解析；受管文档从不物化进 `process.env`，而两个 `.env` 文件都是普通启动环境层。搜索使用 `DEEPSEEK_API_KEY` 并接受 `DEEPSEEK_SEARCH_BASE_URL`；只有 patch 层插入提供方并启用 `web_fetch` 后，该工具才可用。

会话遥测默认留在本地。`DSH_TELEMETRY_MODE=FULL` 将每条已投影会话事件作为 OTLP/HTTP 日志流式发送，`DSH_TELEMETRY_MODE=FEEDBACK_ONLY` 则仅在记录反馈时上传会话日志后缀。`DSH_TELEMETRY_OTLP_URL` 选择其他 collector。任何非空的 `DSH_TELEMETRY_DISABLED` 都是具有最终效力的遥测强制关闭开关。随附基础配置没有遥测脱敏规则，因此显式启用的导出可能包含消息文本、工具参数和结果，以及 workspace 路径；相关部署决策见[默认关闭 Agent Note](../../../.agents/notes/implemented/feature/2026-08-10-telemetry-default-off.md)。

通过 `dsh plugin --profile <name> add <package-or-git-spec>` 安装外部插件组合包。安装的包拥有其依赖，并贡献其声明的 `cordis.patch.yml` 层。CLI 还随附 `@deepseek-ai/dsh-mcp-client` 作为供 patch 层使用的依赖，但默认不启用 MCP 服务器，因为每条服务器命令都是 agent（智能体）沙箱之外的受信任可执行代码。

## 源码执行

请在仓库根目录中，于全新 checkout 之后及产物需要更新时单独运行 `pnpm run build`，然后使用 `pnpm dsh <args...>`。`package.json` 中的脚本不会构建，而是通过 `node --import tsx/esm` 启动 `apps/cli/src/bin.ts`，并转发所有参数。Typert Host 产物缺失时，profile 启动会因不含构建指引的模块解析错误而失败。这些 Host 产物存在后，如果前端或 Client plugin 组合包缺失，启动会失败并提示运行 `pnpm run build`。启动器不会检查产物是否为最新，因此已有的陈旧组合包可能继续运行旧版浏览器代码，直至重新构建。该进程会继承启动环境；当支持环境代理的 Node 版本必须遵循 `HTTP_PROXY` 和 `HTTPS_PROXY` 时，请设置 `NODE_USE_ENV_PROXY=1`。安装形式同时暴露 `dsh`（`apps/cli/lib/bin.js`）和 `deepseek`（`apps/cli/lib/deepseek.js`），不会重新构建仓库。
