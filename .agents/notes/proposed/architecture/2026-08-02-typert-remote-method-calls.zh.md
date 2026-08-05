# Agent Note: TypeRT Gateway 定向方法调用

Status: proposed

[English](2026-08-02-typert-remote-method-calls.md) | 中文

## Problem

Host API Proxy 同时承担直接方法调用、带状态交互和 Session 事件流。三者的生命周期、路由语义和客户端编程界面不同，继续共用一个业务导出包会让业务 Service、传输协议、状态机和客户端类型彼此耦合。

本方案只解决一次请求对应一次结果的定向方法调用。Permission、Approval 等带状态交互以及 Session 事件流不使用本方案，后续分别设计。

直接方法调用的契约属于实现该行为的业务 Service。业务开发者应只声明哪些方法可以远程调用，而不应再同步维护中央 API 接口、路由表、参数转换表、客户端 stub 和 Zod schema。

Host 与 Browser Client 使用独立的 TypeScript Program，因为两边会以不同类型合并同名 Cordis `Context`。Remote 投影不能把完整 Host 声明导入消费端，也不能依赖 Browser 专属类型；未来 TUI 若复用这套编程界面，也只能看到 Remote 标记的方法。本期不实现 TUI 接入，但实现边界不得阻断这种同构复用。

## Proposal

业务 Service 通过 `@Remote` 或 `@RemoteContext()` 声明可调用方法，并通过 `bindTypeRTGateway()` 显式加入 Gateway。TypeRT 从 Host Program 生成 Host 本地反射产物和平台无关的 Remote 消费端投影；Client Program 继续独立生成自己的本地反射产物。

Remote 消费端投影同时包含 `.d.ts`、`.d.ts.map` 和 `.js`。`.d.ts` 只暴露被 Remote decorator 标记的方法，并引用业务包唯一的公共类型符号；`.d.ts.map` 把消费端 API 方法导航回 Host 业务方法实现；`.js` 携带同一契约的 endpoint、参数、Context 和 Zod 信息。Browser Client 在 assembly 层把需要的 Remote JS 贡献集中挂到 Client API Service；该投影和 API 抽象保持平台无关，以便未来 TUI 复用。

`@deepseek-ai/dsh-host-api-gateway` 在 `packages/host/api-gateway` 内提供对称的两个 face：默认入口提供 Host `ctx.typertGateway`，`/client` 入口提供消费端 `ctx.api`。两边各自在本地消费由同一模型生成的 `InvocationDescriptor`，descriptor 不通过 wire 发送。Remote 数据协议运行在唯一 Connection/RPC 机制之上，使用独立 `/api2` channel；业务调用界面不随 Connection 从 HTTP 迁移到 WebSocket 而改变。

## 组件和 Cordis 服务

| 组件 | Cordis 服务 | 本方案中的职责 |
|---|---|---|
| `@deepseek-ai/dsh-type-meta` | 只声明 `ctx.typert` 的最小协议 | decorator、binding、descriptor、lookup/Context 和 Remote map；不依赖 compiler、Zod、Connection 或 Browser |
| TypeRT registry | `ctx.typert` | 分开保存当前环境 reflection、导入的 Remote contribution、lookup provider 和 Context provider |
| TypeRT generator/loader | 无新增业务服务 | 从 Host/Client Program 生成三类 `lib` 产物，并把当前环境产物注册到 `ctx.typert` |
| Host API Gateway 的 Host face | `ctx.typertGateway` | 关联 Host definition 与活 Service，解码参数、解析 receiver、调用方法和编码结果 |
| Connection | `ctx.connection` | 独占 HTTP Server/未来 WebSocket、RPC envelope、rpcId、序列化、trust 和错误传输，并承载 `/api` 与 `/api2` 两个隔离 channel |
| Host API Gateway 的 Client face | `ctx.api` | mount Remote contribution，实体化根 API 和 scoped API，把规范调用交给 `ctx.connection.rpc` |
| Client Remotes | 无新增服务 | 作为 Client 业务的唯一 Remote facade，选择并挂载 `/remote` contribution，同时传递 Gateway Client face 和所选 API 的类型声明 |
| Agent/Session owning 包 | 既有领域服务 | 同时提供静态 interface merge 与运行时 lookup/Context provider |
| Goal 等业务包 | 既有业务 Service | 只声明 binding、Remote 方法和唯一 DTO，并导出生成的 `/remote` 子路径 |

Host Gateway 不依赖 `ctx.agents`、`ctx.sessions`、`ctx.goals` 或 `ctx.httpServer` 的具体实现。Client API 不理解物理 carrier，Connection 也不理解 Goal、Agent、lookup、`InvocationDescriptor` 或 Client API namespace。

## 业务声明

