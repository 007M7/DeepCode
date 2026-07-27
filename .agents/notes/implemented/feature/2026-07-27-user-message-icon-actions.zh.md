# Agent Note: 用户消息气泡下方的 IconActions

Status: implemented

[English](2026-07-27-user-message-icon-actions.md) | 中文

## 问题

聊天用户气泡下方没有操作栏。Harness 设计稿（figma `User_Bubble/message_container`）在气泡下方右对齐展示三个 IconActions——复制、在新对话中分支、编辑——与产品其他位置使用的操作栏模式一致。

## 决策

仅当 `kind: 'user'` 时，`MessageItem` 拥有这些操作。布局为纵向列（`align-items: flex-end`，间距 6px）：先是气泡，再是高度 28px 的操作行；行内间距 10px，圆形图标按钮尺寸为 28px（`IconCopyOutline16`、`IconBranchOutline16`、`IconEditOutline16`）。Tooltip 承载中文标签。按 [Web 样式](../../../../docs/web-styling.md) 的消息操作栏规则，该行保持 `opacity: 0`，直到用户行被悬停或处于 focus-within 状态。

复制将气泡内拼接后的文本块写入剪贴板（`navigator.clipboard.writeText`，并以 `execCommand` 作为回退）。分支与编辑目前仅有外观、尚无处理函数——它们预留设计席位，但不发明会话 fork 或编辑重提交流程。

steering（中途引导）气泡保持仅徽章形态，不展示这些操作。

## 考虑过的替代方案

**现在就把分支／编辑接到真实的会话 fork 与草稿编辑。**本次变更不予采纳：这些产品流程尚未定稿；交付无行为按钮符合请求范围，也避免半成品的变更路径。

**操作始终可见（无悬停淡入）。**与现行操作栏规则冲突，不予采纳；figma 节点展示的是静止态外观，而非样式指南要求的空闲隐藏状态。

## 后果

用户消息立即可用复制；分支／编辑仍为可点击的占位，直至后续决策明确其行为。测试钉死三个按钮、复制载荷，以及对 steering 的排除。
