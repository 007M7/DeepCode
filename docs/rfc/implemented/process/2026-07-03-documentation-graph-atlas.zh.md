# RFC：面向维护者和 SDK 用户的文档关系图索引

Status: implemented

[English](2026-07-03-documentation-graph-atlas.md) | 中文

## 问题

仓库此前已有若干高可信度的文档面，各自覆盖不同维度：[module-graph.md](../../../module-graph.md) 由 package 的 `peerDependencies` 生成；生成的 [Cordis 事件目录](../../../cordis-catalog/events.md)和[服务目录](../../../cordis-catalog/services.md)由 Cordis 的 `Events` 与 `Context` 声明生成；[tool-catalog.md](../../../tool-catalog.md) 通过启动已发布的工具插件生成；[core-data-structures/](../../../core-data-structures/core.md) 使用 `ts type-equiv` 块保持粘贴的类型定义与源码同步。

这些参考资料是准确的，但它们大多是目录。维护者仍需自行综合关系：哪些 package 构成一条能力 seam、哪个应用捆绑了具体的主干、哪个事件是持久的而哪个是实时的、钩子或策略插件可以在哪里拦截工作、以及哪个面向模型的工具依赖哪个服务。SDK 用户从另一个角度面临同样的问题：「我想要某种行为，该安装或加载哪个 package？该扩展哪个事件/服务/工具？」

钩子子系统使事件的生产者/消费者拓扑与拦截点变得更加重要；文件系统 seam 使能力 seam、策略否决、工具呈现和 SDK 组装路径变得更加重要。如果关系图仅限于一个小的 bash/todo/subagent 表面，它们会立刻陈旧。

## 决策

新增生成的关系图文档，索引位于 [docs/graph-atlas.md](../../../graph-atlas.md)，由专门的生成器产出，并由 `pnpm run verify-doc-graphs` 及既有的目录新鲜度检查（作为 `doc-sync` 的一环）进行验证。

该索引是既有目录之上的关系层。它不替代精确的参考资料，而是链接到它们并解释各部分如何组合在一起。

### 维护模式

每个关系图页面声明一种维护模式：

- **生成（Generated）**：所有节点和边均从源码发现；如果已提交的产物陈旧，`--check` 失败。
- **混合生成（Hybrid generated）**：源码发现清单，一份小型 manifest 对不可约的策略进行分类，完整性守卫在发现的条目未被分类时失败。
- **人工维护（Curated）**：图表解释设计意图、时序或归属；它由生成器输出以保证关系图文档作为一个可重新生成的整体，但内容是有意撰写的。

### 首批交付的索引

首批索引链接十个关系面。package 拓扑与工具-package 能力映射位于既有的生成目录中（这些目录已拥有相应事实）；其余的专项图表由 `scripts/gen-doc-graphs.ts` 生成。

| 关系图 | 维护模式 | 真源 |
|---|---|---|
| [模块依赖图](../../../module-graph.md) | 生成 | `packages/*/*/package.json` 的 peer dependencies 加 package 分组路径 |
| [工具 schema 目录与 package 映射](../../../tool-catalog.md) | 生成 | 启动采集的工具 schema 加工具-package 的服务/副作用元数据 |
| [能力 seam 与核心服务](../../../capability-seams.md) | 混合生成 | Cordis 服务声明加 `gen-doc-graphs.ts` 中的角色 manifest |
| [echo-agent 应用组合](../../../../examples/echo-agent/composition.md) | 混合生成 | `examples/echo-agent/cordis.yml` 插件列表加人工维护的应用/bundle 展开 |
| [coding-agent 应用组合](../../../../examples/coding-agent/composition.md) | 混合生成 | `examples/coding-agent/cordis.yml` 插件列表加人工维护的应用/bundle 展开 |
| [acp-agent 应用组合](../../../../examples/acp-agent/composition.md) | 混合生成 | `examples/acp-agent/cordis.yml` 插件列表加人工维护的应用/bundle 展开 |
| [事件生产者/消费者矩阵](../../../event-producer-consumer.md) | 混合生成 | Cordis 事件声明、AST 扫描的 `ctx.on/emit/parallel/serial/waterfall` 调用点，以及显式的动态分发覆盖 |
| [agent 轮次与步骤生命周期](../../../agent-lifecycle.md) | 人工维护 | architecture.md 的循环生命周期、Cordis 目录链接与会话事件语义 |
| [工具执行流水线](../../../tool-execution-pipeline.md) | 人工维护 | 工具流水线语义与 `tools/execute` waterfall（瀑布式事件） |
| [ACP 快照回放](../../../../packages/ui/acp/snapshot-replay.md) | 人工维护 | 快照 harness 行为 |

### 为什么由生成器拥有这些文档

package 拓扑留在 `gen-module-graph.ts`，工具-package 能力映射留在 `gen-tool-catalog.ts`，因为这些生成器已经拥有权威事实和新鲜度门禁。`gen-doc-graphs.ts` 拥有其余关系页面和索引。代价是人工维护的图表需要在 TypeScript 字符串块中编辑，而非直接编辑 Markdown。对首批交付而言这是可接受的，因为面向用户的产物仍是纯 Markdown/Mermaid；如果撰写体验比可重新生成更重要，未来可以将人工维护的页面拆分出来。

### 完整性守卫

混合生成的页面在其 manifest 陈旧时必须显式失败：

- 模块图读取每个 package 的 `peerDependencies`，并按 `packages/<group>/<pkg>` 路径对 package 分组。
- 工具目录通过启动采集已发布的工具，并从同一份 manifest（其完整性守卫已在检查）渲染 package/服务/副作用映射。
- 能力 seam 图导入 Cordis 服务收集器，断言每个被发现的 harness `ctx.<key>` 都已在 `SERVICE_ROLES` 中分类，且每个已分类的 key 仍然存在。
- 事件生产者/消费者矩阵标记为混合生成，因为 subagent 生命周期事件有意使用 `ctx.events.dispatch` 实现逐监听器隔离；这些动态边是显式覆盖而非无声遗漏。
- `verify-mermaid` 用 Mermaid 自身的解析器解析仓库中每个 ` ```mermaid ` 围栏，因此语法错误会在本地和 CI 的 `doc-sync` 中失败，而不是在 GitHub 渲染时才显示为损坏的图表。

## 曾考虑的替代方案

已提交的图表使用 Mermaid，因为 GitHub 在 Markdown 中原生渲染它，且不引入新的文档构建依赖；密集的多对多数据（如事件生产者/消费者关系）则使用 Markdown 表格。**PlantUML、托管图表服务和生成的 SVG** 曾被考虑，但在 Mermaid 成为瓶颈之前有意不采用。

## 后果

- 维护者获得了拓扑、seam、事件流、生命周期、应用组合和快照行为的可视化入口。
- SDK 用户获得了从用例到 package 组合的路径，而不仅仅是自底向上的 package 参考。
- `doc-sync` 现在包含 `verify-doc-graphs` 和 `verify-mermaid`，因此关系图漂移和 Mermaid 语法错误与其他文档新鲜度门禁一同被捕获。
- 未来的文件系统和钩子工作有了承载新复杂度的具体位置：文件系统应扩展能力文档和工具目录，钩子应扩展事件矩阵和工具执行流水线。
