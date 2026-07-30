# Typert catalog 接入设计

[English](typert-catalog-integration-design.md) | 中文

## 现状与问题

Typert 已经具备独立的 host/client `FaceModel`、可显式跨 face 引用的 `TypeGraph`，以及 service、event、`@typert object`、泛型、继承和 External 类型的分析能力。TypeScript compiler API 只应负责把源码转换成这套标准模型；后续消费者不应再次遍历 TypeScript AST。

仓库目前有两条直接分析 TypeScript 源码的 catalog 链路：`tool-cordis` 使用的静态 API catalog，以及 `docs/cordis-catalog/events.md`、`docs/cordis-catalog/services.md` 的生成与 freshness gate。它们分析的是同一批 service、event 和相关类型，却分别维护收集与渲染逻辑，不能证明 Typert 模型足以承载现有业务语义。

第一阶段的目标是让这两条链路共同消费 Typert 模型，并保持三份已提交产物与迁移前字符级一致：

- `docs/cordis-catalog/events.md`
- `docs/cordis-catalog/services.md`
- `packages/cordis/tool-cordis/src/api-catalog.ts`

本阶段不要求业务插件发布 Typert 子路径，不要求示例应用加载 Typert，也不改变 `tool-cordis` 的运行时依赖关系。

## 可选路径

### 运行时 registry 驱动 `tool-cordis`

每个插件发布并加载 Typert 产物，`tool-cordis` 再从 `ctx.typert` 读取当前运行时模型。这条路径可以反映实际加载的插件集合，但会要求所有参与 catalog 的业务包增加 package exports、生成产物、registry contribution 和应用装配，接入面远大于当前要验证的分析能力。

### 全仓发布 Typert 产物后静态汇总

所有业务包在普通 build/typecheck 中生成 host/client JS 与 DTS，再由 catalog 生成器汇总这些产物。这条路径能够提前建立完整的发布协议，但会同时修改大量 package manifest 和构建拓扑，使 catalog 迁移与 Typert 的全仓发布绑定。

### 构建期分析后投影 catalog

`WorkspaceAnalyzer` 从 host TypeScript project 构建 `WorkspaceModel` 与 `TypeGraph`，仓库专用的 `CordisCatalogProjector` 只消费该模型并生成三份文本。`tool-cordis` 继续导入已提交的静态 `api-catalog.ts`，运行时不需要 Typert service。

本阶段采用构建期投影。它直接验证 Typert 标准模型能否替代现有 AST collector，同时把运行时 publication 和自动加载留在独立的后续决策中。

## 第一阶段架构

```text
tsconfig.host.json
        │
        ▼
WorkspaceAnalyzer ── TypeScript compiler API 的唯一边界
        │
        ▼
WorkspaceModel + TypeGraph
        │
        ▼
CordisCatalogProjector ── 不依赖 TypeScript AST
        ├── docs/cordis-catalog/events.md
        ├── docs/cordis-catalog/services.md
        └── packages/cordis/tool-cordis/src/api-catalog.ts
```

各对象的职责如下：

- `WorkspaceAnalyzer` 负责 package、export、service、event、类型声明和引用关系的分析，并产生 compiler-independent model。
- `WorkspaceModel` 与 `TypeGraph` 是所有生成和扫描分析共用的标准数据结构，保留开发者写出的泛型、继承和类型树，不保存 TypeScript AST。
- `@deepseek-ai/dsh-typert-generator` 根入口导出的 `CordisCatalogProjector` 负责模型驱动的选择、排序、摘要、源位置、JSDoc 完整性、类型链接闭包和三种文本格式；实现仍单独放在 Cordis catalog 专用文件中，但不形成额外的 package subpath，也不内置仓库类型名单。
- `scripts/gen-cordis-catalog.ts` 提供 `LINK_MAP`、`FOUNDATION_TYPE_NAMES`、`TYPE_LINK_EXEMPTIONS` 和 inherited Cordis 清单，通过 `CordisCatalogPolicy` 显式注入 projector，并负责 write/check 的命令行行为；vendor Cordis core 页面仍由独立的 pinned-source projector 生成。
- `tool-cordis` 只导入静态 `api-catalog.ts`，不依赖 `typert-registry` 或 `typert-loader`。

`CordisCatalogProjector` 是仓库业务消费者，不进入 Typert 通用模型。新增其他类别时，先扩展标准模型，再增加对应 projector；Typert analyzer 不吸收 Cordis 文档格式或 `tool-cordis` 展示逻辑。

## 模型补充

Catalog 的字符级投影除了类型结构，还需要开发者写下的声明形式和精确源码位置。标准模型因此保留 event/service location、event/member 的 body-free text、parameter initializer，以及 type declaration 的 export 状态和 canonical text；`SourceDeclarationModel` 另外索引顶层导出声明，供歧义检查和静态类型闭包使用，但不把它们提升为业务 graph root。

```ts
interface SourceLocation {
  readonly file: string
  readonly line: number
  readonly column: number
}

interface EventModel {
  readonly location: SourceLocation
  readonly text: string
}
```

