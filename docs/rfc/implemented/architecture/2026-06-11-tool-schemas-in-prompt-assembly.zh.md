# RFC：工具 schema 属于系统提示词组装的一部分

Status: implemented

[English](2026-06-11-tool-schemas-in-prompt-assembly.md) | 中文

## 问题

在协议格式（wire format）层面，工具 schema 通过模型请求中专用的 `tools` 字段传输，而非嵌入提示词文本。但从架构角度看，「模型被告知它能做什么」是一个内聚的关注点：提示词段落和工具列表由同一批插件贡献组装而成，并在同一时刻被消费。

## 决策

`PromptAssembly { sections, tools }`：系统提示词服务同时收集有序的文本段落和工具 schema（工具注册表自动贡献一个提供方）。agent loop（智能体循环）每步消费一个 assembly；适配器将 `sections` 映射到提供方的 system 槽位，将 `tools` 映射到协议格式的 `tools` 字段。因此 `system-prompt/assemble` waterfall（瀑布式事件）是模型前置信息的唯一拦截点——工具过滤（ToolSearch / 渐进式披露）是一次 assembly 改写，与提示词编辑无异。

## 曾考虑的替代方案

**循环分别向工具注册表和提示词服务查询**——将一个内聚的关注点拆到两个 seam 上；任何想塑造「模型被告知什么」的拦截（工具过滤、plan 模式）都需要在两个接口上各挂一个监听器，而非一次 assembly 改写。

## 后果

- 一条 waterfall 统管模型的常驻上下文；plan 模式等插件可以在一个监听器中同时替换提示词文本和可见工具。
- assembly 接口通过声明合并实现可扩展（无需无类型的 `extras` 包——扩展即声明合并）。
- 「schema 出现在提示词服务中」有轻微的概念意外感，本文与 package README 对此做了说明。
