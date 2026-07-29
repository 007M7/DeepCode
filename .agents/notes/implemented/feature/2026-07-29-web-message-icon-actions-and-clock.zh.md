# Agent Note: Web 消息 IconActions 与时钟

Status: implemented

[English](2026-07-29-web-message-icon-actions-and-clock.md) | 中文

## 问题

Web 聊天的用户气泡已有复制／分支／编辑 IconActions，但没有时钟。已定稿的 assistant 叙述下方完全没有操作栏，尽管 Harness 设计稿在回答结束后展示复制／分支／时钟。流式回复不得在 token 中途闪出该栏。

## 决策

**用户气泡在既有 IconActions 行前追加感知日期的本地时钟；已定稿的 assistant 节点在正文下追加带 `margin-top: 16px` 的复制／分支／时钟。**

两边都通过 `formatMessageClock` 格式化 `node.time`：同一日历日 → `HH:mm`，同年更早 → `M月D日 HH:mm`，跨年 → `YYYY年M月D日 HH:mm`。`MessageItem` 把标签放在复制之前（figma `388:20051`）。`AssistantMarkdown` 把它放在分支之后（figma `43:32997`），且仅在 `streaming` 为 false 且已知事件时间时渲染；流式尾部省略该行。复制写入拼接后的 text 块。分支仍是 chrome stub。具备 hover 能力的指针在 hover／focus-within 前保持两条 footer 透明。剪贴板写入与时钟辅助函数放在 `message-chrome.ts`。

## 曾考虑的方案

**在流式过程中展示 assistant IconActions。** 否决：需求是输出完成后才展示该行；中途 chrome 会闪烁，并诱使复制半截回答。

**把分支接到真实的会话 fork。** 本次否决：与已归档的[用户 IconActions 笔记](../../archived/feature/2026-07-27-user-message-icon-actions.md)同一理由——变更路径尚未规定；按钮只预留设计座位。

## 后果

已定稿的 assistant 回答立刻暴露复制与事件时钟；分支仍为 stub。用户与 assistant 时钟共用同一套跨天／跨年加宽规则。逐消息分页仍是包 README 中的暂缓 footer 座位。测试钉住三种时钟形态、仅在非流式时出现 assistant footer，以及复制载荷（仅 text 块）。