普通直接调用使用 `@Remote`。迁移到现存 Service 或 Registry 时不重命名、不改变存量方法；类末尾新增 `remoteExport*` 出口，并由 decorator 参数声明短 API 名。方法需要哪个业务对象，就在顶层参数位置显式声明该对象：

```text
export class GoalService extends Service {
  readonly typertGateway = bindTypeRTGateway(this, 'goals')

  create(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    // Existing business method remains unchanged.
  }

  @Remote('create')
  remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    return this.create(agent, request)
  }
}
```

`goals` 是明确的 Cordis service key，并默认作为 wire namespace。只有协议 namespace 确实需要与 service key 不同时，才通过 `bindTypeRTGateway()` 的选项覆盖。

需要在某类隔离 Context 中查找 Service receiver 时使用 `@RemoteContext()`。Context identity 不进入业务方法参数：

```text
export class ScopedGoalService extends Service {
  readonly typertGateway = bindTypeRTGateway(this, 'goals')

  @RemoteContext('agent', 'create')
  remoteExportCreate(request: CreateGoalRequest): Promise<CreateGoalResult> {
    // Runs against the goals service resolved from the Agent Context.
  }
}
```

同一个 endpoint 只能选择一种调用模式。需要显式 `Agent` 参数的流程使用 `@Remote`；需要切换到 Agent Context 再解析 scoped receiver 的流程使用 `@RemoteContext('agent')`，两者不会由 TypeRT 根据方法体或参数缺失自动猜测。

业务包只依赖轻量的 `@deepseek-ai/dsh-type-meta`。它提供 decorator、`bindTypeRTGateway()`、lookup、Remote Context 和 descriptor 的声明协议，不依赖 TypeScript compiler、Zod、HTTP 或 Client runtime。

## Decorator 与显式 Gateway facet

Decorator 只表达“该方法参与 Remote 契约”，不负责运行时类型反射，也不向 Service constructor 注入隐藏 symbol。`@Remote('create')` 和 `@RemoteContext('agent', 'create')` 的参数是外部方法名，实际成员名保持 `remoteExportCreate`；未给别名时才使用成员名作为外部方法名。`typertGateway` 是 Service 加入 Gateway 的唯一显式标志，使业务类和运行时实例都能直接看出这项能力。

SRC 运行时允许 decorator 在 `dsh-type-meta` 内部的 `WeakMap` 记录 prototype、方法名和调用模式。它不向 Service 实例、prototype、constructor 或方法函数写入自定义属性。

LIB 的严格方法发现、类型解析和 descriptor 生成由 TypeRT compiler 完成。生成过程不改写业务源码，也不向 `bindTypeRTGateway()` 偷注生成参数。

## Lookup 与 Remote Context 注册

Gateway 不内置 Agent、Session 或其他业务对象分支。对象所属包同时提供静态声明和运行时 provider：

```text
declare module '@deepseek-ai/dsh-type-meta' {
  interface TypeRTLookupMap {
    agent: TypeRTLookup<Agent, SessionId>
  }
}

ctx.typert.lookups.register('agent', {
  parameter: 'agent',
  wire: 'agentId',
  resolve: sessionId => resolveAgent(sessionId),
})
```

静态声明让 TypeRT 知道 `Agent` 在 wire 上对应 `SessionId`；运行时 provider 负责把请求中的 `agentId` 解析为当前活的 `Agent` 对象。缺少任一侧时，LIB 构建或最早可解析的运行时注册直接失败。

Agent、Session 等 lookup 对象只能各自占据一个顶层参数位置。普通 JSON request 可以作为另一个完整参数传入，但本方案不支持 `request.agent`、对象解构、对象数组、嵌套 lookup 或从任意复杂结构中搜索 ID。

Remote Context 使用独立的 merge-extensible map 和 provider。Agent 包注册 `agent` Context provider，负责用 wire identity 找到 Agent Context，并从该 Context 解析 descriptor 指定的 service key；Gateway 不知道 Agent Context 的内部结构。

Client 侧也注册 `agent` Context binder。binder 只负责从一次调用所在的 Context 取得 `SessionId`；它不枚举 Scope，也不逐个复制方法。scoped namespace 由 Cordis Service tracker 自动 rebind 到当前 Agent Context。

## InvocationDescriptor

TypeRT、SRC 弱解析器、Host Gateway 和 Client API 之间只交换一种规范描述：

```text
InvocationDescriptor {
  id: '@deepseek-ai/dsh-goal#goals/create'
  service: 'goals'
  namespace: 'goals'
  method: 'create'
  implementation: 'remoteExportCreate'
  invocation: direct | { context: 'agent', wire: 'agentId' }
  scope?: { context: 'agent', wire: 'agentId' }
  parameters: [
    { name, wire, source: json | lookup, lookup?, codec }
  ]
  result: codec
  sourceLocation
}
```

