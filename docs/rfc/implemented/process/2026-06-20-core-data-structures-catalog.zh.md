# RFC：核心数据结构目录与 `ts type-equiv` 漂移门禁

Status: implemented

[English](2026-06-20-core-data-structures-catalog.md) | 中文

## 问题

想要理解 harness 的读者可以在 [architecture.md](../../../architecture.md) 中找到它的*行为*（服务映射、会话/轮次/步骤生命周期、事件分类体系），但没有一个集中的地方描述它的*词汇*——那些行为所操作的数据结构。类型定义只存在于源码中，散落在各个 `packages/*/src/types.ts` 里，因此要理解「什么是 `Message`、`SessionEvent`、`StreamChunk`」就意味着直接阅读声明。一份行文目录会有帮助，但如果目录是对类型定义的转述或粘贴复制，那么字段一改它就会腐烂——而一份失去同步的类型文档比没有更糟，因为读者会信任它。

因此这项工作包含两个交织的问题：**这样一份目录应当收录什么**（范围界定问题：一个 harness 有数十个跨包（package）的类型，全部堆上去对谁都没帮助），以及**如何防止粘贴的类型定义漂移**（持久性问题）。本 RFC 记录这两项决策。它的姊妹篇 [生成式 Cordis 事件 + 服务目录](2026-06-20-generated-cordis-catalog.md) 是*接线*轴向的补充：本篇编目数据结构，那篇编目移动它们的事件与服务。

## 决策

新建 `docs/core-data-structures/` 目录编目词汇，并新增 `verify-type-equiv` doc-sync（文档同步门禁）门禁，确保每一处粘贴的类型定义与源码逐字节一致。

### 什么算「核心」——主干与 seam 的分界线

范围界定不是自上而下拍板的，而是将候选定义逐一对照具体的边界类型反复测试，直到一条规则在所有案例中都成立。决定性的测试是 `BashExecRequest`/`BashExecSpec`/`BashRunResult`：bash 是一个能力 *seam*，不属于 agent loop 主干；如果这些算「核心」，那「核心」就等于*所有跨包词汇*，目录就是一份平铺的全量转储；如果它们不算，「核心」就意味着*中央主干*，bash 词汇属于子页面。后者胜出，由此确定了整体结构：一个**分层目录**，而非一份平铺文档。

解决剩余案例的规则：***你编写、持有或接收的类型是核心；为其提供类型推导、渲染或持久化的机制是子页面细节。*** 逐一验证如下：

- 一个数据结构是**核心**的，如果它流经 agent loop 主干——无论加载了哪些插件，循环在每个轮次都持有、派生、流式输出或记录它（`Message`、`StreamChunk`、`SessionEvent`、`Agent` 句柄）——**或者**它是插件作者面向某条流水线编写的唯一标题类型（`ToolDefinition`）。
- `ToolDefinition` 是核心（它是每个工具作者编写的东西），**即使循环从不持有它**——对于这一个标题类型，撰写重要性覆盖了严格的「流经主干」规则。但它的类型推导机制——`SchemaSpec`/`InferArgs` DSL——是子页面细节（你编写的是 `ToolDefinition`；为其提供类型推导的机制你不直接接触）。这就是主干与 seam 分界线的精确表述。
- `ToolSchema` 是核心（它是 `GenerateOptions` 的字段，而 `GenerateOptions` 是流经每个步骤的模型请求），即使它在概念上属于工具流水线——当*流经主干*与*概念归属*冲突时，前者胜出。
- 工具展示词汇（`ToolCallView`/`ToolResultView` 等）、`SessionPersistence` 持久性 seam 以及 bash 词汇是子页面。

`core.md` 是一份**自包含的主干文档**：它给出每个主干结构的确切类型定义，配以最少的行文，并链接到各 seam 细节的子页面。子页面包括 `llm-streaming.md`、`session.md`、`persistence.md`（沿内存模型与持久性 seam 的分界从 session 中拆出）、`tools.md` 和 `bash.md`。

### `ts type-equiv` 机制——逐字且防漂移

