# RFC：移除无消费方的 skill 提供方事件

Status: implemented

[English](2026-07-12-drop-unconsumed-skill-provider-events.md) | 中文

## 问题

skill（技能）注册表产出了两个通知事件，但在生产代码中没有任何监听方。生成的生产者/消费方矩阵以及精确的事件名搜索表明，`skill/provider-added` 和 `skill/provider-removed` 只出现在声明、发射点、测试、生成目录和行文中。

skill 发现按需读取当前提供方映射表，提供方注册同步清除已完成的目录缓存，await 后的修订检查防止陈旧的发现结果进入缓存。没有兄弟插件通过这些事件等待 skill 提供方，不同于 `subagent/provider-added` 的实际消费方（它容忍兄弟并发加载）。

`tools/change` 和 `system-prompt/change` 明确不在本提案范围内。既有的简化决策将它们保留为面向实时工具和提示词 UI 的有意观测点，且自引用的已挂载插件已在使用 `tools/change`。本提案同样不改动 `subagent/provider-added`/`removed`，因为 `tool-subagent` 有生产级的生命周期消费方。

## 决策

skill 注册表不再声明和发射提供方成员变更事件。提供方的注册与 dispose（资源释放）仍为 effect 拥有的直接状态变更，同步使已完成的目录缓存失效；查找与发现按需读取当前提供方映射表。测试通过提供方查找和收集的输出来观察清理行为，而非生命周期通知。

生成的事件目录、API 目录与生产者/消费方矩阵不再包含已删除的通知。skill 系统 RFC 和包文档通过 effect 拥有的直接状态及缓存失效契约来描述注册行为。

## 曾考虑的替代方案

**为未来插件保留 skill 提供方通知。** 第三方插件可能想观察提供方的可用性，但直接提供方注册与按需查找才是扩展契约；当前没有消费方需要推送信号。如果未来出现兄弟加载竞态，可以像 subagent 注册表那样引入一个带有该消费方实际所需的身份与就绪语义的通知。

## 后果

生成的事件矩阵中不再有 `skill/provider-added` 或 `skill/provider-removed` 的行。skill 发现、直接运行时注册、提供方 effect 回滚/dispose、缓存失效与注册表查找清理均保留；随事件一起消失的是监听器触发的回滚。`tools/change`、`system-prompt/change` 以及已被消费的 subagent 提供方生命周期事件不受影响。

预发布消费方失去 skill 提供方观测点，但仍保留贡献 skill 的两种方式：直接运行时注册与提供方注册。未来若有消费方需要实时的提供方可用性信息，须新增一个带有其实际所需的身份与就绪语义的专用通知。