`method` 是 endpoint 和 Client API 使用的外部短名，`implementation` 是 Host receiver 上的真实成员名；两者相同时可省略 `implementation`。`direct` descriptor 保留原始 Service 实例作为 receiver。Context descriptor 先通过对应 Context provider 找到 scoped Context，再以 descriptor 的 service key 解析 receiver。

严格生成器只在 direct 方法恰好包含一个 lookup 参数、同名 `TypeRTContextMap` 声明存在且两者使用同一 wire 类型 symbol 时写入 `scope`。`scope.wire` 必须指向该 lookup 参数；它声明消费端可以从调用所在 Context 补入这个参数，不改变 Host receiver 或 endpoint。多个 lookup、缺少 Context 声明或 wire 类型不一致时不生成 scoped 投影，其中类型不一致属于构建错误。

参数顺序来自方法签名，HTTP 字段来自参数名或 lookup 声明。Gateway 不根据请求内容推断可选字段、Context 类型、lookup 类型或缺失参数，也不会合成业务默认值。

LIB codec 带有 Zod schema 和“package + 公共 subpath + export name”的规范 `typeSymbol`；SRC codec 只标记 `src-json`。Host 和消费端运行在不同 JavaScript realm 时会各自持有 Zod 实例，但这些实例由同一 TypeRT 模型和 symbol key 生成。

descriptor 只存在于两端本地 registry。wire 上只有 `/api2` channel、endpoint 和 `{ args }` payload；Host 用自己的 descriptor 解码和调用，Client 用自己的对应 descriptor 编码参数和验证结果。

## TypeRT 运行时 registry

```text
ctx.typert.local     当前进程自己的 Host 或 Client reflection
ctx.typert.remotes   消费端显式 mount 的对端 Remote contribution
ctx.typert.lookups   wire ID 到 Host 活对象的 provider
ctx.typert.contexts  Host Context resolver 与 Client Context binder
```

每次注册都返回由调用方 Cordis fiber 持有的 disposer。Gateway 和 API Service 先读取当前快照再订阅变化，因此业务 Service、generated contribution、provider 和消费者可以按任意顺序加载；任一依赖 dispose 后，相关 endpoint 或方法立即失效。

Registry 的 Host 根入口拥有完整 `TypeRTService` interface merge；Host 与 Client 共用的 registry 实现位于无环境声明的独立模块。Registry `/client` 入口只引用该共享实现，不经过 Host 根入口，因此不会把 Host Cordis 声明带入 Client Program。

## 唯一类型、符号与 Zod

Remote Client DTS 不复制业务 DTO，也不重新声明一个结构相同的影子类型。它只从不携带 Host Cordis merge 的公共纯类型 subpath 引用原始符号：

```text
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreateGoalRequest, CreateGoalResult } from '@deepseek-ai/dsh-goal/types'
```

因此 `SessionId`、Agent wire ID、request 和 result 在 Host 与 Browser Client 中都指向同一 TypeScript declaration，未来 TUI 复用时也不需要第二份类型。DTO 的跳转定义、重命名和引用查找回到业务类型的唯一源码位置，而不是停在生成文件中的副本。

Remote API 方法本身使用 declaration map 导航。TypeRT 把 `InvocationModel.location` 固定在 Host 的 `remoteExport*` 方法名 token，并在 namespace interface 的对应属性上写入 source-map segment；TypeScript editor 从 `ctx.api.models.list` 取得生成 declaration 后，再沿 `typert.remote-client.d.ts.map` 跳到 Host Service 的 `remoteExportList` 远程出口。该出口继续显式调用不改名的存量 `list()`，map 不把 decorator、class 或整个签名误当成方法定义位置。

TypeRT 为同一 symbol key 生成 wire Zod codec。Host Gateway 用它校验输入和编码结果，Client API 可以用它编码参数并校验响应；复杂类型无法生成严格 codec 时，LIB 构建失败，不降级为 `unknown` 或无校验 JSON。

Remote 方法引用的命名业务类型必须从纯类型公共 subpath 导出。如果唯一可达入口会带入 Host Service、Cordis `Context` merge 或 Host-only 实现，构建失败并要求业务包提供安全的类型出口。原始值、字面量和 TypeRT 明确支持的简单组合不需要额外命名。

lookup 参数不会把 `Agent` class 暴露给消费端。Remote 投影引用 lookup 声明中的唯一 ID 类型，例如 `SessionId`；Host 内部仍以唯一的 `Agent` class symbol 完成对象解析。

## 三种产物与两个 TypeScript Program

Host 与 Client 仍然只有两个独立 TypeScript Program，但 TypeRT 生成三种性质不同的产物：

```text
Host Program
├─ typert.host.js / typert.host.d.ts
│  Host 自身的 Service、Event、Object、schema 和 inbound Gateway 信息
└─ typert.remote-client.js / typert.remote-client.d.ts / typert.remote-client.d.ts.map
   Host Remote 对任意消费环境的 wire 投影

Client Program
└─ typert.client.js / typert.client.d.ts
   Client 自身的 Service、Event、Object 和 schema 信息
```

