# API Gateway

[English](api-gateway.md) | 中文

本文是 TypeRT API Gateway 的当前状态参考。它描述业务 Service 如何声明一元 Remote 方法、构建如何生成 Host 与 Client 契约，以及调用如何复用 Connection 的 RPC 与 `/api` 路由。会话事件、增量数据和其他流协议不属于本文范围；它们可以使用同一个 Connection，但不使用 Remote 方法描述符。

## 编程模型

业务 Service 通过 `@Remote` 或 `@RemoteScope` 选择对 Client 开放的方法。未标记的方法不会进入生成的 Client 类型或运行时贡献，也不能通过 `ctx.remote` 调用。

`@Remote` 表示调用根 Host Context 中注册的 Cordis Service。复杂的 Host 对象不能直接跨 wire 传输；业务包必须通过 `TypeRTLookupMap` 声明它与 wire identity 的关联，并在运行时向 `ctx.typert.lookups` 注册默认解析提供方。例如 `Agent` 参数在 Host 签名中名为 `agent`，生成的 wire 字段为 `agentId`，Gateway 在调用业务方法前将 id 解析为 Host 对象。Host 组合可以用 `ctx.typert.lookups.configure()` 覆盖某个 lookup key 的解析策略，而不改变业务包拥有的参数名、wire 字段或规范类型 symbol。

`@RemoteScope(key)` 表示先通过 `ctx.typert.contexts` 把 identity 解析为一个作用域 Context，再从该 Context 取得 Service 并调用方法。它适用于方法本身依赖作用域组合、而不需要显式接收 `Agent` 等对象的情形。

Service 通常继承 `GatewayService`，让 Cordis service key 与默认 Remote namespace 在构造器中显式绑定。已有其他基类的 Service 可以改为声明 `readonly typertGateway = bindTypeRTGateway(this, serviceKey)`；两种方式都会留下可检查的公开 binding，不依赖编译器向构造函数注入 symbol。

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import { GatewayService, Remote, RemoteScope } from '@deepseek-ai/dsh-type-meta'
import type { Context } from 'cordis'

export interface CreateGoalRequest {
  objective: string
}

export interface CreateGoalResult {
  accepted: boolean
}

export class GoalService extends GatewayService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote('create')
  createForClient(
    agent: Agent,
    request: CreateGoalRequest,
    signal: AbortSignal,
  ): CreateGoalResult {
    signal.throwIfAborted()
    return this.create(agent, request)
  }

  @RemoteScope('agent', 'current')
  currentForClient(): CreateGoalResult {
    return { accepted: true }
  }

  private create(_agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    return { accepted: request.objective.length > 0 }
  }
}
```

Remote 方法可以同步返回或返回 Promise。若需要协作式取消，Host 签名的最后一个参数必须是全局类型的 `signal: AbortSignal`；它记录在描述符中而不是进入 `args`，Client 生成的方法则接受最后一个可选的 `AbortSignal`。

Client 使用普通对象上的具体函数，不使用 JavaScript Proxy。直接调用与作用域调用分别出现在 `ctx.remote.<namespace>` 和 `agentCtx.remote.<namespace>`。每个 namespace 都是注册为 `remote.<namespace>` 的可追踪 Cordis 子 Service；Client assembly 通过 `ctx.remote.$mount()` 挂载贡献，消费方同时注入 `remote` 与所调用的 namespace Service，最后一个方法撤回后该 namespace 随即卸载。当一个 `@Remote` 方法恰好有一个 lookup 参数、且同名 `TypeRTContextMap` 使用相同 wire identity 时，生成的作用域签名会省略该 identity 参数。`@RemoteScope` 只生成作用域调用界面。

```ts
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

declare const ctx: Context
declare const agentCtx: AgentContext
declare const agentId: SessionId

