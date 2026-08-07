# Agent Note: toolview 溶解——工具行即 per-view keyed slot

Status: implemented

[English](2026-07-23-toolview-dissolution.md) | 中文

> 范围：独立工具环（ToolViewRegistry/ctx.toolviews/outlet）为何退役、被什么取代。本决策产出的落地态叙述归 [Web 客户端架构注](2026-07-19-gui-web-client-architecture.md)；一切现在所运行其上的注册模型归 [slot 体系标准](2026-07-22-slot-type-chain-implementation.md) 所有。

## Problem

视图环溶解进 slot 体系之后，client 侧恰好还剩一套平行注册模型：工具环——一个具名注册表（`ctx.toolviews`），带自己的 register 文法、自己的 resolve 语义（scoped 压 global 的谓词分发）、自己的 subscribe/version 对、自己的 inject 缓存、自己带私有错误边界的渲染出口。其中每一件都是 slot 机器已经拥有之物的第二份实现，而每一项未来能力（行草稿的 store 席位、i18n 注入、跨 bundle 身份）都将不得不建两遍或漂移。这条环唯一像样的存在理由是：tool 名是运行时开放集，而 `SlotMap` 是封闭声明表——以任意字符串为键的注册表看似结构上必需。

## Decision

工具环作为独立基础设施已消失：工具行是**各视图为自己声明的 keyed 子槽**，client 全域只剩一种注册模型。上述理由是空的——keyed slot 的 *key 空间*本就运行时开放（SlotMap 声明槽、从不声明 key；ask-user composer 的 `key: 'question'` 即先例），开放的 tool 名集合天然适配 `entryKey` 分发。

落地形态（现状叙述同见[架构注](2026-07-19-gui-web-client-architecture.md)）：chat 条目的 `children` 表声明 `'conversation.chat.toolview'`（keyed/session）；渲染点逐行以 `entryKey: toolName` 分发、以 `GenericToolCard` 作调用点 `fallback`（默认卡片是域产权；fallback 选项就是普通 renderSlot 文法）。owner 载荷是统一的 `ToolRowOwnerProps`（`callId`/`toolName`/`block`/`openDetails`——details 是会话级设施，非 chat 私货），`ToolRowProps` 把它与 session 标配 kit 预组合供注册方组件取用。注册方是使用 `ctx.slots.inject('conversation.chat.toolview', () => ctx.slots.register({ name: 'conversation.chat.toolview', key: '<tool>', inject? }, Row))` 的普通插件；声明本身控制激活与替换，不再引入虚假的 `ConversationService` 依赖（[决策](2026-08-05-slot-declaration-injection.md)）。bash 样例即第三方姿态的样板，并与 Think 绘制同一套 ToolRow chrome（`Bash · {description}`）。trajectory/waterfall 的 toolview 槽共用这套形状（槽名按槽名纪律 `<域>.<条目>.<孔位>` 定死，共用一张 owner 类型），随各自的行渲染点落地——RendersCheck 拒绝无人渲染的声明，挡住提前空声明的是类型系统而非约定。

registry 时代的职责各有后继居所：inject 缓存与行错误隔离乘框架渲染器（entry×scope 缓存、per-entry `SlotErrorBoundary`）；subscribe/getVersion 乘 slot core 的 per-key 版本机；将来的「store 席位」就是 keyed slot 本就拥有的普通 store 席位（交互草稿耐久性是其首个具名消费者）；miss 兜底即调用点 `fallback` 选项。

## 接受的语义变化

四项行为增量是刻意接受而非疏漏。跨视图出场=逐视图注册——行本须适配各视图版式，一视图一注册是正确耦合，复用即同一组件写两次 register。同 key 重复注册从注册表的 later-wins 静默覆盖变为 loud throw——纪律修正而非损失。会话维分发若行需要，归组件内部（标配 kit 已带 `useSessions`），不走注册表谓词——今天没有已落地的会话变体样例。第三方在 registry 级覆盖形态（scoped 注册压过 global）不复存在；真出现的未来需求走 key 命名空间约定或组件内小 resolver，永不复活平行注册表。

## Alternatives considered

**保留独立注册表（原形态）。** 拒绝：其多维分发的每一维都有更正确的家——视图维归各视图自己声明的子槽（declaring is claiming，特化面权属自然落对），会话维归已持有标配 kit 的组件内部。两步移完后剩下的只是一份没有任何独有能力的 slot 机器副本。

**把 `renderToolView` 提进标配 kit、注册表迁入 runtime 包。** 拒绝：「工具行」是 conversation 域概念；上提进 runtime 会把域词汇泄漏进框架层，且依然留着两套注册模型。

**以订阅 refCount 推导槽声明**（首个注册方订阅时隐式声明槽）。拒绝：隐式耦合加去抖复杂度；记为将来真出现多观看面时的备选。

**slots.register 之上的薄 `registerToolView` 门面。** 缓建而非拒绝：溶解后该门面只剩编译期三糖（槽名字面量收窄、tool→key 词汇翻译、props 预组合），运行时为零。按「enforce at the operation boundary」（门面不是强制点）与「don't split preemptively」（今天注册方人口只有一个 bash 样例）保持不建；类型糖以导出的 `ToolRowProps` 别名兑现。后悔药条款：注册方长到三五家或出现批量注册模式时，门面十行可补，不扰直注。

## Consequences

client 只有一种注册模型；审计谁渲染工具行 = 读 register 调用，与其他所有 slot 同一套审计。注册方免费获得框架的错误隔离、inject 缓存与 store 席位——没有能力要建两遍。代价即上文接受的语义变化（主要是：跨视图行要逐视图注册、第三方无 registry 级覆盖）。独立注册方在 `ctx.slots.inject` 中点名有类型约束的 slot，因此依赖关系既显式，又能跟随声明替换，无需服务顺序约定。
