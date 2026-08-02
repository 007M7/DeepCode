# Agent Note: 拒绝委托子代理调用 ask_user_question

Status: implemented

[English](2026-08-01-ask-user-delegated-caller-guard.md) | 中文

## 问题

委托子代理调用 `ask_user_question` 工具时会无限阻塞。该工具会暂停等待人类回答，但子代理上下文中没有人类应答者，因此永远等不到回答，子代理运行只能被外部取消。

## 决策

`UserInteractionService.ask()` 拒绝任何调用方为委托子代理的请求 —— `request.agent.session.header.delegationDepth > 0` —— 抛出新的 `UserInteractionError`，代码为 `DELEGATED_CALLER`，消息为 `ask_user_question is unavailable to delegated subagents; delegate the question to the top-level agent`。该检查位于 `ask()` 开头，在已中止/空问题守卫之后、意图校验之前，因此被拒绝的子代理不会触发任何提供方交互。这与 goal 工具仅限顶层代理的权限保持一致（`create_goal` 以直接人工回合要求拒绝非顶层代理）。

## 备选方案

**让子代理一直阻塞，直到父代理转发回答。** 不予采用：子代理上下文中不存在应答者，也没有任何转发 seam；实际观察到的行为就是永久挂起。

**在工具（`dsh-tool-ask-user`）而非服务中拒绝。** 不予采用：直接调用 `ctx.userInteraction.ask()` 的调用方会绕过该消费方 seam；拥有此决策权的操作边界是服务本身。

**通过模型侧描述来警告子代理。** 不予采用：拒绝本身已是响亮且自解释的错误，而且修改描述并不能阻止仍然去调用的模型造成挂起。

## 影响

委托子代理的调用会以稳定错误快速失败，而不是挂起；需要决策的子代理必须把问题转交给顶层代理。不带 agent 的程序化调用方以及顶层代理（`delegationDepth` 缺省或为 0）不受影响，仍会到达提供方。`DELEGATED_CALLER` 代码已加入包 README 中记载的 `UserInteractionError` 分类，模型侧描述保持不变。

## Testing

两个新的单元测试覆盖该守卫：`user-interaction.spec.ts` 断言以 `{ meta: { delegationDepth: 1 } }` 创建的会话调用 `ask()` 会以 `DELEGATED_CALLER` 拒绝且绝不调用提供方，并补充了 `delegationDepth: 0` 的正向对照；`tool-ask-user.spec.ts` 断言委托子代理发出的工具调用会呈现结构化错误且绝不触达提供方。两个包均通过，父级 `packages/ui` 作用域也通过，且两个被改动的 `src` 文件保持 100% 逐文件覆盖率。
