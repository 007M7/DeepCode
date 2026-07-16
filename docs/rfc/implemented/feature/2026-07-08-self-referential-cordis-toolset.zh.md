# RFC：自引用 Cordis 工具集

Status: implemented

[English](2026-07-08-self-referential-cordis-toolset.md) | 中文

## 问题

本 harness 中的一切都是 Cordis 插件，但运行在该插件运行时内部的 agent（智能体）既看不到也碰不到它：它无法枚举周围的服务和事件，无法在会话中途为自己添加新工具，也无法组合自己发明的能力。把这种能力交给模型值得探索——一个能审视并修改自身运行时的自引用 agent——但它同时引出三个正确性问题，而本设计的核心正是回答这些问题，而非单纯的「让模型执行代码」机制。

第一，模型编写的注册必须在注册发生时就被校验：格式错误的工具 schema 必须在注册时失败，而非等到后续请求尝试将其组装进提示词时才暴露。第二，模型编写的代码需要调用它从未见过源码的服务 API——猜测方法签名，更糟的是猜测返回值形状，会耗费大量盲目试探步骤。第三，模型挂载的一切都必须完全可 dispose（资源释放）：模型可以按需释放，宿主插件重载时普通的插件生命周期也能释放，否则长会话会积累遗留的监听器和工具。

## 决策

该工具集以 [`@deepseek-ai/dsh-tool-cordis`](../../../../packages/cordis/tool-cordis/README.md) 发布——一个新的顶层 `packages/cordis/` 分组——并由 [`examples/cordis-agent`](../../../../examples/cordis-agent/README.md) 演示。它为模型提供三个工具，操作模型自身运行其中的活跃 Cordis 运行时：审视它、向其中挂载模型编写的插件、再将它们 dispose。

vm 隔离了意外的全局污染，上下文门面隐藏了框架内部实现。二者都不限制已暴露服务的权限：一个挂载可以调用 `ctx.bash` 以宿主执行器的权限运行命令，也能触及真实文件系统和网络服务。这是一个需要主动启用的开发工具，信任等级与 bash 等同，既不是安全边界，也不是产品默认配置。

### 三个工具

| 工具 | 契约 |
|---|---|
| `cordis_inspect` | 对活跃运行时的只读报告，每个 `what` 值对应一个 Markdown 段落（省略 `what` 则返回全部段落）。从不修改状态。 |
| `cordis_mount` | 在 `node:vm` 沙箱中执行 `code`（一个异步 JavaScript 函数体）；代码必须 `return` 一个 Cordis 插件，该插件作为 `cordis-dynamic` 分组 fiber 的子节点挂载，并以一个新生成的 id（`dyn-1`、`dyn-2`、……）追踪。 |
| `cordis_unmount` | 按 id dispose 一个动态挂载，并等待 disposal 达到静止——该插件所做的每一项注册都被撤销，而不仅仅是请求停止。 |

`cordis_inspect` 的段落：`services`（每个已提供的 ctx 服务及其所属 fiber，非活跃的 owner 会被标记）、`plugins`（来自 `ctx.registry` 的所有已加载插件的扁平列表及其生命周期状态——展示加载了哪些能力，刻意不展示树形结构）、`tools`（模型可调用的工具）、`dynamic`（挂载表：id、名称、状态、提供的服务、等待的服务）、`api`（来自生成目录的活跃服务签名及其引用的类型形状）、`events`（harness 事件及其分发模式和签名）。面向模型的工具描述携带模型在调用时所需的操作规则；[生成的工具目录](../../../tool-catalog.md)是其完整渲染。

### 沙箱语义

挂载代码作为异步函数体在一个新的 vm realm 中运行。其文档化的接口面将文件、网络、进程和定时器访问引导至 Cordis 服务，使挂载保持可审视和可 dispose。宿主 realm 的辅助手段仍使 Node 逃逸成为可能，与信任姿态一致。`vmTimeoutMs` 仅约束同步执行部分。

沙箱全局变量刻意精简：一个带标签的直通 `console`（在宿主 stdout/stderr 上输出 `[cordis:<id>] …`，使得挂载调用结束很久后触发的监听器仍能输出到用户可见之处）、`harness.defineTool` / `harness.registerTool` 注册对、新 vm 上下文缺少的编码原语（`btoa`/`atob` 作为宿主闭包封装 `Buffer`——这是一个经过批准的例外，`Buffer` 本身从不暴露——加上 `TextEncoder`/`TextDecoder`），以及对被扣留的 Node API 的可调用陷阱（`require`、`setTimeout`/`setInterval`/`setImmediate`/`clearTimeout`/`clearInterval`、`fetch`），调用时抛出错误并指名 Cordis 替代方案。只有函数形状的全局变量被陷阱拦截；`process` 和 `Buffer` 保持 `undefined`，使 `typeof` 特性探测保持惰性而非触发抛出异常的访问器。