`remote-client` 是 Host Program 的第二个 emitter，不是第三个 Program，也不是 Client 本地 face。它不包含 Host Cordis merge、Service class、Context class 或实现代码，不进入 Host 本地 reflection registry。

Host lib 构建负责完成严格 Host 分析并产出 Host 本地 artifact 与 Remote 消费端 artifact；Client lib 随后消费 Remote DTS。完整顺序为：

```text
Host lib build
→ 生成 typert.host.{js,d.ts}
→ 生成各业务包 lib/typert.remote-client.{js,d.ts,d.ts.map}
→ 完成 Client lib 和 typert.client 产物
→ Vite 构建 Web
```

现有顶层 `build` 仍表现为先 `build:lib`、再 `build:web`，但 `build:lib` 内部必须先完成 Host 与 Remote artifact，再启动 Client TypeScript 编译。一次干净构建不能依赖上次残留的 `.d.ts`。

## `/remote` 包入口

每个提供 Remote 方法的业务包导出生成的 `/remote` 子路径：

```text
"./remote": {
  "types": "./lib/typert.remote-client.d.ts",
  "default": "./lib/typert.remote-client.js"
}
```

消费代码通过业务包本身选择能力：

```text
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
```

该 import 让 `.d.ts` 的 map augmentation 进入当前 TypeScript project，同时把同一契约的 JS descriptor 作为值交给运行时。未 import 的业务包不会扩展当前 project 的 Remote API 类型。

业务 package 的发布文件必须同时包含 `lib/typert.remote-client.d.ts.map` 和 map 指向的 `src` 文件。生成 DTS 以 `//# sourceMappingURL=typert.remote-client.d.ts.map` 引用相邻 map；map 中的 source 从 `lib` 相对指向业务源码，例如 `../src/index.ts`。`/remote` export 不单独列出 map，package `files` 负责把它与源码一起发布。

仅需要静态类型时可以使用 `import type {} from '@deepseek-ai/dsh-goal/remote'`；这种 import 在运行时会被擦除，不会加载 JS，也不能触发任何运行时注册。需要真实调用的环境必须把普通 value import 得到的 contribution 交给 API Service。

workspace 对 `/remote` 的解析必须明确指向 `lib` 生成物，不能被通用 package-to-`src` paths 规则带回 Host 源码。普通业务 import 仍可按各环境既有规则解析到 SRC 或 LIB。

## 消费端严格 API 类型

Remote DTS 同时扩展平面 endpoint map、direct namespace interface、namespace map 和 scoped map，而不扩展全局 Cordis `Context`：

```text
interface TypeRTRemoteNamespace$676f616c73 {
  create: (
    agentId: SessionId,
    request: CreateGoalRequest,
  ) => Promise<CreateGoalResult>
}

interface TypeRTRemoteMap {
  'goals/create': (
    agentId: SessionId,
    request: CreateGoalRequest,
  ) => Promise<CreateGoalResult>
}

interface TypeRTRemoteNamespaceMap {
  goals: TypeRTRemoteNamespace$676f616c73
}

interface TypeRTRemoteContextMap {
  'agent:goals/create': (
    request: CreateGoalRequest,
  ) => Promise<CreateGoalResult>
}
```

`TypeRTRemoteMap` 保留规范 endpoint 签名，供协议类型和反射使用。根 API 类型直接读取 `TypeRTRemoteNamespaceMap`，不通过 key-remapped mapped type 间接推导方法；TypeScript Language Service 无法把这种间接属性稳定导航到 declaration map。namespace interface 名由 namespace 的 UTF-8 bytes 编成 hex，`goals` 因而稳定得到 `TypeRTRemoteNamespace$676f616c73`。不同 package 对同一 namespace 生成同名 interface，依靠 module augmentation 合并各自方法，且 `TypeRTRemoteNamespaceMap.goals` 始终引用同一类型。

TypeRT 把 `TypeRTRemoteContextMap` 按 Context key 投影到专用 Scope 类型。最终编程界面保持：

```text
api.goals.create(agentId, request)
agent.goals.create(request)
```

Agent Scope 自动提供自己的 `SessionId`。因此带 `agent` lookup 的 `@Remote` 方法可以同时生成 root 和 scoped 两种消费端签名；`@RemoteContext('agent')` 方法也省略独立的 Context identity，但只生成 scoped 签名。本期只有 Client Agent Context 获得 `goals`，Root Context 不获得该属性；未来 TUI 复用时必须维持相同的 Scope 限制。

`RemoteApi` 保持平台无关，Browser Client 把它作为自己的 `ClientApi`。未来 TUI 若复用该类型，也必须通过专用 API 对象和 Agent Scope 使用它，不能把 Host `Context` 当成更宽的 Service 集合；未标记的 public Service 方法不会进入 Remote maps。

