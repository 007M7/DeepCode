# 事后分析 0001：ACP 服务器在连接时崩溃——`export default` 丢弃了插件的 `inject`

[English](0001-acp-default-export-drops-inject.md) | 中文

Status: resolved (fix in PR #41 `feat/acp-2-bridge`)

## 摘要

两个集成错误在单元测试全绿的情况下击溃了 ACP：一个 default export 导致 Loader 丢弃 `inject`，一个经过 traceable 代理的可选服务查找在 shadow 边界上失败。手动挂载的测试绕过了这两条路径。修复后新增了无需 API key 的真实 Loader 覆盖，以及关于插件导出和可选服务访问的包（package）规则。

## 概述

ACP 服务器（`examples/acp-agent`、`@deepseek-ai/dsh-acp`）在真实编辑器（Zed）连接的瞬间崩溃：第一个 `session/new` 请求返回 `Internal error: cannot get property "agents" without inject`，`session/load` 对 `sessionPersistence` 返回相同错误。尽管有 178 个绿色单元测试和 100% 行覆盖率，bridge 在生产环境中完全无法工作。两个独立的 bug 隐藏在同一个错误字符串背后，测试套件因同一个原因漏掉了二者：每个测试都通过一条不会触及插件实际加载方式或服务实际解析方式的路径来挂载插件。

## 影响

ACP 服务器无法创建或加载任何一个会话——这正是编辑器最先调用的两个 RPC。任何将 agent 接入 Zed 的人都会立即遇到硬性失败。无数据丢失（崩溃前没有持久化任何内容）；代价完全是「功能不可用」加上两次定位原因的调试时间。

## 时间线

- Bridge（RFC 010）带着完整的单元测试套件（编解码、内存传输、基于属性的协议形状测试、失败路径、HMR（热模块替换））、一个需要 key 的真实 API e2e 测试，以及一个无需 key 的 stdout 纯净性 e2e 测试一起落地。全部绿色，100% 覆盖率。
- 一次真实的 Zed 会话立即在 `session/new` 上失败，报错 `cannot get property "agents" without inject`。
- 调查最初追踪的是 Cordis「traceable/shadow」理论（合理，且机制确实存在——见 Bug #2），随后在 vendor 的 `reflect.ts` 中对实际 fiber 遍历做了插桩，并运行了真实子进程。trace 显示 throw 发生在 `apply()` 第 179 行、**插件加载时**，位于 ROOT fiber 且没有 shadow——推翻了 shadow 理论对 `session/new` 的解释。
- 找到根因 #1：一行多余的 `export default apply`。移除后 `session/new` 修复。
- 移除后暴露了 Bug #2：`session/load` 仍然在 `sessionPersistence` 上抛出——这是一个真正不同的机制（shadow 遍历），通过隔离修复并重新运行真实子进程得到确认。

## 根因 #1——`export default apply` 丢弃了插件的 `inject`（导致 `session/new` 崩溃）

`packages/ui/acp/src/index.ts` 是一个*命名空间插件*：它将 `name`、`inject`、`Config` 和 `apply` 作为独立的命名导出——与仓库中其他所有插件（`invariants`、`llm-deepseek`、`tool-bash`、`stdio-chat` 等）形状相同。但它*还*多了一行其他插件都没有的代码：

```ts ignore-check
export const name = 'acp'
export const inject = ['agents', 'sessions', 'sessionPersistence']
export function apply(ctx: Context, config: AcpConfig): void { /* … */ }
// …
export default apply   // ← the bug
```

当插件从 `cordis.yml` 加载时，Cordis Loader 通过 `Loader.unwrapExports`（`vendor/loader/src/index.ts`）对导入的模块做规范化处理：

```ts ignore-check
unwrapExports(exports: any) {
  if (isNullable(exports)) return exports
  exports = exports.default ?? exports        // ← prefers `.default`
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}
```

存在 default export 时，`exports.default ?? exports` 解析为**裸 `apply` 函数**。裸函数没有 `inject`、没有 `name`、没有 `Config` 属性——这些作为*兄弟*命名导出存在于模块命名空间上，而 unwrap 到 `.default` 把命名空间整个丢弃了。Loader 随后基于一个空的 `inject` 构建了插件的 fiber。

因此 `apply` 在一个**没有注入任何服务**的 fiber 中运行。第一行 `const agents = ctx.agents` 遍历 fiber 树（ROOT → Include → Loader → ROOT），在所有 fiber 的 store 中都找不到 `agents`，到达根 fiber（`runtime === null`）后抛出 `cannot get property "agents" without inject`。崩溃发生在*加载时*，而非后续的请求处理器中——请求只是恰好触发了加载。

**修复：**删除 `export default apply`。Loader 随后使用模块命名空间，正确识别 `inject`/`name`/`Config`，`apply` 在一个真正授予了声明服务的 fiber 中运行。

## 根因 #2——可选服务的属性读取在 traceable shadow 中触发 inject 守卫（导致 `session/load` 崩溃）

修复 #1 后，`session/new` 正常工作，但 `session/load` 仍然抛出 `cannot get property "sessionPersistence" without inject`。这次*确实*是 Cordis 的 traceable/shadow 机制，值得精确理解。

`session/load` 调用 `agents.resume(...)`，后者委托给 `AgentLoop.resume()`，其中读取了 `this.ctx.sessionPersistence`。`AgentLoop` 的 `static inject` 故意**不**包含 `sessionPersistence`——注入它会导致非持久化的演示永远挂起，等待一个永远不会加载的后端。该服务由一个独立的兄弟插件/fiber 提供，按需读取。

Cordis 中的服务访问通过上下文代理（`vendor/cordis/src/reflect.ts`）进行。当通过从外部 fiber 获取的 *traceable 代理*调用服务方法时（此处：bridge fiber 调用 `ctx.agents.resume`，注册表返回 `this.factory`——即 `AgentLoop`——被重新包装为绑定到调用方的新 traceable 代理），`createShadowMethod`（`vendor/cordis/src/utils.ts`）将 `this` 重新绑定到一个 *shadow* 对象，其 `ctx` 携带 `[symbols.shadow]` 指向 `AgentLoop` 自身的构造上下文。在 `resume` 内部，`this.ctx.sessionPersistence` 的解析从 shadow 的 fiber 开始遍历：

```ts ignore-check
// reflect.ts get handler
let fiber = (ctx[symbols.shadow] as Context ?? ctx).fiber   // ← starts at AgentLoop's fiber
while (true) {
  const impl = fiber.store?.[prop]
  if (impl) return getTraceable(ctx, impl.value)
  if (prop in fiber.inject) { /* inactive-context error */ }
  if (!fiber.runtime) throw error                            // ← reached root, throw
  if (fiber.parent[symbols.isolate][prop] !== key) throw error
  fiber = fiber.parent.fiber                                 // ← ancestor-only
}
```

遍历**只走祖先方向**。`sessionPersistence` 既不在 `AgentLoop` 的 fiber store 中（不在其 `static inject` 里），也不在通往根的任何祖先上（它在一个*兄弟*分支上），因此遍历到达根 fiber 后抛出。

为什么内存中的 `AgentLoop` resume 测试没有捕获到这个问题？因为它们从测试代码中直接调用 `ctx.agents.resume(...)`——*不在任何插件 fiber 内*。此时 `ctx.fiber.runtime` 为 `null`，代理处理器走了一条提前退出的路径：

```ts ignore-check
if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)   // ← direct global-store lookup, no fiber walk
```

`ctx.reflect.get(name, false)` 是基于 isolate symbol 的全局服务 store 直接查找——完全忽略 fiber 拓扑，能找到服务。因此从顶层测试读取正常；从真实插件 fiber 内部、经由 shadow 到达时则抛出。bridge 恰好是后者。

**修复：**使用 `ctx.get('sessionPersistence')` 读取可选服务，该方法使用全局 isolate-keyed store，同时保留活跃状态检查。对于插件声明注入集中的服务，直接属性读取仍然适用。

## 为什么所有测试都漏掉了（真正的失败）

两个 bug 共享同一个流程缺口：**没有任何测试通过插件的真实加载路径或真实调用拓扑来运行它。**

- 内存 harness 通过手动构建插件对象来挂载 bridge：`ctx.plugin({ name, inject, apply })`。这手动提供了 `inject`，因此永远无法复现 Bug #1——`unwrapExports` 只被 *Loader* 调用，`ctx.plugin` 从不调用它。即使 `ctx.plugin(NamespaceImport)` 也无法捕获此问题。
- 同一个 harness 把所有东西平铺挂载在一个根上下文上，因此从中触达的 `AgentLoop` resume 要么在顶层运行（`!runtime` 旁路），要么通过一个 origin 仍在根上解析的 shadow——掩盖了 Bug #2 的祖先遍历失败。
- 唯一的无 key e2e 发送 `initialize` 并检查 stdout 纯净性。`initialize` 从不触达 factory，因此安然通过两个 bug。
- 唯一驱动 `session/new`/`session/load` 的测试需要 key 才能运行，CI（无 key）跳过了它——而本地它之所以「通过」，只是因为一个陈旧的已构建 `lib/`（包含旧代码）恰好满足了模块解析。

100% 行覆盖率自始至终满足。覆盖率证明代码行*被执行过*；它不能说明功能是否*以交付的方式*工作。

## 新增的防护措施

- **移除 `export default apply`**（`packages/ui/acp/src/index.ts`）——Bug #1 的修复。
- **`AgentLoop.resume` 使用 `this.ctx.get('sessionPersistence')`**（`packages/core/agent-loop/src/index.ts`）——Bug #2 的修复，附注释说明 shadow 遍历陷阱。
- **无需 key 的 `session/new` e2e，通过真实 stdio 运行**（`examples/acp-agent/tests/acp.e2e.ts`）：以子进程方式通过真实 Loader 启动示例，并断言 `session/new` 正常返回。无需 API key 即可在 Bug #1 上大声失败。已验证恢复 `export default apply` 时测试失败。
- **e2e spawn 中设置 `TSX_TSCONFIG_PATH`**：子进程从临时 cwd 运行，tsx 无法通过向上搜索找到仓库根的 tsconfig `paths` 映射——因此 dsh-* 的导入静默回退到已构建的 `lib/`。将 tsx 指向仓库 tsconfig 使解析不依赖 cwd，确保测试运行的是*源码*而非可能陈旧的构建产物。
- **[docs/testing.md](../testing.md) 规则**：「测试真实入口路径」，行覆盖率不等于行为覆盖率——将此教训编纂为所有未来插件的规则。

## 教训

- 命名空间插件与 default export 在 Cordis Loader 下互斥。选择命名空间形式（`name`/`inject`/`Config`/`apply`），不要添加 `export default`——`unwrapExports` 会丢弃命名空间。
- 对于插件按需读取但**不**声明在 `static inject` 中的服务，使用 `ctx.get(name)`，绝不使用 `ctx.<name>`。属性代理通过只走祖先方向的 fiber 遍历解析，经由外部 shadow 时会失败；`ctx.get(name)` 是拓扑无关的查找（且默认严格——后端未激活时返回 `undefined`，而非在 teardown 过程中把半拆除的实例交出去）。
- 手动构造插件的测试无法验证插件的加载方式。至少一个测试必须端到端地驱动真实的 Loader/export 路径。当核心操作不调用模型时，该测试无需 API key——因此它属于 CI，而非 key 门控之后。
- 相信 trace，不要相信理论。优雅的 shadow 解释是真实的，但它是*第二个* bug；*第一个*是一行导出错误，在数小时合理但错误的推理之后，一条 fiber 遍历的 `console.error` 几分钟就找到了它。