挂载代码通过三道控制跨越 vm 边界。双 realm `instanceof` 同时识别宿主和 vm 对象。`harness.defineTool` 将结果规范化为宿主 realm 的 JSON，并在记录日志前校验 `ToolExecuteReturn` 形状。挂载的插件接收一个白名单上下文门面，而非原始或直通的 `Context`；框架管道和以 context 为值的返回会被拒绝。服务读取要求声明 `inject`，保持 Cordis 的激活和卸载语义。`ctx.tools.get` 仅暴露 schema 视图，使挂载代码无法绕过 `ToolRegistry.execute` 直接调用定义。

边界将无歧义的 JSON-Schema 形式规范化为 `SchemaSpec`，包括对象包装、`integer` 和可选字段。无效词汇会失败并给出可接受的替代方案。解析错误、TypeScript 错误、缺少 return、Node API 错误和重复工具错误会包含相关源代码行或纠正性契约，但不叙述实现内部细节。

### 动态分组与挂载生命周期

所有动态挂载都是工具插件下方一个 `cordis-dynamic` 分组的子节点，因此普通的 fiber disposal 即可处理重载和卸载。挂载会等待 settlement；启动失败会在返回错误前 dispose 该 fiber。已 settle 但处于 pending 状态的挂载仍然可见，并列出其缺失的注入。`cordis_unmount` 等待挂载 fiber 的 disposal。

### 通过 provide/inject 实现跨挂载组合

挂载之间通过普通的 Cordis 服务语义相互关联，以各自的 id 作为生命周期句柄：挂载 A 调用 `ctx.provide('foo', value)`，挂载 B 声明 `inject: ['foo']` 并在 `foo` 存在的瞬间激活；如果 B 先挂载，它会保持 pending 状态并列出缺失的服务；卸载 A 会使 B 回到 pending（其注册被撤销），之后重新 provide 会通过一个新的沙箱门面重新运行 B 的 `apply`；重复 provide 会大声失败并指名拥有该服务的 fiber。一个 realm 注意事项：挂载提供的服务值是 vm realm 对象——从任何地方调用其方法都能工作，但消费方不得假设其上有宿主原型。

### 生成的 API 目录

`cordis_inspect` 从生成的目录而非重复的表格提供 API 和事件数据。生成器复用 Cordis 目录的 AST 扫描，输出服务摘要、签名、事件模式、引用的类型声明和继承的上下文接口面。有歧义的类型名被省略，过大的声明被标记为截断。

新鲜度像所有生成产物一样受门禁保护：`pnpm run verify-cordis-api`（在 `doc-sync` 中）在内存中重新生成并在有任何 diff 时失败，因此修改了公开签名的 JSDoc 变更在不重新生成模型所读目录的情况下无法发布。运行时，inspect 工具将目录与活跃运行时取交集而非直接转储：有目录条目的活跃服务渲染摘要 + 签名，没有目录条目的活跃服务（挂载提供的）渲染名称 + 所属 fiber，有目录条目但没有活跃提供方的服务简要列出，引用的类型形状随后附上。

### 配置、渲染与可观测性

该插件暴露一个配置字段，由 schemastery 校验并记录在[配置目录](../../../config-catalog.md)中：`vmTimeoutMs`（默认 5000），挂载代码同步执行部分的毫秒上限。工具名称、`cordis-dynamic` 分组名和 `dyn-` id 前缀是结构性词汇，保持固定。三个工具均按[工具实操手册](../../../cookbook/adding-a-tool.md)渲染为 `generic` 卡片（`cordis_inspect` 为 `read`，`cordis_mount` 为 `execute` 并将代码作为 `rawInput` 携带，`cordis_unmount` 为 `delete`），不覆盖 `presentResult`。

