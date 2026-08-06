# Agent Note: Web UI 去掉 steer 入口与插话 chrome

Status: implemented

[English](2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md) | 中文

## 问题

中途 steering 是 host／agent-loop 能力（`mode:'steer'`、持久 `user/message`）。Web 产品已在 turn 运行中锁定 composer，且从未交付排队／steer 菜单，但客户端仍把 `'queue' | 'steer'` 穿进 input machine、`conversation.send` 与 locale 键，并把已消费的 steering 渲染成带「插话」／「Interjection」徽章的气泡。这留下半成品 UI：用不到的提交 mode、用户做不到的手势却有产品文案，以及把产品并不拥有的 chrome 钉死在 e2e golden 上。

## 决策

保留 host 与 runtime 的 steering。只去掉 Web UI 入口与 chrome：

- `InputMachine`／`SessionInput`／`InputActions.submit`／hub `defaultSink` 仅 queue；始终调用 `session.prompt(..., 'queue')`。
- `ConversationService.send(text)` 去掉 mode 参数，始终排队。
- 持久 steer 内容渲染为右对齐普通气泡（无徽章、无用户 IconActions），以便外部／host steer 在回放时仍可见。
- 删除 `message.steering` locale 字符串与未使用的徽章 CSS。
- web steering e2e 仍通过 `/api/session.prompt` POST `mode:'steer'`，并断言持久化与模型可见服从；不再期望插话 chrome。同步更新 [web input machine note](../architecture/2026-07-25-web-input-machine-and-slash-pipeline.md) 中的事实行。

## 曾考虑的替代方案

**整段删除 host steering。** 超出范围；用户只要求清 Web UI 展示与入口。agent-loop 排空、session 事件与线缆 mode 对 ACP／TUI／自动化仍是承重能力。

**在 transcript 中隐藏 `steering/message`。** 外部客户端 steer 时回放会撒谎；改为普通气泡。

**保留 mode 参数但永远只传 `'queue'`。** 留下死 API 面与只会虚构 composer 到不了的 `'steer'` 路径的测试。

## 后果

- Web 用户无法从 composer 或 `ctx.conversation.send` steer；中途控制只剩停止／取消与 Queue。
- Host 线缆与非 Web 客户端仍可 steer；Web 客户端展示这些消息时不再标成插话。
- 非用户来源的 next-step 项（`agent.inject` 上下文：审批通知、任务完成、附加快照）以 `context` placement 广播，绝不渲染为待处理 steering 气泡；领取为持久 `user/message` context card 前保持不可见。
- 若要重新引入专用 steer UI，需要新的产品决策；没有决策就不要复活 mode 联合类型或徽章。

## 测试

- `packages/client/ui-conversation` unit／jsdom 覆盖：input machine enter／sink、ConversationService 路由、MessageItem steering 分支（无「插话」）、InputBar submit。
- `apps/web/tests/steering.e2e.ts` 无密钥回放，以及更新后的 `settled.expected.md`（有 steer 正文、无徽章）。
- `packages/host/apiproxy` 的 `session/queue` 投影测试断言用户来源的 next-step 项保持 `steering`，而插件来源的项落入 `context`。