持久性要求很具体：文档应展示**逐字**的当前类型定义（让读者看到真实形状，而非转述），**并且**机械地保证与源码一致。仓库已经能编译围栏 ` ```ts ` 块（`doc-typecheck`），但一个真正通过类型检查的块需要 import 噪音，且只能证明*可赋值性*而非*逐字节相等*——一个改了名但类型相同的字段仍能通过。因此：

- 类型定义逐字粘贴到专用的 ` ```ts type-equiv ` 围栏中。`doc-typecheck` 识别该围栏并跳过它（裸定义不能独立编译），并**将其排除在 opt-out 比例之外**——它是一个独立检查的类别，而非未检查的草稿。
- 新增 `scripts/verify-type-equiv.ts`，通过 TypeScript 解析器提取每个块，并对声明的符号断言**逐字源码匹配**——之所以选择这种方式而非编译式 `_Check` 可赋值性断言，正是因为逐字节相等而非可赋值性才是我们需要的属性。
- 来源信息保存在中央 `scripts/type-equiv.manifest.json`（`{ doc, symbol, source }` 条目）中，**而非**行文中的指令注释。脚本强制执行 **1:1 对应**：每个 type-equiv 块恰好有一条 manifest 条目，反之亦然；因此不会有块被静默漏检，也不会有条目腐烂。
- 接入 `doc-sync`，因此与其他文档门禁在同一个 lefthook pre-push 和 CI 路径中运行。

### 维护是作者的职责，门禁作为兜底

`verify-type-equiv` 能捕获已记录类型的*粘贴漂移*，但无法告诉你一个全新的核心类型没有被记录。因此 AGENTS.md 和 `dsh-code-review` skill 已更新，要求在变更添加或重塑已记录类型时同步更新目录——门禁处理漂移，人处理新增表面。

## 曾考虑的替代方案

- **平铺转储所有跨包词汇**：`BashExecRequest` 测试案例否决了它。如果 seam 词汇算「核心」，目录对谁都没帮助；分层的主干与 seam 结构胜出。
- **编译式 `_Check` 可赋值性断言**替代逐字源码匹配：否决，因为逐字节相等而非可赋值性才是我们需要的属性——一个改了名但类型相同的字段能通过可赋值性检查。
- **来源信息作为行文中的指令注释**：否决，改用中央 manifest；其强制的 1:1 对应确保不会有块被静默漏检，也不会有条目腐烂。

## 验证教训

主干与 seam 规则在采纳前经过了 `BashExecRequest`、工具 schema 与定义、schema DSL、展示类型以及 session/persistence 拆分的逐一测试。

`verify-type-equiv` 必须扫描完整的 Markdown 范围，而不仅是 manifest 中列出的文档。否则未登记的 `type-equiv` 块会逃脱所声称的一对一检查。因此门禁将此类块报告为遗留块。本 RFC 将这条快速失败的扫描规则与主干/seam 分界和逐字匹配决策一并记录；生成式 Cordis 目录在[其 RFC](2026-06-20-generated-cordis-catalog.md) 中有对称的设计记录。

## 后果

- 词汇现在有了一个**不会静默漂移**的唯一归属地：源码中的字段重命名会在 pre-push 钩子和 CI 中使 `verify-type-equiv` 失败，直到粘贴内容被刷新。
- 主干与 seam 分界线是一个可复用的范围界定工具，而非一次性决策：同一条「你编写/持有/接收的东西是核心；为其提供类型推导/渲染/持久化的机制是细节」规则，后来也被用于界定事件/服务目录的 harness 层与继承层分层。
- `ts type-equiv` 围栏是继 ` ```ts `（编译）和 ` ```ts ignore-check `（草稿）之后的第三种文档块类别。后续又新增了第四种 ` ```ts cordis-catalog `（生成签名），复用了相同的跳过并排除处理。
- 添加或重塑核心类型现在附带一项文档义务，作者必须履行（门禁无法检测缺失的*新*类型），由 `dsh-code-review` 检查清单兜底。
