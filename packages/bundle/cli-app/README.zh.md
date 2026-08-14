# `@deepseek-ai/dsh-cli-app`

[English](README.md) | 中文

本地交互式 CLI 组合包。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.md) 之上，挂载本包的命令行启动提供方和直接 Agent runner，并在受支持的非 Windows 主机上增加现有持久终端能力。它不挂载 Host、HTTP server、Web runtime、浏览器插件或 ACP server。

使用 `deepseek`、`dsh cli` 或 `dsh --profile cli` 启动。TTY 会得到名为 `DeepCode`、不会占用 alternate screen 的紧凑 Ink 终端界面，其中包含可保留的终端回滚、流式回答、每次成功工具调用一行、实时身份与状态行、可选择的审批与问题、命令补全、输入历史和遮罩凭据提示。已提交输出使用 Ink 的不可变 `Static` 区域；流式生成只更新底部实时回答与 composer，使宿主终端滚动条保持稳定。Ctrl+O 只在实时区域打开最近一次工具详情，不会重写或无限复制回滚内容。`/clear` 会替换 Ink owner、清除可见屏幕与终端回滚，再按当前身份重绘。重定向的 stdin/stdout 使用不含 ANSI 转义的确定性纯文本。一个 surface 统一持有聊天、凭据、审批和模型问题所用的 stdin。Agent 运行时提交的完整聊天消息进入内存 FIFO，并在当前轮次空闲后分派；审批和模型问题到达时仍使用共享 composer。运行中的 Ctrl+C 取消工作，空闲 Ctrl+C 或 EOF 执行有界退出。

内置命令为 `/login`、`/logout`、`/status`、`/model`、`/models`、`/new`、`/sessions`、`/resume`、`/clear`、`/help` 和 `/exit`。`/login` 解析当前模型提供方配置的凭据引用，并通过 `ctx.credentials` 写入；密钥不会进入 argv、终端输出、settings 或 Session 日志。`/models` 和 `/model` 通过 `ctx.llm` 使用 provider discovery，因此 DeepSeek 官方路由默认展示 V4 Flash 与 V4 Pro，而 Web/settings 替换后的目录无需 CLI 专属模型列表即可生效。模型选择还会解析 provider 的思考模式与推理等级元数据。`/resume` 只接受调用工作区内、没有 roster 的根会话，并拒绝携带 Agent preset 的会话。其余命令（包括 `/compact` 和 `/goal`）交给插件 command registry 分派。

快捷键采用常见 coding-agent 终端约定：Enter 发送或排队一条完整消息，Backspace 在 CMD 与 POSIX 终端中删除光标前一个字符，Ctrl+J 或 Shift+Enter 换行，Up/Down 浏览历史或选择项，Tab 补全唯一 slash command，Ctrl+A/E 移至行首/行尾，Ctrl+U/K/W 编辑缓冲区，Ctrl+L 清屏，Ctrl+O 切换工具详情，Ctrl+N 新建会话，Escape 或 Ctrl+C 取消运行中的工作，空闲 Ctrl+C 或空缓冲区 Ctrl+D 退出。退出前会刷新当前 Session、释放 Agent handle，再通过 `ctx.appExit` 请求结束。

base 组合包继续持有文件系统策略、文件系统工具、审批策略、权限预设和平台一次性 shell 工具。本组合包挂载 `@deepseek-ai/dsh-tool-ask-user`，为 `ctx.approval` 提供人工 answerer，并为 `ctx.userQuestions` 提供终端 answerer，使模型问题与审批、聊天共用同一个输入持有方。`DSH_TOOLS_MODE` 选择 `code` 或 `both` 时，它还会挂载对应的 worker-thread code runtime。在 POSIX 上，它把 `@deepseek-ai/dsh-terminal`、`@deepseek-ai/dsh-terminal-bash` 和 `@deepseek-ai/dsh-tool-terminal` 作为一个完整能力 seam 挂载。这三行在 Windows 上成组禁用；CLI 仍可通过 base 的 PowerShell 工具使用，但不声称支持 ConPTY。

## 模型体验

无，因为终端 runner 只提交普通用户消息；提示词、工具及命令持有的模型上下文属于组合后的插件。

#### KV Cache 影响

无；runner 不增加任何请求前缀内容。

## 已知限制与暂缓事项

- **内容仍按纯文本渲染** — 终端外壳已有结构化界面，但 assistant Markdown 和工具专用 diff 卡片目前仍按文本显示；为保留 scrollback，界面有意不占用 alternate screen。
- **只恢复无 roster 会话** — 本 profile 可以恢复当前工作区的根会话，并拒绝携带 Agent preset 的会话。Session header 不记录由哪个无 roster surface 创建，因此同一工作区内其他无 roster profile 的会话仍可能进入候选。
- **Windows 无持久 PTY** — Windows 使用 base 的 PowerShell 工具，直到 Windows 原生终端 provider 持有 ConPTY 进程与信号语义。
- **不集成外部编排器** — 第一期仅持有本地终端进程；远程派发和生命周期上报不属于本组合包。