await ctx.remote.goals.create(agentId, { objective: 'ship it' })
await agentCtx.remote.goals.create({ objective: 'ship it' })
```

Client 应用只装配 `@deepseek-ai/dsh-api-remotes`。该包以运行时值导入被选业务包的 `/remote` 子路径，通过 `ctx.remote.$mount()` 挂载贡献，同时重新导出相同文件中的声明合并。增加一个 Host Remote 包是 Client 组合所有者的显式选择；业务组件不需要分别加载 TypeRT Gateway 或业务包的 Remote JS。

未来的 TUI 可以装配同一个不依赖 React 的 `api-remotes` 与 `ctx.remote` 契约，因此它能看到的 Host 方法同样只限于生成时选择的 Remote 方法。本文不定义或实现 TUI 组合。

## 组件职责

| 位置 | 包或入口 | 职责 |
|---|---|---|
| 共享 | `@deepseek-ai/dsh-type-meta` | 声明 decorator、Gateway binding、可合并协议映射、调用描述符及提供方类型；不启动 TypeScript 分析，也不注册 Cordis 服务 |
| 构建 | `@deepseek-ai/dsh-typert-generator` | 从 Host `ts.Program` 严格分析 Remote 签名、类型图、lookup、Context 与源码位置，并生成 Host 和 Host-for-Client 产物 |
| Host | `@deepseek-ai/dsh-typert-registry` 与 Loader | 把生成的 Host 描述符、schema 及业务包注册项放入 `ctx.typert`，并持有 lookup 与 Context 提供方 |
| Host | `@deepseek-ai/dsh-api-remotes` | 负责应用的 Agent/Session 身份策略，并配置对应的 TypeRT lookup |
| Host | `@deepseek-ai/dsh-api-gateway` | 提供 `ctx.typertGateway`，认领 Remote endpoint，解析对象或 Context，调用实时 Cordis Service 并校验边界 |
| Client | `@deepseek-ai/dsh-api-gateway/client` | 提供 `ctx.remote` 与 `remote.<namespace>` 子 Service，把生成的描述符挂成具体方法，并通过 Connection 发起、校验和取消调用 |
| Client | `@deepseek-ai/dsh-api-remotes/client` | 显式选择并挂载本应用允许使用的 `/remote` 贡献，向业务代码带入对应的声明合并 |
| 双侧 | `@deepseek-ai/dsh-client-connection` | 提供 RPC carrier、请求关联、信任边界、取消、响应 envelope 与当前 `/api` HTTP bridge |

API Gateway 包同时拥有 Host dispatcher 与 Client Remote endpoint 两个对等入口，但两侧构建不会进入同一个 `ts.Program`。Host 入口不导入 Client 的 Cordis `Context` 合并，Client 入口也不导入 Host Gateway 服务。

## 严格生成链路

根构建按 `build:lib:host`、`build:lib:client`、`build:web` 排序。Host lib 构建首先运行 `build:lib:contracts`：它先编译 TypeRT generator，再通过 `tsdown.typert-host.config.ts` 以 `tsconfig.host.json` 为种子启动 Host `ts.Program`。生成器不会把 Host 与 Client 聚合放入同一个 program，因而不会触发两侧 Cordis `Context` 声明合并冲突。

每个贡献业务包把生成文件写入自己的 `lib/`，而不是源码目录：

| 文件 | 消费方 | 内容 |
|---|---|---|
| `typert.host.js` | Host Loader | Host face 的运行时反射、严格调用描述符和 schema 注册值 |
| `typert.host.d.ts` | Host 类型系统 | Host face 的生成声明 |
| `typert.remote-client.js` | `api-remotes` | 可挂载的 `TypeRTRemoteContribution`，包含严格描述符与运行时 codec |
| `typert.remote-client.d.ts` | Client 类型系统 | `TypeRTRemoteNamespaceMap` 与 `TypeRTRemoteScopeMap` 的声明合并及 Client-safe 类型引用 |
| `typert.remote-client.d.ts.map` | 编辑器 | 将生成的方法属性映射回 Host 包中的 Remote 方法声明 |

业务包通过 `./typert` 暴露 Host Loader 入口，通过 `./remote` 暴露 Host-for-Client 入口。生成器同时校验这些 package export 及发布文件清单；只有具备相应入口的显式贡献包才会生成产物。

Remote Client 声明中的参数名来自 wire 字段，参数和返回类型则引用原业务包导出的 Client-safe 类型。声明 map 把 `ctx.remote.goals.create` 最终解析到的生成属性映射到带 `@Remote` 的 Host 源方法，因此支持 declaration-map 的编辑器可以从 Client 调用跳到真实实现，而不是停在生成的 `.d.ts`。

严格分析要求 Remote 是公开、非静态、有具体实现的实例方法。方法不能是泛型；参数必须是具名且必填的简单标识符，不能使用解构、默认值、rest 或可选参数。可 JSON 表示的普通类型由 TypeRT 生成严格 schema；工作区 class 等复杂对象必须具有唯一的 `TypeRTLookupMap` 声明。lookup 与 Context 包同时负责静态声明合并和运行时提供方注册，缺少任一侧都会在构建或最早可解析的运行时边界报错。

## 运行时调用

当前 Remote 与 API Proxy 共用 Connection 的 `/api` 路由，不存在独立 `/api2` server 或第二套 Connection。Client Remote 调用 `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)`；当前 HTTP carrier 对应 `POST /api/<namespace>/<method>`，payload 只包含一个具名 `args` 对象。

Connection 在 HTTP bridge 之前执行 `/api` 的统一信任检查，再在共享 FetchHandler 内按 interceptor 顺序分发。TypeRT Gateway 只认领存在严格描述符或活跃 SRC marker 的两段式 endpoint；未认领的请求回退到既有 API Proxy。Connection 拥有传输、RPC id、响应 envelope 和 request cancellation，Gateway 只拥有 Remote 数据协议和业务分发。未来替换 Connection carrier 不要求改变 Remote 描述符或 Client 编程界面。

Gateway 每次调用都从当前注册表解析描述符和实时 Service，不缓存业务对象。它要求 `args` 的字段集合与描述符完全一致，先用 codec 校验 wire 值，再通过注册的 lookup 或 Context provider 解析对象或接收者，最后调用 binding 指向的 Service 方法并校验返回值。缺少 provider、identity 未命中、binding 不一致、参数多缺、schema 失败和方法不存在都在进入或离开业务边界时失败。

lookup provider 的 `register()` 同时提供稳定声明和默认 resolver；`configure()` 提供由 Host 组合拥有、可异步执行且受 effect 生命周期约束的 resolver。配置可以先于 provider 挂载；没有 provider 时调用仍以 `lookup-unavailable` 失败，配置卸载后则恢复 provider 默认策略。API Remotes 负责 `agent` 与 `session` 的标准 `agentFor()` 语义：复用 live Agent，自动恢复普通冷会话，对并发恢复去重，并拒绝由 subagent routing 拥有的 identity；`session` lookup 返回该 Agent 的 Session。Web API Proxy 提供 Agent 默认值与 scope 设置，再让旧方法使用同一个 resolver。恢复失败和 ownership fence 通过既有 RPC error 原样返回，不折叠为 Gateway 的 `internal` 错误。

Client 卸载一个贡献时会一起移除描述符和具体方法，中止其进行中的调用，并使外部仍持有的旧方法句柄拒绝继续调用。Host 上已经注册过的严格 endpoint 被撤回后也不会降级到 SRC 推断，以免热卸载悄然降低校验强度。

## SRC 开发回退

Host 通过 `node --import tsx/esm` 从源码启动时不会执行 TypeRT 编译插件。标准 decorator 初始化器仍会把方法名和调用模式记录到模块私有 `WeakMap`，`GatewayService` 或 `bindTypeRTGateway()` 则提供显式 service binding；Gateway 因而可以在不启动 `ts.Program` 的情况下构造一个较弱的临时描述符。

SRC 回退从运行中函数解析简单参数名。参数名与某个已注册 lookup 的 `parameter` 相同，例如 `agent` 或 `session`，就使用其 `agentId` 或 `sessionId` wire 字段并在 Host 解析对象；其他参数只检查值是否为无循环、无特殊 prototype 的 JSON-safe 数据。`@RemoteScope` 直接使用已注册 Host Context provider 的 wire 字段。SRC 不读取 TypeScript 类型，不生成 Zod schema，不推断可选参数，也不支持解构、默认值、rest 或重复参数名。

SRC 只解决 Host 源码进程的分发问题。Client 不会从运行中的 Host 发现 decorator，Client Remote 也拒绝挂载缺少严格 codec 的 SRC 描述符；其类型、codec 和 Remote 注册值始终来自最近一次生成的 `lib/typert.remote-client.*`。

## 开发模式

完整构建会先生成 Host 契约，再编译 Host、Client 与 Web，因此是建立或刷新所有产物的确定性入口：

```sh
pnpm run build
```

Web 开发通常在完成一次构建后启动源码 Host，并在另一个终端运行 Client plugin watcher：

```sh
pnpm run dsh -- web --dev
pnpm run dev:web
```

`dsh` 通过 tsx 启动 Host 源码，所以 Host 可以使用 SRC 回退；`dev:web` 只监听带 `dshClient` 声明的 Client plugin 并重写其 `lib/client.js`，它不会分析 Host decorator，也不会生成 Remote Client DTS。

只修改 Remote 方法实现体而不改变契约时，无需重新生成 TypeRT 文件。新增或删除 decorator、修改导出名、namespace、参数、返回值、lookup、Context 或取消签名时，先重新生成严格契约，再让 Client bundle 使用新的产物：

```sh
pnpm run build:lib:contracts
```

运行中的 Client watcher 会在重新打包时消费这些生成文件；没有 watcher 时运行 `pnpm run build:lib:client`。仅重新编译前端源码不能从 Host decorator 推导新类型。`pnpm run typecheck` 自带 `build:lib:contracts` 前置步骤，CI 与发布构建也使用严格生成链路。

## 边界

Remote 只处理有单个请求与单个结果的一元方法调用。Session event stream、分页、增量 reduce、projection 和实体子流需要独立的数据协议与注册模型；即使它们复用 Connection，也不应伪装成 Remote 方法或放入调用描述符。

API 各层按 `remotes → gateway → connection → webserver` 组织。BFF 与 TypeRT RPC 层位于 `packages/api`；Connection 与 WebServer 仍位于 `packages/client/connection` 和 `packages/host/webserver`，其服务契约允许未来只移动包，将它们放到 `packages/api`。旧 API Proxy 仍位于 `packages/host/apiproxy`，作为尚未迁移到 Remote 的 endpoint 的回退路径。

当前 lookup 策略按 key 配置，因此所有 `agent` 或 `session` 参数共享冷恢复行为。某个 Remote endpoint 若必须只接受 live 对象，需要后续增加显式的逐参数或逐 endpoint 策略，不能通过业务方法内部猜测恢复来源。
