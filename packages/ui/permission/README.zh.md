# @deepseek-ai/dsh-permission

[English](README.md) | 中文

通过 `ctx.permission`（[`PermissionService`](src/index.ts)）提供面向用户的权限 preset。每个配置名称都会将 `sandbox/mode` 与 `approval/policy` 组成一组；默认项为 `workspace-write`（`workspace-write` + `ask`）和 `danger-full-access`（`danger-full-access` + `never`）。UI 适配器可以将该表作为单个选择器公开，而沙箱执行与审批仍分别消费各自的调节项。

`set(session, name)` 会先在仅写日志的 `permission/preset` 事件中记录已变更的选择，再仅对实际值发生变化的调节项调用 setter。选择事件先于调节项事件，并在多个 preset 共享同一组取值时保留用户意图；净变化为零的选择不会追加任何内容。`current(events)` 优先返回仍与当前调节项匹配的已记录选择，其次返回表中第一个匹配项，否则返回 `custom`。客户端可以把 `custom` 显示为当前值，但不能选择它。

该服务要求存在具有约束能力的 `ctx.bash` 执行器和 `ctx.approval`。表中名为 `custom` 的条目会在加载时抛出异常；如果组合在表外指定默认值，则零事件会话会推导出 `custom`。详见[沙箱切换设计](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md)。

两个可选子件在同一服务之上交付产品界面：`permissions` 会话投影单元（`src/types.ts` 声明该 key；单元折叠三个全量值旋钮事件，在组合默认值之上视图出 select——表内选项加仅作当前值的 `custom`）与 `/permission` 命令（裸调用报告当前预设与表；预设参数经 `set` 切换）。每个子件仅在其注册表（`ctx.sessionProjections` / `ctx.commands`）被组合时激活。

## 模型体验

间接地，通过 `dsh-user-approval` 和 `dsh-tool-bash`：二者会渲染由此服务的调节项事件所选择的审批策略提示词、切换通知和沙箱工具结果；`permission/preset` 本身只写入日志。

#### KV Cache 影响

不会直接使缓存失效；具名消费方拥有所有请求前缀变更。

## 已知限制与延期工作

- **只组合两个机制调节项**：preset 选择沙箱模式和审批策略；agent（智能体）／profile 选择尚未纳入 `PresetSpec`。
- **`custom` 只能推导得出**：调用方可以从不匹配的调节项组合切换出去，但无法通过此服务选中或持久化一个具名 custom preset。
- **preset 表位于进程级别**：配置在插件生命周期内固定；更改可用 preset 必须重新加载插件。
