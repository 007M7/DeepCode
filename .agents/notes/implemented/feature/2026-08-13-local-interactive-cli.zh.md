# Agent Note: 基于核心 Agent 运行时的本地交互 CLI

Status: implemented

[English](2026-08-13-local-interactive-cli.md) | 中文

## Problem

产品需要一个本地终端入口，在普通 follow-up 轮次之间保留同一个 Agent 与会话。重复调用一次性 headless 命令会丢失对话状态，而挂载 Web、ACP（Agent Client Protocol）或其他协议栈会让终端进程依赖无关的传输。人类输入同样是共享运行时状态：聊天、凭据、审批请求和模型问题不能在同一个 stdin 上创建彼此竞争的持有者。

Windows 还有一项独立的组合约束。持久终端能力依赖 POSIX 进程组观察，不能声称具备等价的 ConPTY 生命周期语义；但省略不受支持的提供方不能妨碍本地 CLI 使用 base 的 PowerShell 与文件系统工具。

## Decision

`deepseek` 是随附 `cli` profile 的直接可执行入口；`dsh cli` 和 `dsh --profile cli` 仍是等价的启动形式。Windows 下载源码安装器会恢复并构建 workspace、在 npm 命令目录写入直接的 `deepseek.cmd` 启动器，并把该目录持久写入用户 `PATH`，因此新的命令提示符、PowerShell 或 Windows Terminal 会话都能从任意工作目录到达同一入口。启动器直接调用 checkout 的构建入口，不创建 npm 包链接，因此包不会作为 Junction 出现在自身 `node_modules` 树中；两种 shell 都解析同一个 `.cmd`，且无需修改 Restricted 脚本策略。重复运行安装器会原地更新，卸载则只移除带标记的启动器，不删除共享的 npm PATH 项。两种启动形式都会把进程标题设为 `DeepCode`。profile 的组合包列表依次为 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-cli-app`。两个可执行名称共用同一启动分派，CLI 组合包包含一个由应用持有的启动提供方和直接 runner；它不挂载 Host、HTTP server、Web 运行时、浏览器客户端、ACP server 或外部编排器集成。

runner 等待 Loader 完全加载，读取 `ctx.agentDefaultModel.currentSelection()`，并通过 `ctx.agents.create` 为调用目录创建一个持久化 Agent。完成编辑的 composer 值会成为一条普通用户 follow-up。`/new` 用全新 Session 替换持有的 Agent；`/resume` 在校验身份、root 来源、工作区且会话没有 Agent preset 后调用 `ctx.agents.resume`。Session header 不标识由哪个无 roster surface 创建，因此同一工作区内其他无 roster 会话仍可恢复。旧 Session 只会在命令完成后刷新并释放 handle。runner 在每个轮次后和最终清理期间等待 Agent 空闲并刷新会话。

一个 surface 持有进程 stdin。TTY 使用一个紧凑且不占用 alternate screen 的 Ink tree；已提交输出进入不可变 `Static` 区域，流式生成只更新实时回答与 composer，因此 token 增量不会重绘终端回滚。实时状态行显示当前模型、认证、Session 身份与排队消息数，无需重复打印静态欢迎行。成功的工具调用提交一条带名称的记录，其调用参数仍可通过 Ctrl+O 查看；失败结果会额外添加一条带名称的错误记录。`/clear` 会替换 Ink owner 并发送终端屏幕与回滚重置序列，再绘制新的欢迎行，因此旧 `Static` 累积内容不会稍后重新出现。重定向流使用排队纯文本 reader，使下一次提示出现前到达的行不会丢失。Agent 运行时，TTY composer 会把完整聊天消息保留在内存 FIFO；Agent 空闲后，runner 通过现有 follow-up 路径依次分派。聊天、遮罩凭据、`approval/request` waterfall（瀑布式事件）answerer 与 `ctx.userQuestions` 提供方都通过该 surface 串行交互，交互请求在待处理期间持有 composer。Agent turn 或可取消插件命令运行时收到 Ctrl+C/Escape 会取消当前操作；空闲 Ctrl+C、空缓冲区 Ctrl+D 与 stdin EOF 会产生成功的有界关闭。所有退出路径都会注销监听器和提供方。

内置命令层持有 `/login`、`/logout`、`/status`、`/model`、`/models`、`/new`、`/sessions`、`/resume`、`/clear`、`/help` 和 `/exit`。认证从 LLM 可配置 provider 目录和已解析 settings 中获得当前 provider 的 credential reference，且只通过 `ctx.credentials` 写入；命令 argv 中的 secret 会被拒绝，secret 不会进入输出或 Session 日志。模型发现与选择把 provider 目录、精确模型元数据和 reasoning effort 的解析交给 `ctx.llm`；因此官方路由与 Web surface 共用 V4 Flash/V4 Pro settings 目录，第三方路由也仍可发现。其他 slash command 通过 `ctx.commands` 分派，从而保留插件持有的 `/compact`、`/goal` 和未来扩展。

已提交的 `assistant/chunk` 文本增量会直接流式写入 stdout。若某个步骤未提交文本增量，则回退输出其组装后的 `assistant/message`；已经流式输出的步骤不会再次打印。`turn/end` 结束当前显示行。用户输入、审批、问题、工具活动和 assistant 输出继续通过各自现有的会话事件持有方，因此模型可见输入仍可从日志重建。

CLI 组合包会挂载现有 `ask_user_question` Consumer 与 worker-thread Code Mode provider，使模型问题和 `DSH_TOOLS_MODE=code|both` 到达完整能力 seam。它还会在 POSIX 上成组挂载持久终端 Service Definition、bash 提供方和终端工具 Consumer。这三个终端配置项在 Windows 上会一并禁用，`dsh-base` 则继续提供一次性 PowerShell 工具和沙箱化文件系统工具。该 profile 不声称支持 ConPTY。

[profile 插件组合包决策](../architecture/2026-08-05-profile-plugin-bundles.md)负责配置层组合和由应用持有的启动值。[Headless 作为直接 core 入口](../architecture/2026-08-09-headless-direct-core-entry-point.md)负责一次性聚合与退出状态语义。[持久 PTY 决策](2026-07-16-persistent-pty-sessions.md)负责终端生命周期和工具行为。

## Verification

聚焦包测试固定启动服务激活、非 TTY 与运行中 TTY 输入排队、唯一 stdin 持有者、多行编辑、slash 补全、secret 遮罩、紧凑工具行、同一 Agent 上的多轮输入、流式文本去重、审批与问题路由、命令分派、运行中轮次取消、空闲 Ctrl+C 与 EOF 关闭，以及 flush 先于 dispose 的顺序。profile 组合测试会真实加载 base 与 CLI 组合包 patch，不吞掉解析失败，并断言平台特定的终端配置项。构建形式与源码形式的 CLI 冒烟测试覆盖 `deepseek --version`、应用帮助和不发起模型请求的无密钥命令 transcript。Windows 安装器验收使用隔离的 npm prefix，连续执行两次安装，在全新的 CMD 与 Restricted 策略 PowerShell 进程中按名称解析 `deepseek` 并比较版本，最后验证重复卸载会移除命令。

## Alternatives considered

**每行启动一个 headless 进程。** 否决，因为每个进程都会创建不同的 Agent 与会话，follow-up 会丢失对话状态，重复启动也无法协调待处理的人类交互。

**通过 Web、ACP 或 JSON-RPC 驱动本地终端。** 否决，因为产品路径不需要网络或客户端协议。这些网关保留自己的传输校验与自动化约定，不成为 readline 的依赖。

**让每个人类交互消费方各自持有终端输入。** 否决，因为并发 reader 会争抢 stdin、重复注册信号处理器，并可能在聊天恢复时遗留审批、问题或遮罩凭据提示。

**在 Windows 上启用 POSIX 终端提供方。** 否决，因为进程组就绪与 teardown 不是 ConPTY 语义。禁用完整终端能力并保留 base PowerShell 工具，行为显式且仍可使用。

**在第一期包含外部编排。** 暂缓，因为本地进程所有权、取消与 transcript 行为本身即可独立使用和测试。后续集成必须通过插件 API 组合，且不改变本地 CLI 生命周期。

## Consequences

随附 CLI 提供结构化本地终端体验，具备持久多轮上下文、认证、模型/推理等级选择、会话替换与恢复、插件命令、交互式审批与问题，以及确定性清理。终端外壳已有富界面，但 assistant Markdown 与工具专用 diff 卡片仍按文本显示；preset 组合会话会被拒绝，避免在错误工具集下恢复。POSIX 用户获得现有持久终端工具；Windows 用户获得 base 的 PowerShell 与文件系统工具。外部编排不属于本期，也不阻塞本地终端验收。
