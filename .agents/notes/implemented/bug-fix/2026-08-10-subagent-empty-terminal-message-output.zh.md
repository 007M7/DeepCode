# Agent Note: 用同一条选取规则在空终止消息后保留子代理输出

Status: implemented

[English](2026-08-10-subagent-empty-terminal-message-output.md) | 中文

## 问题

当 `max-tokens` 步骤只组装了工具调用块时（`BlockAssembler.blocks()` 会丢弃被截断的工具调用），agent loop 会追加一条内容为**空**的 `assistant/message`——这条消息仅用于承载 usage。三个消费方各自用自己的规则选取"子代理的回答"，并且都把这个 usage 宿主当成了回答：进程内驱动的 `readResult` 和 continuable Activation 的 `subagent/end` capture 不加过滤地取**最后一条** `assistant/message`，SDK 后端的观察器则让任何 `assistant/message` 覆盖其流式文本兜底。于是在被 max-tokens 截断的多步回合中，最后那条空消息抹掉了真实的部分回答：`SubagentResult.output` 返回 `[]`，工具结果、遥测和 `subagent/end.lastAssistantMessage` 全都看不到任何内容。此外进程内驱动完全没有流式文本兜底，因此被取消的子代理若其唯一文本只存在于 `assistant/chunk` 事件中，也会报告 `[]`。

## 决策

`dsh-subagent` 在 `src/assistant-output.ts` 中拥有唯一的规范选取规则：最后一条**非空** assistant 消息优先；没有时，累积的 `text-delta` 流就是回答；空内容消息从不参与。`finalAssistantOutput(events)` 把该规则应用于事件后缀（进程内 `readResult` 与 Activation capture），`assistantMessageOutput(event)` 是同一规则的逐事件谓词，供 SDK 后端的增量折叠使用。契约在 `SubagentResult.output` 处声明一次，并由子系统参考文档镜像；`subagent/end.lastAssistantMessage` 声明按同一规则选取。`max-tokens` 或 `aborted` 终止仍然如实上报其终止原因；只有输出选取发生了变化。

ACP 后端只累积分块，从未受影响。fake SDK runtime 新增 `FAKE_EMPTY_MESSAGE` 模式，使无密钥后端测试能够脚本化一条仅承载 usage 的终止消息。

## 考虑过的替代方案

**各消费方就地修复、不抽共享辅助函数。** 之所以否决：缺陷恰恰源于三处手写选取的漂移；同一次运行的观察方必须对其回答达成一致，因此规则需要唯一实现（最早证明该缺陷的草稿 PR #1140 与 PR #1141 分别修补了三处调用点中的两处，留下 Activation capture 不一致）。

**让 loop 不再追加空消息。** 之所以否决：这条消息是 usage 宿主，也是该步骤的持久化记录（"model-visible ⟺ logged"）；为一个消费方侧的选取缺陷重塑会话事件，会波及所有 replay 与 projection 消费方。

**把空内容消息视为错误。** 之所以否决：流式文本才是子代理真实的部分回答，且终止原因已经告诉消费方轮次被截断。

## 后果

被 max-tokens 截断的多步子代理会报告其更早的文本；被取消的进程内子代理保留中止前已流式的文本；一次性与 continuable 的 `subagent/end` 边沿与 `SubagentResult.output` 一致。内容非空但不含文本的消息（例如仅含 reasoning）仍然优先于流式文本——规则针对的是内容为空，而非文本缺失。三个包中的回归测试脚本化了空终止消息与取消路径，并在先前的选取实现下失败。
