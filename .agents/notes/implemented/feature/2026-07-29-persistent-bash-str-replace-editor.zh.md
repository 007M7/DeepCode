# Agent Note：持久 Bash 与字符串替换编辑器工具

状态：已实现

[English](2026-07-29-persistent-bash-str-replace-editor.md) | 中文

## 问题

部分部署需要只调用一次的 Bash schema，同时要求 shell 状态跨模型轮次保留；另一些部署需要与终端选择无关的 Claude 风格 `str_replace_editor`。把两个工具绑在一起或按某个基准命名，会阻碍复用并模糊配置归属。

## 决策

`@deepseek-ai/dsh-tool-bash-persistent` 消费 `ctx.pty` 并注册一个 `bash(command)` 工具。它为每个精确 Agent 惰性创建一个交互式 shell，并串行化该所有者的调用。Cwd、导出的变量、已激活环境、函数和后台任务会保留。随机私有标记划分命令输出；保留的 scrollback 会向前分页，以恢复命令真正的输出前缀，若前缀已被丢弃则明确告知。超时或取消会先关闭 shell，避免下一次调用复用状态不确定的会话，模型可见的超时／退出结果也会说明该重置。可配置描述默认只声明持久性事实，因此网络和软件包镜像等声明仍归部署所有。

`@deepseek-ai/dsh-tool-str-replace-editor` 独立消费 `ctx.fs`，注册包含 `view`、`create`、`str_replace` 与 `insert` 的 `str_replace_editor`。它提供带行号文本查看、过滤后的两层目录列表、唯一字面量替换、规范插入边界和有界输出。路径必须为绝对路径，变更会保留请求编辑范围之外的制表符，且公开 schema 与错误只使用 `old_str`。它可以与持久 Bash、一次性 Bash、沙箱 Bash 或无 shell 组合。

`dsh-system-prompt` 接受 `includeHarnessIdentity: false`；`dsh-agent-spine-demo` 会转发该设置，并接受 `toolBash: false`。因此部署可以拥有精确 persona，并替换 spine 的原生 Bash，而不会重复注册提示词或工具。既有默认值不变。

两个插件都进入 Python runtime 闭包。持久 Bash 的闭包还包含 PTY 服务／本地后端，以及该后端要求的沙箱服务。由于 `node-pty` 会执行原生 `spawn-helper`，每个打包后的运行时可执行文件都会携带一个架构匹配的 `-spawn-helper` 伴随文件。固定版本的 `node-pty` 补丁只在该伴随文件存在时解析它，普通 Node 运行仍保留上游查找方式。显式的 `DSH_NODE_PTY_SPAWN_HELPER` 覆盖仍予保留，供当前提供非伴随 helper 的外部消费方使用。可执行文件与运行时 wheel 包的构建器会检查 ELF 或 thin Mach-O 文件头；若 helper 缺失、架构不匹配或不可执行，构建会在发布前失败。

## 考虑过的替代方案

**单一组合兼容插件。** 被拒绝，因为两个工具互不依赖，组合命名还会把可复用能力绑定到某个基准。

**复用一次性 Bash。** 被拒绝，因为 `bash -c` 无法跨调用保留 cwd 或环境状态。

**暴露终端管理工具。** 被拒绝，因为 open/send/read/close 与单个持久 `bash` 调用是不同的模型动作空间。

**修改原生 read/write/edit。** 被拒绝，因为这会扭曲其通用契约，而不是增加一个可独立组合的编辑器。

## 后果

Profile 可以通过配置 persona 和描述复现外部 Agent，而底层包保持通用。持久 Bash 需要拥有它的 Agent 与真实 PTY 后端；shell 退出、超时或取消会丢失状态。编辑器把安全与变更策略委托给挂载的文件系统栈。runtime wheel 的使用者仍不需要安装 Node，但 wheel 现在包含主可执行文件及其私有原生 helper，而不是单个物理文件。
