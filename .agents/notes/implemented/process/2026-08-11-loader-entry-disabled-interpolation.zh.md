# Agent Note：Loader 插值条目 `disabled` 字段

Status: implemented

[English](2026-08-11-loader-entry-disabled-interpolation.md) | 中文

## 问题

Windows 平台层（`packages/bundle/base/windows.cordis.patch.yml`）在 win32 上禁用 `tool-bash`，但 shipped 预设各自挂载了一行 `tool-bash`。预设行最后组合，同名行在 Windows 上重新启用了该工具——会话同时拥有 `tool-bash`（PowerShell 后端）与 `tool-pwsh`，且是静默的，因为没有 spec pin 组合后的预设层。条目元数据没有条件机制：`!!js` 只在插件 `config` 下插值，[postmortem 0002](../../../../docs/postmortem/0002-js-expression-disabled-filesystem-tools.md) 记录了 `disabled: !!js ...` 保持真值表达式对象、在所有平台上禁用该行的事故。

## 决策

Loader 插值条目 `disabled` 字段（`vendor/loader/src/config/entry.ts`）：`!!js` 表达式在每次挂载决策时基于 loader 上下文求值。`disabled` 是唯一被插值的元数据字段；`id`、`name`、`group`、`inject` 保持静态。原始节点保留在 options 中，写回保持 `!!js` 形式。shipped 预设（standard、code、cordis）用 `disabled: !!js process.platform === 'win32'` 门控 `tool-bash`，`verify-cordis-config` 现在只允许 `disabled` 中的表达式。

## 备选方案

**行上的声明式 `platform` 字段。** 静态且可被门禁检查，但它是 `!!js` 之外的第二种组合机制，且平台只是今天的条件。

**预设级平台 overlay。** 被否：条件应当属于它所治理的行。

## 后果

行可以按平台或环境门控自身；错误的表达式在启动时响亮失败。其余元数据字段保持字面值，门禁继续拒绝那里的表达式——`disabled` 上的 postmortem-0002 隐患以「求值」而非「禁止」关闭。`minimal` 预设缺失的 win32 PTY 栈是预设元数据的后续工作。