「模型可见 ⟺ 已记录」成立，且不引入新的会话事件类型：挂载或卸载仅通过其自身的 `tool/call` / `tool/result` 对可见（循环会记录它），而挂载引起的工具集变化则由循环在 schema 在步骤间变化时已有的请求头 delta 日志记录。刻意不设 `cordis/mount` 溯源事件——它只会重复工具调用对已记录的内容。动态挂载是进程生命周期的，不是会话状态：恢复持久化的会话会重建对话但不会重新挂载插件。

## 曾考虑的替代方案

**用结构化的逐能力注册工具替代 `cordis_mount`。** 最诱人的替代方案是一个带有显式 `name` / `description` / `parameters` / `code` 字段的 `cordis_register_tool`（以及兄弟工具 `cordis_register_listener`、`cordis_register_service`、……），而非单一的「挂载一个插件」原语。否决原因：它唯一的真正优势——对最常见的单一场景省去插件样板——不足以抵偿其代价，而单一的挂载原语能一次性覆盖所有能力。

| 维度 | 结构化逐能力工具 | 单一 `cordis_mount` |
|---|---|---|
| Schema 正确性 | `parameters` 仍是模型编写的 JSON 对象，需要 SchemaSpec 校验，只是提前了一步 | 同样的校验在沙箱边界运行，同样的指导性错误 |
| 代码字段 | `execute` 体仍是 vm 中模型编写的 JS；realm 和服务调用正确性问题不变 | 一个沙箱、一条规范化路径、一道受守护的注册 |
| 能力覆盖面 | 仅限工具；监听器、服务、`inject` 关系各需另一个结构化工具——接口面无限增长 | 一套词汇（一个 Cordis 插件）覆盖当前和未来的所有效果 |
| 跨挂载组合 | 在工具注册载荷中无法表达 | 原生 `provide`/`inject`，普通 Cordis 语义 |
| 可审视性 | 注册的东西在插件列表中无法作为插件展示 | 模型挂载的东西正是 `cordis_inspect` 渲染的东西 |
| 模型易用性 | 对最常见的单一场景有优势（无插件样板） | 通过挂载描述中的规范示例加上教导正确做法的边界错误来缓解 |

因此，正确性投入放在能一次性覆盖所有能力的地方：通过 `cordis_inspect` 暴露的生成 API 目录，以及沙箱边界校验——其错误消息教导正确的调用方式。结构化注册工具日后仍可作为语法糖添加，合成挂载代码即可；本设计不排斥它。

**在工具中手工维护服务/事件参考。** inspect 工具的第一版携带了一张手写的服务方法签名表。它被生成的 `api-catalog.ts` 取代，因为手写表在签名变化的瞬间就会与 JSDoc 脱节，且没有门禁检测这种漂移；而生成产物的新鲜度由与文档使用同一 AST 的检查来保证。

**新增 `cordis/mount` 会话事件。** 记录每次挂载（源码、名称）的持久溯源事件有明确先例（`hook/invoked`、`compact/start`）。v1 中否决：挂载和卸载已经作为 `tool/call` / `tool/result` 对可见，工具集变化已经作为请求头 delta 被记录，因此专用事件只会重复记录。如果审计用例需要将挂载溯源与工具调用分离，日后仍可添加。

**加固的 / 能力受限的沙箱。** 拦截 Node 内置模块并向挂载代码提供白名单门面而非原始 context，可能暗示意图是为安全而沙箱化。明确声明并非如此：陷阱和门面收窄的是挂载代码所见的*接口面*——将其引导至 Cordis 服务、远离易泄漏的 Node 内置模块和框架内部——目的是正确性和封堵未守护的 context 逃逸，但门面暴露的能力（`ctx.bash`、`ctx.fs`、`ctx.web`）触及真实运行时，因此它不是安全边界。真正的安全边界（独立进程、权限提示）对一个开发/主动启用的工具集来说超出范围，且与其核心目标——将活跃运行时交给模型——相悖。

## 后果

该工具集是刻意需要主动启用的，具有完全权限的 `ctx`，因此部署方采用它的意识程度与采用 bash 工具相同。以下事实由工具描述直接告知模型：waterfall（瀑布式事件）监听器（如 `tools/pre-execute`）如果不调用 `next()` 就返回，会否决整条链，因此挂载的监听器可以瘫痪 agent 自身的工具分发（[waterfall 语义](../../../cordis-primer.md#cordis-waterfall-semantics)）；挂载代码在当前轮次的工具调用内运行，因此 await 任何只在该轮次结束后才 resolve 的东西会死锁；`vmTimeoutMs` 仅约束同步执行；挂载不会在会话恢复后存活。