## Client TypeRT 与 API Gateway Client face

一个消费环境的 TypeRT 同时维护本地信息和从其他环境导入的 Remote 信息，但两者存放在不同 registry：

```text
TypeRT.local    当前环境自己的反射模型
TypeRT.remotes  已导入的 Remote contribution
```

`@deepseek-ai/dsh-client-remotes/client` 集中加载需要的 Remote contribution：

```text
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import sessionsRemote from '@deepseek-ai/dsh-session/remote'

ctx.api.mount(goalsRemote)
ctx.api.mount(sessionsRemote)
```

Client 业务包只引用 `@deepseek-ai/dsh-client-remotes/client`，不直接依赖 Host API Gateway 或各业务 `/remote` 运行时入口。Client Remotes 自己依赖 Gateway Client face，并通过声明 re-export 把所选 Remote map 传给业务编译；新增或移除整套 Client 能力只修改这一处 assembly。

`ctx.api.mount()` 把 contribution 注册到 `TypeRT.remotes`，并由调用该方法的 Cordis fiber 持有 disposer。endpoint 重复、同一 namespace/method 模式冲突或 descriptor 与现有类型身份冲突时直接失败。

API Service 把 `@Remote` descriptor 实体化为根 `api` 上的真实函数。函数按 descriptor 的位置参数顺序构造具名 `args`，执行 Client strict codec，然后调用 `ctx.connection.rpc.call('/api2', endpoint, { args })`。

带 `scope` 的 direct descriptor 和 `@RemoteContext` descriptor 都不为每个 Agent Scope 复制函数。API Service 为每个 scoped namespace 建立一个 root singleton Cordis Service，并在该 Service 上实体化方法；Cordis tracker 在 `agent.goals.create()` 调用时把 Service 的 `this.ctx` rebind 到当前 Agent Context。方法再通过对应 Context binder 从 `this.ctx` 取得 identity。direct scoped 投影用 identity 替代 `scope.wire` 指定的 lookup 位置，Context descriptor 则把 identity 写入 receiver 的独立 wire 字段；两者都发起同一种 `/api2` 调用。

```text
root ctx.api.goals.create(agentId, request)
  → direct descriptor
  → ctx.connection.rpc.call('/api2', 'goals/create', { args })

agent.goals.create(request)
  → tracker 将 namespace Service rebind 到 agent Context
  → agent binder 从 caller Context 取得 agentId
  → 用 agentId 补入同一 direct descriptor 的 lookup 参数
  → ctx.connection.rpc.call('/api2', 'goals/create', { args })
```

Root `Context` 不 merge scoped `goals` 类型；只有 `AgentContext` 通过 `RemoteContextApi<'agent'>` 获得该属性。若调用方绕过类型从 Root 动态调用 scoped 方法，binder 明确报错。若 Client 已有同名 Cordis service，或两个 contribution 冲突占用同一 namespace/method，mount 直接失败，不覆盖现有服务。

生成的 Remote JS 只包含 descriptor、symbol key 和 codec，不打包 Host Service 实现。API Service 可以据此创建真实函数，因此本方案不依赖 JavaScript Proxy；Proxy 可以作为实现选择，但不会成为类型或反射来源。

## 跨环境同构约束

Remote API 是消费端能力，不等同于 Browser API。本期只实现 Browser Client 的 contribution 挂载、Connection RPC 调用和 Agent Scope 关联。

Remote DTS、Remote JS、`RemoteApi`、`InvocationDescriptor`、Remote RPC 数据协议和 Context binder 不得依赖 DOM、Browser module loader 或 HTTP。Browser Client 通过 Connection 把 descriptor 实体化的方法编码为 `/api2` RPC 调用。

未来 TUI 可以在不改变业务 decorator、Remote maps 和 API 调用形状的前提下接入同一调用抽象。届时 TUI 可见的 API 仍只能由 `@Remote` 和 `@RemoteContext` 生成，不能因为它与 Host 同进程就绕过 Remote 限制直接暴露 Service 方法。

TUI 的 runtime 挂载、carrier、Agent Scope 关联和 SRC 启动接线均不属于本期实现。

Web 本身依赖 `lib/client.js` 等构建产物，因此启动 Web 前要求完整 `build:lib`。Host Remote 契约变化后必须重新执行 lib build，再启动或重启 Web；本方案不在第一阶段实现 Remote contract 的增量 watch。

## SRC 与 LIB 运行模式

SRC 面向本地源码启动。`@Remote` 和 `@RemoteContext()` 的 WeakMap 记录给出方法名和调用模式，运行时从 JavaScript 函数签名读取顺序参数名，并结合已注册 lookup/Context provider 生成弱 descriptor。

