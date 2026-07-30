# Agent Note: Web 消息 IconActions 与时钟

Status: implemented

[English](2026-07-29-web-message-icon-actions-and-clock.md) | 中文

## 问题

Web 聊天的用户气泡已有复制／分支／编辑 IconActions，但没有时钟。已定稿的 assistant 叙述下方完全没有操作栏，尽管 Harness 设计稿在回答结束后展示复制／分支／时钟。流式回复不得在 token 中途闪出该栏。经 memo 的行在跨午夜时仍保持稳定 props，因此一次性的 `Date.now()` 会让昨日消息一直卡在 `HH:mm`。

## 决策

**用户气泡在既有 IconActions 行前追加感知日期的本地时钟；每个*已结束* turn 最后一条带 text 内容的 assistant 在正文下追加带 `margin-top: 16px` 的复制／分支／时钟；两边只要挂载就保持可见，并在下一个本地午夜重新格式化。**

两边都通过 `formatMessageClock` 格式化 `node.time`：同一日历日 → `HH:mm`，同年更早 → `M月D日 HH:mm`，跨年 → `YYYY年M月D日 HH:mm`。`useCalendarDay` 是组件本地的日刻度（定时到下一个本地午夜），因此 memo 行在日历日变化时会重渲染，且不新增框架 hook。`MessageItem` 把标签放在复制之前（figma `388:20051`）。`ChatView` 通过 `assistantActionsSeqs` 推导 turn 尾部 seq，并用 `withholdActionsTurn` 扣留仍在运行的 turn（优先流式 `partial.turn`，否则第一条 `runningCalls` 的 turn；在第一步出现前仅有 `running` 时不得撤掉上一回合已定稿答案的座位）。选择器返回原始 turn 值，因此 token 风暴不会让列表父级重渲染。`AssistantMarkdown` 把该行放在分支之后（figma `43:32997`），且仅在 `streaming` 为 false、已知事件时间、且节点含非空 text 内容时渲染。纯 Think 节点、turn 中间叙述、活跃 turn 的内容与流式尾部省略该行。复制写入拼接后的 text 块。分支仍是 chrome stub。剪贴板写入与时钟辅助函数放在 `message-chrome.ts`。组装面由 `apps/web/tests/message-actions.e2e.ts`（自有冷 seed，含 turn 中间叙述文本 + aria golden，仅在用户气泡与 turn 尾部 `DONE` 下放置复制）钉住；aria 归一化把每种时钟形态折叠为 `{{clock}}`。

## 曾考虑的方案

**在流式过程中展示 assistant IconActions。** 否决：需求是输出完成后才展示该行；中途 chrome 会闪烁，并诱使复制半截回答。

**给每个已定稿 assistant 节点（含纯 Think）都挂 IconActions。** 否决：没有 text 内容时复制没有可写内容，且在每一步／Think 下重复 chrome 会打乱流程；只有内容输出拥有该座位。

**给多步 turn 中每一条带 text 的 assistant 都挂 IconActions。** 否决：turn 中间叙述（工具调用前的 text）不是已定稿答案；在每一步下重复复制／分支／时钟会打乱流程。只有已结束 turn 的最后一条内容 assistant 拥有该座位。

**仅用 `running` 加上已定稿节点中的最大 turn 推导运行中 turn 的扣留。** 否决：step-1 文本落地后工具可能跑数秒，该 tip 暂时就是「最后一条 content」，chrome 会先出现再消失；`partial`／`runningCalls` 能指名开放 turn 且无此闪烁，而第一步前仅有 `running` 时必须保留上一回合已定稿答案的座位。

**在具备 hover 能力的指针上用 hover 才揭示操作行。** 否决：行一旦存在就应保持可发现；用 opacity 隐藏容易漏看，且需要父级 hover 选择器重复挂载门控。

**把分支接到真实的会话 fork。** 本次否决：与已归档的[用户 IconActions 笔记](../../archived/feature/2026-07-27-user-message-icon-actions.md)同一理由——变更路径尚未规定；按钮只预留设计座位。

**通过 chat store 或 inject hook 发布日历日。** 否决：日刻度只是展示层本地状态，没有跨入口消费者；组件本地 timeout 符合「行为 hook 可拥有不订阅外部源的状态」这一客户端规则。

## 后果

每个已结束 turn 的最后一条内容回答在行挂载后立刻暴露复制与事件时钟；turn 中间内容、活跃 turn 的内容与纯 Think 节点不带 chrome；分支仍为 stub。用户与 assistant 时钟共用同一套跨天／跨年加宽规则，并在午夜后无需消息变更即可刷新。逐消息分页仍是包 README 中的暂缓 footer 座位。包级测试钉住三种时钟形态、午夜加宽、仅内容门控、turn 尾部 seq 门控与运行中 turn 扣留；Web e2e 场景钉住组装后的 IconActions chrome，含 turn 中间叙述且无第三个复制控件。
