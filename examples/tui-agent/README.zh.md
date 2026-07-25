# tui-agent

[English](README.md) | 中文

全屏交互式编码 agent（智能体）：DeepSeek V4、本地 bash 与文件系统工具、压缩（compaction）、subagent、工作流与新 agent Ralph 迭代、plan mode（`/plan` 进入，`exit_plan_mode` 评审退出）、超时／溢出策略，以及通过 [`@deepseek-ai/dsh-tui-demo`](../../packages/examples/tui-demo) 提供的 JSONL 持久化；该应用从 `cordis.yml` 加载。同级 [`headless-agent`](../headless-agent/README.md) 以适合单次管道的任务形式运行同一能力类，[`acp-agent`](../acp-agent/README.md) 则通过 JSON-RPC 提供该能力。

## 运行

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:tui
```

演示脚本和可安装的 `dsh` CLI（[`apps/cli`](../../apps/cli/README.md)）都会作为已交付的默认配置启动此示例的 `cordis.yml`；`dsh` 还会应用 `~/.dsh` 中的个人覆盖，并将调用目录作为 workspace。

输入一项编码任务。agent 使用 `read`/`write`/`edit` 文件系统工具处理常规文件操作，使用 `bash`（加上面向后台任务的通用 `task_output`/`task_list`/`task_kill`）执行 shell 命令、搜索和测试。每次操作都在新的 `bash -c` 中运行（系统提示词要求模型传递 `workdir`，而不是使用 `cd`）。fs 工具和 bash 都会根据会话 workspace 解析相对路径。agent 还可以通过 `subagent`/`subagent_fork` 委托。

`todo_write` 任务跟踪器是选用的，不在已交付配置中：请将 `@deepseek-ai/dsh-tool-todo` 添加到 `cordis.yml`（或在 `~/.dsh` 下使用个人配置覆盖）以公开该工具。加载后，模型会把整表计划记录到会话日志，TUI 则渲染它。

TUI 渲染 Markdown 历史、推理、工具所有的终端／diff／通用卡片、token 总量，以及加载 `todo_write` 时的最新计划。较长的工具正文保留首尾预览；Ctrl+O 展开或折叠所有卡片。Enter 用于提交，或在 agent 运行时进行 steering（中途引导）；Ctrl+R 切换推理，Escape 取消，`/help` 列出命令。`/plan` 为下一步骤选择 plan mode；`/plan <message>` 还会将消息提交到该步骤，`/plan off` 则在没有模型输入的情况下选择默认 mode。`/status` 会展开当前会话的标识、活动计数、精确 token／缓存 bucket、上下文用量和时间戳，而不中断正在运行的轮次。`/model` 打开当前提供方目录的键盘选择器；使用 Up/Down 和 Enter，或使用 `/model <model>` 和 `/model <provider>/<model>` 直接选择。`ask_user_question` 会打开一个位于左下方的宽键盘面板，包含批次进度和编号选项。

### 恢复早先的会话

每次运行默认都会启动新会话（其事件日志落在 `./.sessions/` 下）。如需 **继续** 先前对话，请将其 id 传给已安装的 `dsh` CLI：此时 `main` agent 会重新水化持久日志，而不会从头开始，因此模型会将早先轮次视为历史：

```sh
dsh --resume <prior-session-id>
```

`/resume` 打开可搜索键盘选择器，显示标题、活动、上一轮结果、模型路由、持久 goal 阶段和实时／已持久化状态。已安装的 `dsh` 宿主会刷新并释放当前应用，然后以 `dsh --resume <id>` 替换进程。TUI 仍会在退出时打印该命令，并在自定义宿主无法移交时显示它。`dsh --resume <id>` 在启动上下文中提供 id，`cordis.yml` 会读取它（`resumeSessionId: !!js "typeof resumeSessionId === 'string' ? resumeSessionId : undefined"`）；没有标志时，agent 会开始新会话。缺失或无法读取的 id 不会启动 agent，而会发出 `agent-loop/config-start-failed`：TUI 打印失败并以非零状态退出。选择器没有跨进程会话锁，因此拥有并发宿主的部署必须自行协调会话所有权。

## Code Mode

[`code-mode.cordis.yml`](code-mode.cordis.yml) 在同一树上覆盖 worker 线程运行时和 `tools: { mode: code }`。模型会收到一个 `run_code` 传输工具，加上一份为可见工具生成的 TypeScript SDK；只有程序输出会返回模型上下文。使用 `mode: both` 可在 `run_code` 旁同时公开原生调用。执行契约详见 [Code Mode Agent Note](../../.agents/notes/implemented/feature/2026-06-15-code-mode.md)。

```sh
pnpm run demo:code-mode        # this overlay under the TUI (default UI)
pnpm run demo:code-mode acp    # the acp-agent example's same-shaped overlay
```

尝试一项横跨多个工具调用的任务，例如：

> 统计 docs/ 下每个 `*.md` 文件的行数，并将最大的三个写入 summary.txt。

然后观察 transcript（文本记录）：一次 `run_code` 调用、一个循环调用工具的程序，以及模型筛选后的结果，而不是五次原始工具输出往返。

## 每个叶节点配置项所演示的内容

此示例是轻量叶节点 `cordis.yml`：它选择可替换后端、加载一个应用包（package），并添加有意放在共享主干外的产品工具。主干（会话、系统提示词、工具、agent、不变式、`agent-loop`）和入口集群（JSONL 持久化、pi-tui 通道、预创建的 `main` agent）位于 [`@deepseek-ai/dsh-tui-demo`](../../packages/examples/tui-demo) 应用及其加载的 [`@deepseek-ai/dsh-agent-spine-demo`](../../packages/examples/agent-spine-demo) 组合包中；叶节点负责接线后端与面向模型的可选工具：

| 配置项 | 演示内容 |
|---|---|
| `hmr` (`@cordisjs/plugin-hmr`) | 开发／演示的编辑-重载循环：它是 **叶节点** 配置项（不内置到应用），因为它依赖 Loader 的内部模块访问 |
| `llm-deepseek` | 通过配置提供真实 `LlmAdapter`（`!!js process.env.…` 密钥）；将一行替换为 `@deepseek-ai/dsh-llm-pi-ai` 即可使用库后端对照实现 |
| `bash` (`dsh-bash-local`) | 执行器实现：bash seam 的可替换一半。面向模型的 `bash` schema（`tool-bash`）和通用 `task_*` 控制（`tool-tasks`）由 `dsh-agent-spine-demo` 提供，因此叶节点只选择执行器 |
| `tui-agent` (`@deepseek-ai/dsh-tui-demo`) | 应用组合包：agent-spine 演示 + JSONL 持久化 + pi-tui 通道 + 预创建的 `main` agent |
| `subagent`, `subagent-spawn`, `subagent-fork` | subagent 提供方注册表加两个进程内后端：新子 agent，以及用父 agent 已完成轮次前缀播种的子 agent |
| `tool-subagent`, `tool-subagent-fork` | 两次面向模型的 `dsh-tool-subagent` 加载，每次绑定不同提供方，并以不同工具名（`subagent`、`subagent_fork`）公开 |
| `workflow-workerthread`, `tool-workflow` | worker 线程工作流引擎及其面向模型的 `workflow` 工具，子调用通过 spawn 后端路由 |
| `plan-mode` | 插件拥有的 `/plan [message]` 进入命令和 `/plan off` 退出命令、plan-mode 提示词策略、工具限制，以及经评审的 `exit_plan_mode` 转换 |
| `fs-local`, `fs-policy`, `tool-fs` | 文件系统栈：本地 `ctx.fs` 提供方、先读后写／编辑策略门禁（位于 `fs/*` 事件门禁），以及面向模型的 `read`/`write`/`edit` 工具。相对路径根据会话 workspace 解析 |

## 端到端测试（`pnpm run test:e2e`）

与 UI 无关的带密钥套件通过 `tests/harness.ts` 以程序方式组装完整栈（无 PTY、无 Loader）：

- `tests/full-loop.e2e.ts`：canary 测试：真实模型通过真实 bash 工具运行 `echo e2e-ok`；断言 `tool/call`/`tool/result` 会话事件和最终答案。
- `tests/coding-task.e2e.ts`：类 swebench 冒烟测试：临时目录包含 `add.js`（其中 `a - b` 写在本应是 `a + b` 的位置）和失败的 `add.test.js`；agent 必须修复错误并验证。测试会自行重新运行 `node add.test.js` 并检查文件，不信任 agent 的声称。
- `tests/resume.e2e.ts`：跨进程持久连续性：第一次运行告诉真实模型一个密码并将轮次持久化到临时 JSONL 根目录，然后释放整个上下文；第二次运行在同一根目录上创建新上下文，恢复会话 id 并要求模型回忆密码。只有重新水化的日志能够提供该回忆。
- `tests/compaction.e2e.ts`：压缩冒烟测试：一项真实多步 bash 任务在故意设得很小的上下文窗口中运行，使自动压缩监听器在会话中途触发。测试验证外部状态：真实日志中出现 `compact/start…end` 对，表层缩减（替换节点遮蔽旧节点），且 agent 在压缩后仍给出正确最终答案。
- `tests/todo-write.e2e.ts`：加载选用 `todo_write` 工具，由真实模型驱动，测试验证产生的 `todo/write` 会话事件。
- `tests/code-mode.e2e.ts`：带密钥 Code Mode 证明：使用真实模型和双工具任务，断言线上工具列表精确为 `[run_code]`，`tool/code-dispatch` 事件位于父调用下，且筛选后的答案已返回。

这些测试在没有 `DEEPSEEK_API_KEY` 时自行跳过。无密钥 `tests/tui-keyless-smoke.e2e.ts` 通过 PTY 启动真实 Loader 树（唯一获准的 PTY 界面）：基础启动 + `/plan` + `/exit`，一次带问题对话框和工具往返的脚本 LLM 对话，Code Mode 覆盖欢迎行，以及恢复失败退出路径。

## 快照测试

`tests/snapshots/<scenario>/session.jsonl` 提供已录制的用户提示词和模型分片；同级子日志驱动 subagent 和工作流。无密钥套件通过真实循环和工具实现执行这些脚本，然后比较可读的预期终端单元格／样式输出。使用 `pnpm run test:snapshot:refresh` 刷新仅展示变更；已录制模型旅程改变时，使用 DeepSeek 密钥运行 `pnpm run test:snapshot:record`。已实现的 [TUI 快照 Agent Note](../../.agents/notes/implemented/testing/2026-07-18-tui-terminal-state-snapshots.md) 拥有场景矩阵，以及已录制旅程、瞬时包快照与 PTY 覆盖之间的分工。
