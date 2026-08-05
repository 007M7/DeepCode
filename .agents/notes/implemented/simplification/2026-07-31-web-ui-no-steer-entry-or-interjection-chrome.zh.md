# Agent Note: Web UI 去掉 steer 入口与插话 chrome

Status: implemented

[English](2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md) | 中文

## 问题

中途 steering 是 host／agent-loop 能力（`mode:'steer'`、持久 `steering/message`）。Web 产品已在 turn 运行中锁定 composer，且从未交付排队／steer 菜单，但客户端仍把 `'queue' | 'steer'` 穿进 input machine、`conversation.send` 与 locale 键，并把已消费的 steering 渲染成带「插话」／「Interjection」徽章的气泡。这留下半成品 UI：用不到的提交 mode、用户做不到的手势却有产品文案，以及把产品并不拥有的 chrome 钉死在 e2e golden 上。

## 决策

保留 host 与 runtime 的 steering。只去掉 Web UI 入口与 chrome：

- `InputMachine`／`SessionInput`／`InputActions.submit`／hub `defaultSink` 仅 queue；始终调用 `session.prompt(..., 'queue')`。
- `ConversationService.send(text)` 去掉 mode 参数，始终排队。
- `MessageItem` 的 `steering` 分支仍把持久 `steering/message` 内容折成右对齐普通气泡（无徽章、无用户 IconActions），以便外部／host steer 在回放时仍可见。
- 删除 `message.steering` locale 字符串与未使用的徽章 CSS。
- web steering e2e 仍通过 `/api/session.prompt` POST `mode:'steer'`，并断言持久化与模型可见服从；不再期望插话 chrome。同步更新 [web input machine note](../architecture/2026-07-25-web-input-machine-and-slash-pipeline.md) 中的事实行。

## 曾考虑的替代方案

**整段删除 host steering。** 超出范围；用户只要求清 Web UI 展示与入口。agent-loop 排空、session 事件与线缆 mode 对 ACP／TUI／自动化仍是承重能力。

**在 transcript 中隐藏 `steering/message`。** 外部客户端 steer 时回放会撒谎；改为普通气泡。

**保留 mode 参数但永远只传 `'queue'`。** 留下死 API 面与只会虚构 composer 到不了的 `'steer'` 路径的测试。

## 后果

- **部分被取代。** Decision 中所有关于 steer **入口**、`queue`／`steer` mode 联合类型、插话标注、其 locale 字符串、以及钉住这些「不存在」的黄金基线的子句，均已不再描述 master——即第 1 条与第 3 至 5 条。composer steering 在此之后落地，随后[上下文来源与 steer 标识决策](../feature/2026-08-04-web-context-source-and-steer-marks.md)提供了本 note 重新引入条款所要求的产品决策，并成为该标注的归属者。下面的后果与测试陈述的是当前事实。
- host 侧 steering 的归属未变：agent-loop 排空、session 事件与线缆 mode 对 ACP、自动化以及任何非 Web 客户端仍是承重能力。
- `ConversationService.send(text)` 仍然不接 mode、始终排队；composer 的 Steer 手势改走 `session.prompt(mode: 'steer')`。
- `steering/message` 仍然折叠进持久 transcript，因此从外部提交的 steer 在回放时依旧如实；只是它现在带上了插话标注，而不再是一个无标识的气泡。

## 测试

- `packages/client/ui-conversation` unit／jsdom 覆盖：input machine enter／sink、ConversationService 路由、MessageItem 的 steering 分支、InputBar submit。
- `apps/web/tests/steering.e2e.ts` 无密钥回放及其黄金基线，后者现在钉住该标注。