全仓分析支持按 package 分批构建有界 `ts.Program`，再依靠源码位置稳定的 graph id 合并为与一次性分析等价的 face model。该能力只改变 compiler program 的内存边界，不改变 package、declaration 或 type graph 语义。

projector 所需信息必须来自 `WorkspaceModel` 或 `TypeGraph`。如果字符级兼容需要的事实无法从模型表达，应补充标准模型；不得在 projector 或脚本中重新引入 `ts.Node`、`ts.Symbol` 或 `ts.TypeChecker`。

## 字符级迁移 oracle

迁移前，在同一份源码状态下保留旧生成器产生的三份文本。迁移后运行新的 analyzer 与 projector，要求三份输出逐字节相等；换行、空格、排序、JSDoc、source pointer 和生成头都属于比较内容。

`pnpm run verify-cordis-catalog` 的 `--check` 模式继续读取三份 committed artifact，并与本次计算结果直接比较。任一文件缺失或任一字符不同都视为 stale，错误信息指向统一的 `pnpm run gen-cordis-catalog` 修复命令。

测试同时固定以下两层：

- Typert fixture snapshots 固定 `WorkspaceModel`、`TypeGraph`、JS、DTS 与 Zod 输出，证明标准模型和通用 emitter 的行为。
- Cordis catalog 测试或 snapshot 固定 projector 的三份完整文本，证明仓库业务投影没有绕过标准模型，并给出可直接评审的文本证据。

三份 committed artifact 是旧实现与新实现的迁移 oracle，也是迁移完成后的持续 freshness oracle。旧 `gen-cordis-api` AST collector 被删除；同名脚本和命令只作为统一 projector 的兼容入口保留，因为生成文件头本身包含该命令，保留入口可以维持字符级 oracle 而不产生第二套真源。

## 精确改造清单

### Typert generator

- 补齐字符级投影所需的 location、authored declaration text、parameter initializer、export 状态和顶层 source declaration index，并在 analyzer 与 model snapshots 中覆盖。
- 支持有界 package batch 分析，并证明 direct 与 batched model 等价。
- 确认 catalog 所需的 service 声明、public instance member、JSDoc、泛型、继承和引用类型均可从 model 读取。
- 保持 TypeScript compiler API 封装在 analyzer 内；公共 model 和 projector 输入不暴露 compiler 对象。

### Cordis catalog projector

- 从 host `WorkspaceModel` 选择完整的 Cordis service/event 集合。
- 保留旧生成器的 JSDoc 规则：event 必须有 `@mode` 和 payload `@param`，service method 必须有参数对应的 `@param`，非 void 返回必须有 `@returns`。
- 从 type graph 计算签名涉及的类型链接和 `tool-cordis` 所需的传递 public type closure。
- 通过显式 `CordisCatalogPolicy` 接收调用方维护的类型分类和 inherited surface，不在 generator 包内维护仓库文档 taxonomy。
- 保留 source pointer、签名、摘要、排序、声明截断和 inherited context catalog 的既有输出规则。
- 一次投影并渲染 events Markdown、services Markdown 与 TypeScript API catalog，避免文档和工具数据漂移。

### 命令与消费方

- `scripts/gen-cordis-catalog.ts` 维护仓库 policy 数据、组装 analyzer/projector，并同时 write/check 三份产物；解析、校验和渲染逻辑位于 generator 的 Cordis 专用源文件，并统一从 package 根入口导出。
- 将 `scripts/gen-cordis-api.ts` 收窄为统一 CLI 的无逻辑兼容入口；根目录的 `gen-cordis-api`、`verify-cordis-api` aliases 指向该入口。
- `tool-cordis` 恢复静态 catalog 默认值，移除对 `ctx.typert`、`typert-registry` 和运行时 package model 完整性的依赖。
- `gen-doc-graphs` 一次取得 projector 的 model-level 结果并复用 services/events，不能继续导入 AST collector 或重复分析全仓。

### 收窄本阶段改动面

- 撤销业务插件 package.json 中新增的 `./typert`、`./client/typert` exports 和 `lib/typert.*` files。
- 撤销 examples 中的 `typert-registry`、`typert-loader` 装配。
- 普通 build/typecheck 不运行全仓 `gen-typert`，也不要求 clean tree 预先存在业务包 Typert artifact。
- 保留 `packages/typert/generator`、`packages/typert/registry`、`packages/typert/loader` 及其独立 fixture、emitter 和 runtime registration 测试。

## 后续扩展

Runtime registry 继续作为生成 JS/Zod 后的接收与查询层，loader 继续作为自动装载机制；两者不承担第一阶段静态 catalog 的数据来源。业务包需要运行时反射时，可以按 package opt-in 发布 `package/typert` 与 `package/client/typert`，再由 loader 注册到 `ctx.typert`。

后续接入不改变本阶段的分层：TypeScript 只进入 analyzer，标准模型同时服务静态生成与扫描分析，runtime artifact 由 emitter 从同一模型产生。是否把更多 package 接入 publication、是否默认启用 loader，以及 runtime registry 最终提供哪些查询能力，分别评审，不与 Cordis catalog 迁移捆绑。
