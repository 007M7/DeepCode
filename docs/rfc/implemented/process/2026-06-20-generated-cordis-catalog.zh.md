# RFC：生成式 Cordis 事件 + 服务目录

Status: implemented

[English](2026-06-20-generated-cordis-catalog.md) | 中文

## 问题

插件作者需要两个参考面，而此前没有任何单一文档能提供：他们可以监听的每一个 Cordis **事件**（含精确签名与分发模式），以及他们可以调用的每一个 `ctx.<key>` **服务**（含精确接口）。相关信息已经存在，但散落各处：`docs/architecture.md` 中一张手工维护的事件分类*表格*（名称 + 行文描述的 Mode/Purpose，由 `verify-event-taxonomy` 做名称集合校验）、一张服务映射表（8 行角色描述），以及 `interface Events` / `interface Context` 声明本身。分类表还有一个盲区：它无法捕获全新的*未记录*事件——名称集合校验器只检查两侧已有的名称。

这是[核心数据结构目录](../../../core-data-structures/core.md)（[对应 RFC](2026-06-20-core-data-structures-catalog.md)）在连线轴上的互补件：那份目录记录 agent loop 流转的*数据结构*（经校验的手工粘贴）；本目录记录流转它们的*事件与服务*。

## 决策

从源码生成目录，而非手工维护表格再校验子集。

`scripts/gen-cordis-catalog.ts` 使用 TypeScript 编译器 API，从声明和源码 JSDoc 分别输出事件参考与服务参考。事件包含分发模式；服务包含公开签名。确定性的 `--write` 与 `--check` 模式使两个页面成为生成产物，新鲜度由 doc-sync 强制。

纯生成在这里是正确的，因为代码库足够规范，AST 即全部真相：每个事件/服务名称都是字符串字面量，能往返映射到一个静态声明——没有动态命名的事件，也没有仅运行时存在的服务。因此生成的文档不可能出错，并且从结构上消除了未记录事件的缺口（生成器枚举源码，而非检查手写子集）。

具体选择：

- **`@mode` 标签，交叉校验。** 每个 harness 事件的 JSDoc 携带显式的 `@mode emit|waterfall|parallel|serial` 标签；缺少标签时生成器直接报错。当签名形状具有结论性时——尾部参数为 `next: () => …` 在结构上即为 waterfall——生成器断言标签与之一致，矛盾时直接报错。emit/parallel/serial 的区分在结构上不可见（`session/flush` 返回 `Promise<void> | void` 且无 `next`，有序的 `agent/pre-step` 检查点亦然），因此信任标签。撰写规则见 [AGENTS.md](../../../../AGENTS.md)。
- **分层范围。** harness 层（8 个 `@deepseek-ai/dsh-*` 服务及其事件）从源码完整渲染。继承层（cordis-core 的 `ctx.on/emit/effect/provide/…` + `internal/*` 事件 + loader/HMR/timer）是插件同样可见的固定 vendor 源；它以精简形式渲染（名称 + 一行说明 + 源码指针），数据来自生成器中的一张手工策展表，而**不是**遍历 vendor AST——cordis-core 的 `Context` 混合了真正的 ctx 成员与非服务字段（`root`、`baseUrl`、`logger`），且 vendor 表面仅在有意的 vendor 同步时才变化。
- **交叉链接到数据结构目录。** 签名中出现的类型名（`GenerateOptions`、`StreamChunk`、`ToolDefinition` 等）链接到记录该类型的核心数据结构页面。映射是生成器中一个小型手工策展的 const，而**不是** `type-equiv.manifest.json`——后者记录的是 `…Map` 符号，而签名引用的是派生联合类型名，且有少数符号出现在两个页面上。
- **专用围栏。** 签名块使用 ` ```ts cordis-catalog ` 信息字符串，`doc-typecheck` 识别并跳过它（裸签名片段不能独立编译），不计入 opt-out 比例——与 `type-equiv` 块的处理方式相同。

本决策**取代** [doc-sync 强制](2026-06-11-doc-sync-enforcement.md)中的事件分类部分：`verify-event-taxonomy` 及其 `docs/architecture.md` 表格退役（architecture.md 的标题保留，正文改为指向目录；服务映射角色表作为策展行文保留）。doc-typecheck、verify-md-wrap、verify-md-links 与 verify-type-equiv 不受影响。

## 曾考虑的替代方案

- **校验而非生成（退役的分类检查所做的事）**：*仅对此表面*反转了方向。这里的数据可以机械地完整获取，因此生成严格强于名称集合校验（完整签名、不会漂移、能捕获未记录事件）。
- **遍历 vendor AST 以获取继承层**：否决，改用策展表。cordis-core 的 `Context` 混合了真正的 ctx 成员与非服务字段，且固定的 vendor 表面仅在有意同步时才变化。
- **复用 `type-equiv.manifest.json` 作为签名交叉链接映射**：否决，改用小型手工策展 const。manifest 记录的是 `…Map` 符号，而签名引用的是派生联合类型名，且有少数符号出现在两个页面上。

## 后果

- 目录不会漂移：源码变化而已提交文件未反映时，`verify-cordis-catalog` 在 pre-push 钩子和 CI 中失败。新事件缺少 `@mode` 标签、或标签与签名矛盾时，生成器直接报错。
- 事件的行文描述现在只有一个归属地——声明处的 JSDoc。JSDoc 写得薄，目录条目就薄，这迫使作者在源头做好文档（生成器是 AGENTS.md「每个导出都有语义 JSDoc」规则的强制函数）。
- 继承层是手工摘要的，因此 vendor 同步若增加或重命名了 cordis-core 事件或 `ctx` 成员，需要同步编辑 `gen-cordis-catalog.ts` 中的策展表。这是不遍历固定 vendor 源的有意代价；变化很少，且在生成器中有明确标注。
- `verify-event-taxonomy.ts` 被删除，`docs/architecture.md` 的事件表格消失；之前链接到特定表格行的人现在会落到生成目录上。
