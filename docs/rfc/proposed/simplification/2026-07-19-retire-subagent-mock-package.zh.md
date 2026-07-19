# RFC: 撤销独立的 subagent mock 包

Status: proposed

[English](2026-07-19-retire-subagent-mock-package.md) | 中文

## 问题

`@deepseek-ai/dsh-subagent-mock` 是一个以工作区插件形式发布的可配置测试替身。它仅有两个外部消费方：`tool-subagent` 单元测试和工具目录生成器。运行时包、示例、快照配置和真实提供方都不会加载它。

这个用途狭窄的 fixture（测试前置数据）需要维护 manifest（元数据清单）、导出、对等依赖（peer dependency）与开发依赖、项目引用、包（package）README 契约、Loader 组合测试、模块图成员关系以及文档门禁例外。工具目录生成器挂载它，只是为了让真实 subagent 工具注册 schema；生成器从不执行子 agent。

## 提案

删除 `packages/support/subagent-mock`。把 `tool-subagent` 实际使用的脚本化提供方行为移入该包的本地测试 fixture，同时继续测试真实的 `SubagentService`、提供方注册表和工具实现。

工具目录生成器在挂载 `ToolSubagent` 前，只注册所需的最小提供方描述。删除该包的项目引用、manifest 依赖、图节点、README 允许列表和 mock 专用 Loader 测试。

## 备选方案

**为未来测试保留可复用 mock 包。** 除一个测试文件和一个生成器外，复用需求并未出现。未来产生第二个消费方时，可以在共享契约明确后再提取 fixture；当前把所有可配置回复、取消、结果与 Loader 行为打包，会使测试基础设施看起来像受支持的后端。

**不挂载真实工具，直接生成 subagent schema。** 手工构造或直接导入 schema，会削弱目录生成器对生产注册表与工具组合是否公开文档结构的校验。生成器应继续挂载真实服务与工具，只替换不确定的子 agent 边界。

## 验收标准

- 删除 `packages/support/subagent-mock`，并移除其全部工作区、图、依赖和文档条目。
- `tool-subagent` 测试保留当前通过真实服务与工具覆盖的全部脚本化回复、结构化结果、取消、前台与后台运行以及任务集成用例。
- 工具目录生成器使用最小本地提供方挂载生产 subagent 注册表与工具，并生成字节级一致的目录。
- 运行时包与示例包都不会新增对测试专用 fixture 的依赖。
- 聚焦 subagent 测试、目录与图生成、模块图校验、构建、hygiene 和完整 pre-push 门禁全部通过。

## 风险

迁移 fixture 时，可能会误将过多生产组合替换成测试替身。本地 fixture 只能实现不确定的 subagent 边界；能力检查、生命周期、任务处理与工具输出仍由生产代码负责。由于之后不再有部署组合消费该包，可以删除 mock 的 Loader 与 HMR 覆盖。
