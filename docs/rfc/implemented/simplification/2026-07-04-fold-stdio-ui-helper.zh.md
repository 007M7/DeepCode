# RFC：将 stdio UI 辅助模块折入 stdio 应用

Status: implemented

[English](2026-07-04-fold-stdio-ui-helper.md) | 中文

## 问题

readline UI 曾是一个完整的包（`@deepseek-ai/dsh-ui-stdio`，位于 `packages/support/`），其唯一的运行时导入方是应用包 `@deepseek-ai/dsh-stdio-demo`。示例通过加载该应用来使用 readline UI，从不自行组合这个辅助模块；仓库中所有其他引用都是因为包边界存在而存在的机械性或描述性表面：manifest 与 tsconfig 条目、生成的 module-graph 行、依赖图与 README 行，以及命名该包的文档注释。ui 分组 README 记录了 support 放置的理由（"主要为示例和覆盖率门禁而存在——`ui/` 保留给作为产品交付的界面"），这留下了一个持续的张力：一个已交付的产品应用依赖一个被文档标注为非产品表面的 support 包。

这条边界带来的是包元数据、workspace 与 tsconfig 引用、module-graph 行、README 条目，以及 publint 表面——服务于一个并不可独立替换的辅助模块：stdio 应用的前门集群总是包含 readline UI，且没有其他东西能有意义地消费它。

## 决策

该辅助模块以终端通道插件的形式存在于 `@deepseek-ai/dsh-stdio` 中（`packages/ui/stdio/src/index.ts`）：`createStdioChat`、其 `StdioRuntime` 测试 seam 及单元测试（`packages/ui/stdio/tests/stdio.spec.ts`、`readline.spec.ts`）一并迁入，因此 EOF 处理、渲染、dispose（资源释放）以及 piped-vs-TTY 行为在按文件覆盖率门禁下仍有单元测试覆盖，且无需劫持进程全局对象。该模块保持具名的 `name`/`inject`/`Config`/`apply` 导出形状——即应用通过 `ctx.plugin(uiStdio, …)` 挂载时消费的契约——而 `examples/echo-agent` 与 `examples/coding-agent` 中的 keyless Loader 路径冒烟测试继续证明组合树能通过真实 Loader 启动（stdio 包的插件形状单元测试套件固定了显式的 `unwrapExports` 断言，因为缺少 `inject` 的 bundle 会跳过一个意外的 default 导出而非崩溃）。

`packages/support/ui-stdio` 包已删除：manifest、tsconfig 引用、module-graph 行与 README 行均已清理；原先命名该包的文档注释（示例 e2e 模块文档、`packages/README.md`、support 与 todo README、[ui 分组 README](../../../../packages/ui/README.md)）现在描述的是包内模块。

## 曾考虑的替代方案

### 为什么不将其提升到 `ui/`？

提升可以解决 support 与产品之间的错位，同时保留包边界——但只有在 readline UI 是一个可独立替换的集成或拥有第二个组合方时才是正确选择，而消费方普查表明两者都不成立。结构化的 ACP 桥接保持独立包，因为它是产品协议表面，拥有自己的契约和快照层级；readline 辅助模块只是一个应用前门的脚手架。在正式发布前重新拆出的成本很低：如果未来有第二个产品应用需要 readline UI，届时再拆出，由那个消费方来塑造包契约。

## 后果

- stdio 应用完整拥有自己的前门；一个叶子 `cordis.yml` 仍然只加载一个应用包，演示的形状没有变化。
- 未来如果有独立的终端 UI 需要将该辅助模块作为包使用，届时由那个第二消费方驱动重新引入，而非仓库为假设性的复用保留一条边界。
