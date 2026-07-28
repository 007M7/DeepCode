# @deepseek-ai/dsh-client-ui-plan

[English](README.md) | 中文

Plan mode 编辑器控件，纯浏览器 surface 插件。浏览器侧以一个感知待生效态的模式选择器占据会话声明的 `conversation.input.plan` 单座；node 侧是空 apply（roster 行）。plan 行为本身——`/plan` 命令、边界提交的 `plan/mode` 状态、`plan` 投影单元与 policy 段——归 [`@deepseek-ai/dsh-plan-mode`](../../plan/plan-mode/README.md) 所有，由 host roster 独立组合。

读取走通用投影对：控件经标准套件的 `useProjection` 渲染 host 计算的 `plan` 投影（`{ active, pending }`）；key 缺席即能力缺席并隐藏控件，因此未组合 plan-mode 的 host（或尚无会话的 Draft）不展示座位内容。写入走标准命令通道：选择模式即经 `command.execute` 执行 `/plan` 或 `/plan off`，其入日志的 `command/run` 立即折叠为 pending 投影帧，请求边界的 `plan/mode` 提交将其兑现——控件不持有任何客户端侧 plan 状态，只显示 host 确认的值，且在生成期间保持可用（切换绝不取消轮次；待生效目标在下一次模型请求边界生效）。

透明的原生 select 把键盘焦点镜像到可见 chip 上，并携带区分已提交与待生效模式的动态无障碍描述。准入失败（`matched: false`、业务错误、传输故障）以内联错误呈现，不改变显示的模式。

模型通过稳定的 `exit_plan_mode` 工具退出 plan mode；其 plan 评审走已组合的 Web question 通道。

## 模型体验

间接地，通过控件派发的 `/plan` 命令行：`@deepseek-ai/dsh-plan-mode` 拥有这些命令行驱动的模型可见 policy 段、退出工具 schema 与已记录状态，本包只渲染投影并发送用户同样可以手敲的内容。

#### KV 缓存效应

进入或离开 plan mode 会改变活跃的 `plan:policy` 系统提示词段，因此改变请求前缀；控件本身不添加任何提示词内容。

## 已知局限与延后工作

- **Plan mode 是引导而非执行沙箱**——需要强制只读规划的部署必须组合独立的沙箱与审批策略。
- **控件属于默认编辑器**——待处理的整编辑器交互（如 plan 评审）会临时取代 InputBar 及其模式控件。
- **无 Draft 期选择**——会话存在之前没有投影，座位保持为空；plan mode 在首个 prompt 创建会话后选择。
