# RFC：导出表面 JSDoc 门禁

Status: implemented

[English](2026-07-06-export-surface-jsdoc-gate.md) | 中文

## 问题

[cordis JSDoc 完整性门禁](2026-07-04-cordis-jsdoc-completeness-gate.md)使 cordis 表面上的未文档化参数和返回值不再可能——`interface Events` 成员与 `ctx.<key>` 服务类——但那只是插件作者所导入内容的一小部分。AGENTS.md 中「每个导出（及非显而易见的方法）都应有 JSDoc 说明语义」这条规则在其他地方仍然只能靠评审以行文方式检查，而且没有任何机制要求普通导出函数带 `@param`/`@returns`。采纳时的一次调查发现 34 个包中有 203 个文档不完整的模块级导出：seam 相关辅助函数（`runBash`、`readForEdit`、`htmlToMarkdown`）、格式编解码器、整个未文档化的接口和类型别名——正是 IDE 消费方悬停时看到的那些名字。

## 决策

新增门禁 `scripts/verify-export-jsdoc.ts`（`pnpm run verify-export-jsdoc`，接入 doc-sync，与 `verify-cordis-catalog` 并列），遍历每个 `packages/<group>/<pkg>/src/` 目录树下所有模块级导出名。解析与检查辅助函数从 `gen-cordis-catalog.ts` 移入共享的 `scripts/jsdoc.ts`，因此「已文档化」在两个表面上含义一致：描述文本在第一个块标签处截止，每个可检查参数需要非空 `@param`，非 void 的**已标注**返回值需要非空 `@returns`，过时的 `@param` 报错，违规汇总为一份报告。

按声明类型划分的契约：

- 每个导出名都需要带有非空描述文本的 JSDoc。
- 函数类导出（函数声明；以函数初始化器或行内可调用标注的 const；非标识符的函数默认导出）遵循完整的函数契约，分类前会剥离包装表达式（括号、`as`/`satisfies` 转型、非空断言）。如果 const 的声明器标注了一个**命名**类型（`export const f: Handler = …`），则签名契约推迟到该类型自身的声明，`@returns` 可选；行内 `(x: T) => U` 标注或单调用签名字面量即为表面签名本身，适用完整契约；而字面量中混合了调用/构造签名与其他成员的情况则直接拒绝（没有单一签名可供标签对照——请提取命名类型）。
- 导出类需要类级别的描述文本；公开方法（包括静态方法——可通过导出名访问）遵循函数契约；公开属性和访问器需要描述文本（get/set 对由 getter 覆盖）。重载实现免检——由签名承载文档。
- 导出的接口、类型别名和枚举需要声明级别的描述文本；成员级别的强制有意推迟（承载关键成员契约的 seam 服务类已在 cordis 门禁下）。
- 导出的命名空间递归检查（在 ambient `declare` 命名空间内，每个成员隐式导出）；命名空间本身仅在不与同名已文档化声明合并时才需要描述文本（Config 命名空间惯用法只需文档化插件一次）。
- `declare module` / `declare global` 体和 `export … from` 再导出语句被跳过：augmentation 不是包的导出，再导出的定义在其定义处检查。`export import X = N.member` 别名文档化**自身**——其目标可能是遍历不会访问的非导出命名空间成员——且仅支持纯描述文本的目标类型：可调用、类或命名空间目标携带别名描述文本无法承载的签名/成员契约，门禁拒绝此类情况并要求直接导出该声明。
- 其余一切按**封闭**原则失败：`export =` 直接拒绝；基类从未命名的参数即使作为绑定模式仍保留 `@param` 义务；调度未识别的导出语句类型本身即为违规——没有任何导出形式能因遗漏而免检。

三类豁免避免门禁要求样板代码，精神与 cordis 门禁的 `this`/`next` 豁免一致（对已豁免的名字主动写文档是允许的；只有缺失才不被检查）：

- **继承成员。**重写从基类声明继承文档。新增的公开表面仍需文档：新增参数、将 protected 成员公开重写、或在 void 基类之上给出具体返回值。继承查找与推断返回值分类是门禁唯一需要类型检查器的工作；其他检查使用 AST。
- **插件协议槽位。**顶层 `name` / `inject` / `reusable` / `Config` const 与 `apply` 入口，以及插件类上作为静态成员的相同槽位，属于框架协议：其形状由 cordis 固定，模块文档注释加 `interface Config` 承载插件的真实语义。
- **构造函数**，与 cordis 门禁一致：插件类由框架构造，类文档承载全部说明。

`collectExportJsdocViolations()` 返回违规列表（CLI 在非空时以 exit 1 退出），因此 `packages/core/agent/tests/verify-export-jsdoc.spec.ts` 中的负路径测试直接对发现结果断言，通过 fixture 包驱动每一种拒绝和每一种豁免。

## 曾考虑的替代方案

- **eslint-plugin-jsdoc**（`require-jsdoc`/`require-param`/`require-returns`）：覆盖了机械核心，但无法表达本仓库的契约：继承成员豁免需要跨包类型解析，协议槽位和命名空间合并惯用法是 cordis 特有的，而完整性语义（标签前描述文本、过时标签报错、聚合报告）已在 `scripts/jsdoc.ts` 中与 catalog 生成器共享一处。两套微妙不同的「已文档化」定义正是本仓库「一处为家」规则要防止的失败模式。
- **扩展 `gen-cordis-catalog.ts`**：catalog 生成器渲染一个精选表面并门禁其新鲜度（freshness）；仓库级遍历没有 catalog 可渲染。共享辅助函数但保持遍历分离，使每个门禁的职责清晰可读。
- **强制接口/类型别名的成员文档**：推迟。这会将检查表面扩大到大量自描述字段，而承载关键成员契约的 seam 类已在门禁下。如果评审中出现成员文档漂移再重新考虑。

## 后果

- 新导出不能在无文档的情况下落地：`verify-export-jsdoc` 使 doc-sync 失败，而 pre-push 和 CI 已经运行 doc-sync。采纳时发现的 203 处缺口在同一个变更中补齐，因此门禁以绿色状态落地。
- 导出函数必须标注返回类型（采纳时已全面覆盖，现在成为承载性要求），且在 `@param` 需要命名的地方使用标识符参数。
- seam 文档是权威的：实现从继承链继承文档，值得保留在实现上的行为说明是补充，而非必需。
- 门禁构建一个 `ts.Program`（约 6 秒）——唯一需要类型解析的文档门禁；在已经编译文档片段的 doc-sync 中可以接受。
- 协议槽位名在模块顶层按约定保留；一个碰巧名为 `apply` 或 `Config` 的非协议导出会免检——已接受，记录于此。
