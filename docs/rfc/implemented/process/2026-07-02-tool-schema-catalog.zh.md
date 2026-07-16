# RFC：生成式工具 schema 目录（启动并采集）

Status: implemented

[English](2026-07-02-tool-schema-catalog.md) | 中文

## 问题

仓库此前没有一份统一的参考，列出实际暴露给模型的工具名称、描述与 JSON Schema。源码声明分散各处且在运行时组合，而既有的 Cordis 目录和数据结构目录覆盖的是接线与词汇，而非工具本身。

## 决策

通过**启动每个工具插件并读取其注册的 schema** 来生成目录，而非解析源码。`scripts/gen-tool-catalog.ts` 将每个已发布的工具包（package）挂载到一个全新的 Cordis `Context` 上（带 `SystemPrompt` + `ToolRegistry` 以及插件 `apply` 所读取的注入 seam），调用 `ctx.tools.schemas()`（即发送给模型的 `ToolSchema[]`），dispose 上下文，然后为每个包渲染一个 `## <package>` 小节，每个工具对应一个 ` ```json ` 的 `parameters` 块。它沿用 `gen-cordis-catalog` / `gen-module-graph` 的 CLI 形态：默认 `--write` 重新生成，`--check` 在已提交副本陈旧时失败，输出是确定性的（按 manifest 排序，工具按名称排序）。`verify-tool-catalog`（即 `--check`）运行在 doc-sync 内部，因此新鲜度门禁与其他文档门禁一样在 lefthook pre-push 和 CI 路径中触发。

### 为什么启动而非解析（核心论点）

Cordis 目录是纯 TypeScript AST 遍历，因为每个事件/服务名都是字符串字面量，能往返映射到静态声明——AST 就是全部事实。**工具 schema 不是静态可知的**，因此同样的技术会产出一份说谎的文档：

- `tool-todo` 写了 `enum: [...STATUSES]`——对一个运行时 `const` 的展开。AST 看到的是展开表达式，而非 `["pending","in_progress","completed"]`。
- 每段 description 都由字符串**拼接**构建（`'…' + '…'`）。AST 看到的是拼接节点，而非模型实际读到的最终文本。
- `tool-subagent` 的工具名是 `config.toolName ?? 'subagent'`——加载时选定，不是字面量。
- MCP 插件可以通过 `ctx.tools.register()` 直接注册**原始 JSON Schema**，完全不经过 `defineTool`，因此结构化枚举 `defineTool(` 调用点会漏计。

唯一忠实的真源是插件加载后注册表实际持有的 schema。启动即是[测试策略](../../../testing.md)中「验证世界，而非自我报告」这一原则在文档生成器上的应用：读取已发布的产物，而非对它的重新推导。

### 恢复「不会静默遗漏」

启动有一项 AST 遍历不具备的代价：没有源码声明集合可供枚举，因此新增的工具包可能被遗忘。一道**完整性守卫**恢复了这一保证——`assertManifestComplete` 对 `packages/` 下所有 `tool-*` 包做 glob，若有任何一个不在生成器的启动 manifest 中则硬报错。新增工具包会导致生成器失败，进而导致 doc-sync 失败，直到该包被注册。这与 Cordis 生成器通过枚举源码免费获得的结构性保证相同，只是为启动式生成器重新实现了一遍。

### 手工维护的启动 manifest 是不可约减的策略

文件系统负责发现工具包清单，完整性守卫负责拒绝遗漏。`TOOL_PACKAGES` 仍然为每个包持有一份显式的启动配方，因为所需的 seam 实现和配置是**策略**，不是能从目录布局或注入名称安全推断的事实。

### 范围

`packages/*/tool-*` 下已发布的产品级工具包，各以默认配置启动：`dsh-tool-bash`（`bash`、`bash_output`、`bash_kill`）、`dsh-tool-todo`（`todo_write`）、`dsh-tool-subagent`（`subagent`）。`examples/` 下的演示工具（`echo`）被排除，与 Cordis 目录的 packages-only 范围一致——演示工具不属于读者所要查阅的产品接口。

目录的单位是包，而非每个已配置的工具实例。每个包以默认配置启动一次；加载时的别名（如 `subagent_fork`）会注明，但不枚举每种部署排列。部署清单是一个独立的、无界的接口。

### 使用普通 `json` 围栏

schema 块使用 ` ```json `，而非自定义的 `ts` 系围栏。`doc-typecheck` 只提取 `ts*` 围栏，因此 JSON 块对它不可见——无需 `BlockKind` 接线（不同于 Cordis 目录的 `ts cordis-catalog` 围栏，后者必须加入白名单以避免裸签名片段被编译）。

## 曾考虑的替代方案

- **纯 TypeScript AST 遍历，如 Cordis 目录**：工具 schema 不是静态可知的（见上文核心论点）：运行时展开、字符串拼接、配置选定的名称，以及原始 `ctx.tools.register()` 注册，都会让 AST 推导出的文档说谎。
- **从各包的 inject 推断启动配方**：[发现包清单提案](../../proposed/process/2026-06-20-discover-package-inventory.md)所警告的「过于聪明」的路径；配方保持手写策略，清单由文件系统发现并受完整性守卫保护。
- **为 schema 块使用自定义 `ts` 系围栏**：不必要。普通 ` ```json ` 围栏对 `doc-typecheck` 不可见，无需 `BlockKind` 白名单。

## 后果

- 目录不会漂移：工具 schema 变更而已提交文件未反映时，`verify-tool-catalog` 在 pre-push 钩子和 CI 中失败。新增 `tool-*` 包未加入 manifest 时，完整性守卫直接报错。
- 工具描述文本只有一个归属地——源码中 `defineTool` 的 `description`——生成的条目质量完全取决于它，与 Cordis 目录对事件 JSDoc 施加的推动力相同。
- 生成器导入并执行工作区包（这是仓库中第一个这样做的脚本；其他脚本只读取文本）。它通过根 `tsconfig` 的 `paths` 映射在 `tsx` 下运行，走的是演示和测试所用的同一条未构建源码路径，因此不需要构建步骤。
- 未来某个工具背后新增能力 seam 时，意味着 manifest 中新增一条配方条目（需要挂载哪些 seam）。这是上文明确指出的手写代价；仅在新增工具包时才需变更。
