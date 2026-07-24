# Agent Note: Empty model completions are retryable EMPTY_RESPONSE failures

Status: implemented

[English](2026-07-24-empty-model-response-is-retryable.md) | 中文

## Problem

提供方偶尔会返回一种退化的 completion：流本身格式完好，携带一个终止性的 `stop` 结束，却没有任何内容块——没有文本、没有 reasoning（推理）、没有工具调用。本次改动前，两个适配器都会把它映射为成功的 `{kind: 'stop'}` 结束，于是主循环记录了一条空的 `assistant/message`，并把该轮次以 `completed` 结束。没有任何重试，也没有任何显式失败，而像 goal-session 这样的驱动方会把这次静默的空操作计为一次已消耗的 goal 轮数。一次线上事故显示，某个由 openrouter 提供的模型在触及 goal 的轮数上限而被阻塞前，把六轮 goal 中的三轮消耗在了空 completion 上。

## Decision

由适配器把「已完成但为空」的响应归类为一次提供方边界失败，重试策略则将其视为瞬时性问题：

- `dsh-llm` 在 `CONTEXT_WINDOW_EXCEEDED_CODE`/`QUOTA_EXCEEDED_CODE` 之外，导出规范代码 `EMPTY_RESPONSE_CODE`（`'EMPTY_RESPONSE'`）。
- `dsh-llm-pi-ai`（`mapStopReason`）：当终止性 `stop` 所对应的 assistant 消息没有内容块时，它会变成一个携带该代码的 `finish {kind: 'error'}`。上下文溢出检测在其适用场景中仍然优先（它先被检查，也是更具可操作性的归类）。
- `dsh-llm-deepseek`（`translate`）：在 `[DONE]` 处，若 `stop`（或缺失）结束且没有打开过任何块，则同样变成该错误结束。仅含 reasoning 的流算作有内容，仍视为成功。
- `dsh-llm-retry` 把 `EMPTY_RESPONSE` 加入 `DEFAULT_RETRYABLE_CODES`：这次尝试没有产生任何持久内容，因此重复它是安全的；部署方仍可通过 `retryableCodes` 将其移除。

检测仅限于 `stop` 结束。内容为空的 `max-tokens` 保持其既有含义（pi-ai 已经把零输出的溢出场景归一化处理），`tool-calls` 在实践中不可能是空块，而 error／aborted 结束本身已经算失败。

这套归类沿用既有的主循环机制——`finishError` → `agent/request-error` → `dsh-llm-retry`——因此无需改动 `agent-loop`；在重试预算耗尽后，该轮次会以 `EMPTY_RESPONSE` 显式失败，而不再静默地以空内容完成。

## Alternatives considered

**在主循环或 `BlockAssembler` 中检测。** 只需一份共享实现，但这会把对提供方响应的判断挪进主循环，违背「插件优先，而非改动主循环」，且 assembler 是纯粹的组装算法。适配器才是把协议层面的事实转化为 harness 归类的地方，而溢出重归类正是精确的先例。

**在 `llm/stream` waterfall（瀑布式事件）上做一个流转换插件。** 这种做法提供方无关且只需一份实现，但它为「每个适配器几行就能声明的边界事实」额外增加了一个包和相应接线，而且默认开启的行为仍需改动每一个 bundle。

**把仅含空白或仅含 reasoning 的响应也当作空响应。** 作为过度设计予以否决：这类响应携带了模型产生的内容，把一个合法（哪怕无用）的响应误判为传输类失败，会在那些故意在 reasoning 之后停止的模型上引发重试循环。其范围严格限定为「零内容块」。

## Consequences

- 一个偶发异常的提供方现在只会花费一次有界的重试，而不再是一个被静默浪费的轮次；一个持续返回空内容的模型则会显式暴露为一次用户可据以行动的 `EMPTY_RESPONSE` 轮次失败。
- 一个确实打算什么都不说的模型（罕见，但在一次工具结果之后有可能出现）现在会被重试，若始终为空，则该轮次失败。这个取舍是经过审慎权衡后接受的：一条空的 assistant 消息与提供方缺陷无法区分，且对用户毫无价值。
- `empty-response-retry` ACP 快照（一个人工编写的无密钥场景，配有确定性的 1 ms 零抖动重试 overlay，`examples/acp-agent/retry.cordis.yml`）钉住了产品可见的整个过程：持久的 `llm/retry` 事件、被丢弃尝试的标记，以及一次干净的已完成轮次。
