# RFC：裁剪不可达的 ACP bridge 接口——品牌旋钮与 kind 嗅探回退

Status: implemented

[English](2026-07-04-trim-acp-bridge-unreachable-surface.md) | 中文

## 问题

`dsh-acp` 有两处接口在任何已交付的配置下都不可达：

1. **`AcpConfig.agentName` / `agentVersion`**（`packages/ui/acp/src/index.ts`）。已交付的 app 包（package）只向 bridge 传入 `{ model }`（`packages/examples/acp-demo/src/index.ts`），因此唯一的生产配置面——叶子 `cordis.yml`——根本无法设置这两个旋钮；它们只能通过直接挂载 bridge 来设置，而只有单元测试这样做。所有快照 golden（包括 hook-matrix 场景）都固定了 schema 默认值（`deepseek-harness-acp` / `0.0.1`）。这对字段还带着一条活跃的 `TODO(double-default)`：字面量存在两份（schema 的 `.default(...)` 加 `??` 回退），TODO 要求选定一个归属。
2. **`toolKindFor` 名称启发式**（同一文件）在通用回退路径中对 `bash*`/`read*`/`write`/`edit*` 工具名做了特殊处理。自 [render-intent union](../architecture/2026-07-02-tool-render-intent-union.md) 以来，这些分支匹配到的每个第一方工具都自带 `presentCall` 并携带其 kind，而没有 presenter 的生产工具（`subagent`、`subagent_fork`）本来就落入 `other`。这些分支在生产中可达的唯一情况是：某个工具拒绝自行呈现其调用——`presentCall` 抛出异常（containment 回退），或模型参数未通过工具 schema 导致 `defineTool` 的 `presentCall` 包装层返回 `undefined`（例如 `bash` 调用缺少必需的 `description`）——而 bridge 自身的模块文档明确声明了该启发式所违反的设计规则：「bridge 从不对工具名做特殊处理」。

## 决策

在初始化时硬编码现有的握手标识 `{ name: 'deepseek-harness-acp', version: '0.0.1' }`，移除不可达的配置字段与重复默认值。在两处 presenter 回退中，将 `toolKindFor` 替换为中性的 `'other'`。正常的第一方呈现不受影响；格式错误或失败的呈现现在渲染一张诚实的通用卡片，而非从工具名推断 kind。初始化测试和快照固定握手标识；只有 `hook-codex-posttool-block` 中格式错误的调用改变了回退卡片的 kind。

## 曾考虑的替代方案

### 为什么不保留？

品牌旋钮可以在 app 包将其暴露给部署时回归。从未知工具名推断呈现方式违反了 render-intent 契约；中性回退卡片还能为格式错误的调用和损坏的 presenter 保留原始输入。

## 后果

除上述回退渲染的取舍外无其他影响——退化路径下，中性卡片比推断出的第一方卡片更易于诊断。