例如 `@Remote('create') remoteExportCreate(agent, request)` 解析为外部方法 `create`、实现成员 `remoteExportCreate` 和两个顶层参数；lookup 注册把 `agent` 改写为 wire 字段 `agentId`，`request` 按同名 JSON 参数传递。SRC 不启动 `ts.Program`，不使用 preload、loader hook、源码生成或模块改写，也不检查普通 JSON 对象的内部结构。

SRC 无法明确解析的签名在 Service 挂载时失败。对象解构、默认参数造成的歧义、rest 参数、嵌套 lookup 和复杂类型不做猜测。

LIB 面向 CI、发布和 Web 前置构建。TypeRT 扫描完整 Host project，检查 Remote decorator、显式 binding、service key、endpoint 冲突、lookup/Context 声明、公共符号可达性、JSON codec 和结果 codec，并生成严格 descriptor。

LIB 运行时只加载 `lib` 中的 definition，不启动 TypeScript compiler。Host Gateway 后续的 Service 关联、lookup、Context 解析、调用和响应编码不区分 descriptor 来自 SRC 弱解析还是 LIB 严格生成。

CI 和发布运行 LIB。全仓 coverage 全部切换到 LIB 是独立后续工作，不阻塞本次直接方法调用实现。

## Host Gateway 注册

Host Gateway 同时观察 TypeRT Remote definition 和 Cordis Service 生命周期。当某个带 `typertGateway` facet 的 Service 与同 service key 的 definition 都可用时，Gateway 注册其 endpoint；两者到达顺序不影响结果。

Gateway 启动时先读取 TypeRT definition 和 Cordis reflection store 的当前快照，再订阅 registry change 与 `internal/service`。它按 service key reconcile definition、活 Service 和 binding；Service 被替换或 dispose 时撤销对应 endpoint。definition、lookup provider 或 Context provider 撤销时，依赖它们的 endpoint 立即不可调用，不保留失效对象或降级为原始 ID 调用。

普通 `@Remote` 调用保留原始 Service 实例作为 receiver。lookup 成功后，Gateway 按 descriptor 的参数顺序调用 `implementation ?? method` 指定的成员。

`@RemoteContext('agent')` 调用先由 Agent Context provider 解析 wire identity，再从该 Context 读取 descriptor 的 service key 并调用 scoped receiver。业务方法不会收到隐藏 Context 参数或 Agent ID。

```text
ctx.typertGateway.invoke({ namespace, method, args })
→ 查找本地 InvocationDescriptor 与 live receiver
→ 按参数 descriptor 读取具名 wire 字段
→ codec 解码普通值或 lookup ID
→ lookup provider 把 ID 解析为活对象
→ direct 使用原 Service；context 先解析 scoped Context 和 Service
→ Reflect.apply(receiver[implementation ?? method], receiver, orderedArgs)
→ result codec 编码业务结果
```

`ctx.typertGateway.invoke()` 是 carrier-independent 的 Host 入口。它不创建 rpcId、RPC envelope 或 HTTP response；它只返回编码结果，或产生由 Connection RPC adapter 映射的 Gateway 错误。

## `/api2` 调用链

`/api2` 是唯一 Connection/RPC 机制上的独立协议 channel，不是 Gateway 自建的 transport。Gateway 只向 Connection 注册一个本地 handler；本期在现有 HTTP Connection 中增加这项通用 channel 能力：

```text
ctx.connection.rpc.handle('/api2', (endpoint, payload) => {
  const { namespace, method } = parseEndpoint(endpoint)
  const { args } = parsePayload(payload)
  return ctx.typertGateway.invoke({ namespace, method, args })
})
```

Connection Host half 从唯一 HTTP Server 取得 handle，复用同一 RPC bridge、request/response envelope、rpcId、序列化、trust、transport error 和 `RpcError`。当前物理映射是：

```text
POST /api2/<namespace>/<method>
```

Remote payload 使用具名 JSON 对象，不使用位置数组，也不发送 `InvocationDescriptor`。普通 Goal 调用的 payload slot 是：

```json
{
  "args": {
    "agentId": "session-1",
    "request": {
      "objective": "finish the migration"
    }
  }
}
```

完整链路为：

```text
ctx.api.goals.create(sessionId, request)
→ Client InvocationDescriptor 编码 { args: { agentId, request } }
→ ctx.connection.rpc.call('/api2', 'goals/create', { args })
→ Connection 创建 rpcId 和既有 client-request envelope
→ 当前 carrier 发送 POST /api2/goals/create
→ Connection Host half 执行 trust、反序列化和 RPC 分发
→ /api2 handler 调用 ctx.typertGateway.invoke(...)
→ Host InvocationDescriptor 解码、lookup、receiver 解析和 Reflect.apply
→ result codec 编码
→ Connection 写入既有 RPC result 并回送相同 rpcId
→ Client result codec 验证并返回 CreateGoalResult
```

