# Agent Note: Web skill 工具行

Status: implemented

[English](2026-08-06-web-skill-tool-row.md) | 中文

## 问题

Web transcript（文本记录）通过通用后备行渲染 `skill` 调用，使已加载的指令集看起来像一次未知工具调用，尽管 Skill（技能）已是产品中的一等概念。通用行还会在结果旁暴露 JSON 参数的外层结构，围绕用户真正需要的唯一标识增加了噪声：已加载的 skill 名称。

## 决策

`ui-skill` 在现有的 `conversation.chat.toolview` 键控 slot 下注册 key 为 `skill` 的组件。该组件基于公开的 `ToolRowProps` 契约自行实现行 chrome，沿用 Bash 示例的独立注册方姿态，而不导入 conversation 私有组件。

收起的行使用 16 像素的文档与闪光组合图标，并沿用 Bash 行的中性色层级：图标采用三级色，`Skill` 标题采用二级色，分隔符采用 caption 色，skill 名称采用三级色。运行、失败和中断调用分别沿用 transcript 的扫光、错误状态点加首行摘要，以及警告状态点语义。已结算调用可以通过整个摘要行展开一个高度上限为 260 像素的 `Instructions` 卡片，其中原样呈现持久化结果文本；用于跳转至 trajectory 的现有 `Inspect` 入口仍保留在卡片下方。

该行的所有可见值均派生自已记录的调用／结果片段。skill 名称来自已记录的 `name` 参数，指令来自持久化的结果内容；该行绝不关联当前 skill 目录来读取描述或提供方元数据。由于 history 页可能包含 `tool/result`，而与之配对的 `tool/call` 已落在窗口外，通用 `HistoryEntry` envelope 现在会在结果条目上携带配对调用的名称、精确的 arguments JSON 和事件时间。Host 从完整日志派生这份瞬时注解和结果渲染意图；runtime 优先使用窗口内调用，否则从该注解物化出相同的 `ToolResultNode.call` 和 `callTime`。无配对结果仍为 `call: null`；调用事件位于页面外时，调用侧渲染意图仍不可用。现有的 ACP（Agent Client Protocol）`skill-load` 记录经由真实的 Web 持久化与组合路径写入，用于无需密钥的交互和无障碍快照。

## 考虑过的替代方案

- 保留通用工具行，只添加一个 `skill` 颜色选择器，并将其放在 `ui-conversation` 中。该方案仍会保留多余的输入外层结构和通用展开体，也会让 conversation 包拥有特定领域的视觉规则。
- 在宿主工具渲染意图联合类型中添加新的 `skill` 值。键控客户端 slot 已经能够识别该工具；跨页修复属于所有工具共用的通用 history 配对 envelope，而不是 skill 专用的呈现值。
- 导出 conversation 包的私有 `ToolRow` 组件供复用。客户端包刻意对外暴露契约而非跨包组件；导出该组件会使独立功能包耦合到 conversation 的实现细节。

## 后果

除了引用 source 的依赖外，`ui-skill` 现在还依赖公开的 conversation toolview 契约、locale 包、原语包和 React。它自行保留了一小份折叠展开行 chrome，因此未来的全局交互变更必须与 Bash 示例和 conversation 行同步更新这个注册方。

无论跨越分页，还是已安装的 skill 目录发生变化，冷回放都保持确定性；在用户显式展开指令前，transcript 保持紧凑。通用配对注解还可防止其他键控工具行和结果 presenter 在分页边界改变身份，同时无需持久化重复数据。专用卡片有意显示工具完整封装的输出，而不是只提取 `<skill_instructions>`，从而原样保留模型实际收到的内容，也避免为 skill 结果格式再引入一个解析器。