Remote 不定义第二层 `{ ok, value/error }` response。成功值和 Gateway 错误直接使用既有 RPC response 的 `result`；Gateway adapter 负责把 endpoint、schema、lookup、Context、Service 和业务调用失败映射为 `RpcError`，Connection 负责传输该错误。

Gateway 不处理逐方法权限、调用者身份、取消、幂等或长连接状态。本工作只扩展 Connection 的通用 channel 注册和调用能力，不改变现有 `/api`、trusted connection、trusted-host 或 privileged method 语义；Connection/WebSocket 迁移后续独立完成。

## Connection 与协议边界

API Service 负责 Remote contribution、方法实体化、Scope 绑定以及位置参数与 descriptor 的对应。Gateway 负责 Host descriptor、lookup、Context 和业务调用。Connection 只负责把 `/api2`、endpoint 和 `{ args }` 作为一个 RPC 调用发送到目标并返回既有 RPC result；它不理解 Goal、Agent、lookup、descriptor 或 Client API 类型。

`/api` 与 `/api2` 共享唯一 Connection、Server、RPC envelope 和连接生命周期，但保持协议隔离。Connection 从 HTTP 迁移到 WebSocket 时，`/api2` 从物理路径自然变成逻辑 channel；Remote payload、业务 decorator、生成的 DTS、Remote API 类型和 Agent Scope 编程界面都不变化。

## 包边界

- `@deepseek-ai/dsh-type-meta`：轻量 decorator、binding、lookup、Remote Context 和 descriptor 协议。
- TypeRT generator：分析 Host/Client Program，生成本地 face 和 Remote 消费端投影，并生成规范 symbol/Zod 信息。
- TypeRT runtime：分别保存当前环境的 local reflection 与导入的 Remote contribution。
- `@deepseek-ai/dsh-host-api-gateway`：默认入口关联 Host definition 与 Service，执行 lookup、Context receiver 解析、调用和结果编码，并向 Connection 注册 `/api2` handler；`/client` 入口挂载 Remote contribution，创建严格 API 方法，并把调用交给 `ctx.connection.rpc`。两个入口共享 Remote 协议，但不互相导入各自的 Cordis interface merge。
- `@deepseek-ai/dsh-client-remotes`：Client 业务唯一依赖的 Remote facade；直接依赖 Gateway Client face，选择 `/remote` contributions，并向业务包传递合并后的 API 类型。
- Connection：拥有唯一 HTTP Server/未来 WebSocket carrier、RPC envelope、rpcId、序列化、trust 和错误传输，同时承载隔离的 `/api` 与 `/api2` channel。
- Agent/Session 等业务对象包：拥有 lookup、Context provider、唯一 ID 类型和纯类型公共出口。
- 业务 Service 包：声明 binding、Remote 方法及其 request/result 类型，并导出生成的 `/remote` 子路径。

## 首期实现范围

第一条纵向链路实现 `@deepseek-ai/dsh-goal/remote → Browser Client API → Connection RPC /api2 → Host Gateway → GoalService.remoteExportCreate()`，并证明同一个带 Agent lookup 的 direct descriptor 同时支持 `ctx.api.goals.create(agentId, request)` 与 `agentCtx.goals.create(request)`。`@RemoteContext('agent')` 的 scoped receiver 语义继续保留为独立模式。

本期实现 Connection 的通用第二 channel API 及当前 HTTP carrier 映射，但不实现 WebSocket 迁移、TUI runtime、TUI carrier 或 TUI Agent Scope 接线。本 RFC 也不设计 Permission/Approval 状态机、Session 事件流、调用授权、取消、重试、幂等和跨版本协议兼容。

## Alternatives considered

**继续使用中央 API Proxy 包。** 该方案要求业务方法、Host 路由和 Client 接口在多个位置重复声明，也会继续把直接调用、带状态交互和事件流绑在同一生命周期中，因此不采用。

**让 decorator 在运行时完成严格反射。** JavaScript decorator 无法恢复擦除后的 TypeScript 类型、公共符号身份和完整 Zod codec；向 constructor 注入 compiler 私有 symbol 又会隐藏业务类的真实依赖，因此严格信息由 TypeRT compiler 生成。

**SRC 启动时使用 preload、loader hook 或完整 `ts.Program`。** 这能复用 LIB 分析，但增加所有源码启动入口的要求。SRC 只需要可用的弱 descriptor，因此采用 decorator 标记、函数参数名和显式 provider；严格检查留给 LIB contract pass。

**手写 Client interface。** 手写接口不能保证只包含 Remote 标记的方法，也会与 Host 签名、lookup ID 和 Zod schema 漂移，因此 Client 类型从 Host Program 自动投影。

**使用 TypeScript language-service/compiler plugin 让 Client 直接理解 decorator。** 这会让编辑器、Vite、tsc、tsx 和发布消费者都依赖额外插件，接入面过大，因此生成普通 `.d.ts` 和标准 declaration map。

**把完整 Host DTS 导入 Client 或 TUI。** 该方案会带入 Host Service 和 Cordis interface merge，并向消费端暴露未标记方法。Remote DTS 只引用纯类型公共符号并扩展专用 Remote maps。

**只生成 Remote DTS，不生成 JS。** 类型可以成立，但运行时无法枚举 endpoint、codec 和 Context 模式，只能依赖 Proxy 或另一份手写注册表，因此同一次 Host 投影同时生成 Remote JS contribution。

**让 `/remote` 的顶层 import 偷偷注册全局状态。** ESM 求值时未必已有目标 Cordis Context，多个 Context、HMR 和 dispose 也无法明确归属，因此普通 value import 只返回 contribution，由环境 assembly 的 API Service 显式挂载。

**为 Remote 新建独立 transport、HTTP route 和响应信封。** 这会复制现有 Connection 的 Server ownership、rpcId、序列化、trust、错误和未来 WebSocket 生命周期，并让两个 RPC 栈分别迁移，因此 `/api2` 作为独立协议 channel 复用唯一 Connection/RPC 机制。

## Acceptance criteria

- Goal Service 保留既有业务方法，在类末尾通过显式 `typertGateway` 和 `@Remote('create') remoteExportCreate(...)` 新增远程出口，不维护第二份路由、codec 或 Client 方法清单。
- 一次干净 `build:lib` 先生成 Host Remote contract，再完成 Host 和 Client 消费端编译，并在业务包 `lib` 下产生可通过 `/remote` 导入的 JS、DTS 和 DTS map。
- 导入 `@deepseek-ai/dsh-goal/remote` 后，消费 project 获得严格的 `api.goals.create(...)` 类型；不导入时该 namespace 不进入类型；从 `create` 跳转定义会通过 declaration map 到达 Host Service 的 `remoteExportCreate` 实现。
- Client assembly 挂载同一个 import 得到的 JS contribution 后，TypeRT 能反射 endpoint、参数、结果、lookup、Context 和 Zod 信息，API Service 无需手写 stub 即可创建调用方法。
- Remote DTS、Remote JS、`RemoteApi` 和 descriptor 协议不依赖 Browser 专属能力，且类型模型无法暴露未标记的 Goal Service 方法，为未来 TUI 同构接入保留边界。
- `agent.goals.*` 通过 Cordis tracker 和 Context binder 取得调用 Scope，Root Context 不获得 Agent-only 类型，且不为每个 Scope 复制函数。
- `/api2/goals/create` 能把 `agentId` 解析为唯一 Agent 对象，调用原始 Goal Service receiver，并通过既有 RPC result/error 返回结果。
- `/api2` 与 `/api` 共享唯一 Connection/RPC carrier，但保持协议隔离；Remote 不直接注册 HTTP Server handle，也不定义第二套 response envelope。
- Connection 提供通用 channel 注册和调用能力，并把 `/api2` 映射到当前 HTTP carrier；现有 `/api` 行为与 trust 语义保持不变。
- 现有 `/api`、Connection/trusted connection、Permission/Approval 和 Session 事件流行为不因本实现改变。

## Risks

Remote API 类型依赖生成的 `lib` 声明，构建编排必须在 Host 和 Client 消费端编译前完成 contract pass；顺序错误会让干净构建依赖陈旧产物。

源码导航依赖 Remote package 同时发布 declaration map 和 map 指向的 `src`。package `files` 漏掉任一侧时类型仍可编译，但消费端跳转会停在生成 DTS，因此 workspace manifest 校验必须把两者作为同一发布契约。

SRC 弱 descriptor 不验证普通 JSON 内部结构。Host Remote 签名变化后，Web 和严格类型消费者必须重新执行 lib build；第一阶段没有增量 contract watch。

公共类型唯一性要求业务 DTO 具有纯类型出口，可能暴露现有包中 Host 类型与实现入口混杂的问题。构建会拒绝这些边界，而不是复制类型掩盖问题。

类型 import 与运行时 contribution 是两种不同效果。`import type {}` 只扩展静态 API；真实调用环境遗漏 value contribution 时，API Service 必须以明确的“Remote 未挂载”错误失败。

Browser 与 Host 各自持有 Zod 实例，不能依赖对象 identity 跨 realm 比较；一致性只由规范 symbol key、同一生成模型和 wire 行为保证。

消费端可以导入 Host 当前未挂载的 Remote contract。类型表示“该协议能力已被消费端选择”，不保证目标进程当前存在对应 Service；运行时 endpoint 不可用必须明确失败。

Connection 的通用 channel API 必须同时适合当前 HTTP carrier 和后续 WebSocket carrier。若接口把 `fetch`、HTTP request 或 route handle 暴露给 Gateway/API Service，WebSocket 迁移会再次穿透 Remote 层，因此这些物理对象必须留在 Connection 内部。
