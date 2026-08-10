# Agent Note: Remote 事件投递（ctx.remote.$on）

Status: proposed

[English](2026-08-10-remote-event-delivery.md) | 中文

## 问题

[TypeRT Remote 方法调用](2026-08-02-typert-remote-method-calls.zh.md)只覆盖「一次请求一个结果」的定向调用，明确把 Session 事件流与有状态交互留在别处；Host 向消费端的**单向事件推送**因此仍然全部压在遗留的 API Proxy 上。

Host 上一族「注册表变了，重新拉一次」的纯失效事件（`commands/change`、`credentials/updated`、`settings/document-updated`）既不依赖 AgentScope、载荷也本来就是 JSON，却要穿过四跳才能到达一个 UI 订阅者：host cordis 事件 → apiproxy 手写 `HostFrame` 变体 + zod → client/runtime 手写桥 `ctx.emit(...)` → 消费者 `ctx.on(...)`。每加一个这类事件要改 5 处（帧联合、zod 联合、host 流监听、client 桥、client 侧重复的 `Events` 声明），而这 5 处没有一处是在陈述新事实——事件名、载荷类型、发射时机全都由 owner 包早已在 cordis `Events` 里声明过。

那份重复声明还是**有损**的：client 侧写成 `settings/changed(ns: string)`，brand 类型在这一跳被拍平成裸 `string`，与 Remote 方法侧「消费端类型指向业务包唯一符号」的既有契约相反。

## 提案

给消费端 Remote 面补一个单向事件订阅动词 `ctx.remote.$on(event, listener)`；**名单驱动、原样转发**：

- `packages/api/remotes/src/types.ts` 持有一份可转发 host 事件名单，它同时是「消费端能订阅什么」的唯一控制点。该文件**同时列进本包 host 与 client 两个 face 的 `files`**，两侧读同一份。
- wire 上的事件名 **就是 host cordis 事件原名**（`settings/document-updated`），不加 `host/` 前缀；载荷 **就是 host 的实参列表**，逐元素原样过 JSON，无投影、无脱敏、无改名。
- 载体**寄生现有 host 流**：`HostFrame` 加一个包裹帧 `host/remote-event`，不新开下行通道。
- 事件**签名**不另立表：owner 包把自己的 cordis `Events` 声明搬进 client-safe 的 `./types` 纯类型出口，两侧读**同一份**——`$on` 的 listener 类型就是 `Events[Event]` 本身。「原样」不需要证明，是构造性成立的。
- 但**只借 cordis 的类型形状，不接 cordis 的事件系统**：投递语义、注册表、异常处置全归 TypeRT 自己。

一条 `Events` 条目若签名里够到了 host-only 符号（Service、`Agent`、Context 等），处理方式是**把代码拆到能干净落进 `./types` 为止**；不接受「一半留 index、一半搬走」的分裂声明，也不接受在 `./types` 里造结构等价的影子类型。本次三个包都不需要拆：它们的条目只够到 `SettingsNamespace`、`SettingsUpdateSource`、`CredentialRef`，全是纯类型。

本次只迁**纯透传**的三条并删除对应 `HostFrame` 变体；带派生逻辑的一律不动：`host/models-changed`（`llm/adapters-updated` 与 provider/agent-default 命名空间过滤的 fan-in）、`host/workspace-changed`/`-removed`/`host/archived-sessions-changed`（需 view 派生 + 每连接 dedup 状态）、`host/session-added`/`-removed`/`host/session-status`/`host/agent-error`（需活对象投影或帧时派生字段）。

`skills/change`、`tools/change`、`system-prompt/change` 是同形状的纯失效事件但目前**没有任何消费者**，按「每个抽象都要有当前 owner 与需求」不进名单，只作为扩展位记录在此。

### 消费端契约（dsh-type-meta）

type-meta 加一个**形状谓词**、一个**选择座位**和 `TypeRTClientRemote` 的**一个**成员；零运行时代码：

```ts
/** 形状上可以单向远程投递的 cordis 事件名：不绑 Scope，且返回 void。 */
export type TypeRTForwardableEvent = {
  [Event in keyof Events]: unknown extends ThisParameterType<Events[Event]>
    ? ReturnType<Events[Event]> extends void ? Event : never
    : never
}[keyof Events]

/** Host 装配声明的转发选择；由 api/remotes 的名单一次性填满，其他包不填。 */
export interface TypeRTRemoteEventSelection {}

/** `$on` 的合法键：被选中且当前编译面确实存在的事件。 */
export type TypeRTRemoteEvent = Extract<keyof Events, keyof TypeRTRemoteEventSelection>
```

```ts
/** 订阅一条被转发的 host 事件；返回的 disposer 归调用方 fiber。 */
$on<Event extends TypeRTRemoteEvent>(event: Event, listener: Events[Event]): () => void
```

`Events` 按程序解析：host 程序里是 host 事件全集，client 程序里是 client 编译面看得见的那些——同一个谓词在两侧各自成立，不需要把 host 声明拖进 client。

**消费端只有 `$on`，没有 `$dispatch`。** 帧到订阅表的投递口不进开发者可见契约，也**不能**是一个跨插件的模块级函数：client bundle 纯度门禁（`packages/client/tsdown.client.ts`）只放行 `CLIENT_EXTERNALS`、`INLINE_SAFE` 那层 wire 契约与 `/remote` 生成物三类值导入，而靠 inline 绕过会把 `ClientRemoteService` 复制一份进 runtime bundle、令 `instanceof` 恒假。

投递口因此是**一条客户端内部 cordis 事件**，声明在 `dsh-type-meta`（两侧共用的单 face 包，runtime 本来就依赖它，所以零新增依赖）：

```ts
'remote/host-event'(event: string, args: readonly unknown[]): void
```

持有 host 帧 sink 的 client/runtime 发射它，`ClientRemoteService` 是唯一订阅者并转成 `$on` 回调（`dispatch` 是私有方法，不进 `TypeRTClientRemote`）。这是仓内既有的跨插件 plumbing 形态——`connection/reset` 就是 runtime 声明+发射、`ui-command` 订阅，并有 `runtime/tests/wire-events.spec.ts` 钉住。`event` 形参是 `string` 而非 `TypeRTRemoteEvent`：这是 wire 边界，收到无人订阅的名字即静默丢弃。

投递语义与 cordis 事件系统不共用实现：只有单向投递，没有 waterfall / bail / parallel / serial 模式，也没有 `@mode` 概念（`ReturnType extends void` 是这条纪律的静态表达）；不绑 `this`；没有 `EventOptions`、`prepend`、优先级；按注册顺序逐个调用，单个 listener 抛错就地隔离并记日志——它绝不能拖垮帧泵（沿用 `ConnectionController` 对 sink 异常的既有处置）。

### 名单：两个 face 共读的一个文件

`packages/api/remotes/src/types.ts` 同时列进 `tsconfig.host.json` 与 `tsconfig.client.json` 的 `files`，是名单的**唯一家**：

```ts
export const API_REMOTE_FORWARDED_EVENTS = [
  'commands/change',
  'credentials/updated',
  'settings/document-updated',
] as const

export type ApiRemoteForwardedEvent = typeof API_REMOTE_FORWARDED_EVENTS[number]

declare module '@deepseek-ai/dsh-type-meta' {
  interface TypeRTRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true> {}
}
```

于是**加一个事件只改这一行数组**：类型投影、`$on` 的键面、host 的转发循环全部从它派生。`ctx.remote.$on('slots/changed', …)`（client 本地事件）或 `$on('skills/change', …)`（名单没开）都是**编译错误**。

host 半再加一处形状断言，把 host 事件词汇的约束落到同一份名单上：

```ts
API_REMOTE_FORWARDED_EVENTS satisfies readonly TypeRTForwardableEvent[]
```

写成表达式语句而不是命名常量：后者会被 `noUnusedLocals` 判为未使用（下划线前缀只豁免参数）。它卡住三件事：**名字合法**（谓词以 `keyof Events` 为基）、**不绑 Scope**（`goal/changed` 那族的 `ThisParameterType` 不是 `unknown`，被排除——「不依赖 AgentScope」的静态表达）、**单向**（非 `void` 返回的 waterfall/bail 形状被排除）。

**「原样」不在任何地方证明，而是构造性成立**：`$on` 的 listener 类型取自 owner 包 `./types` 里那一份 cordis `Events` 声明，host 转发读的是同一份，不存在可以彼此偏离的第二份声明。

载荷 JSON-safe 交给运行时：apiproxy 转发前用 `dsh-session` 的 `isJsonValue` 逐元素校验，不合格**抛错 fail loud**（这是名单配置错误，不是外部输入）。

### 线协议（apiproxy）

```ts
| { type: 'host/remote-event'; event: string; args: JsonValue[] }
```

zod 侧 `args: z.array(z.unknown())`：帧本身来自 `JSON.parse`，元素必然已是 JSON 值，结构契约由 owner 包的 `Events` 声明承担——与既有 `session/projection` 帧的 `value` 同 posture。

`events.host()` 打开时按名单挂监听（host 流每条自持 disposers，无需新增广播集合）。**注册位置是契约的一部分**：这段必须挂在 `settings/document-updated` 监听**之前**。cordis 按注册序触发，而 `host/models-changed` 是由同一条 host 事件**派生**出来的失效帧——转发帧排到派生帧之后会让同一次 emit 的两帧顺序相对改动前颠倒（已被两条 config 用例实测到）。规则：**转发帧必须先于由它派生的失效帧**。

cordis `on` 的键是字面量泛型，按动态名单订阅必须在此擦除一次 handler 类型；这是本变更唯一的类型断言点，其安全性由名单谓词与 `isJsonValue` 校验共同承担。

`api/events.ts` 是浏览器侧也要编译的 wire 契约文件，所以它引用的每个类型都必须走 owner 包的 **client-safe type-only 子路径**，绝不能走包根出口。实证：从 `@deepseek-ai/dsh-session` 根引一个类型，就把根出口的 `declare module 'cordis' { interface Context { sessions: SessionStore } }` 拖进 client 编译面、把 client 的 `ctx.sessions: ISessions` 顶掉，在完全无关的 `ui-slash` / `ui-conversation` 里炸出 18 条错。`JsonValue` 因此需要 `dsh-session/src/types.ts` 补一条 re-export。

### apps/web 的 browser e2e 属于 Host 面

`apps/web/tests/**` 那批 e2e 在**根 `tsconfig.host.json`** 做类型检查：它们在进程内起真 harness、直接摸 `ctx.apiProxy`、host `SessionStore.get/create/flush`、`ctx.sessionProjectionCache`。**运行时用浏览器 ≠ 类型上属于 client 程序**——把它们搬进 client 聚合会立刻报 21 条错，因为一个 program 装不下两个 face 对同一个 Context key 的合并。

由此得到一条对本设计要紧的连带纪律：**这些测试从客户端包 import 值或类型，会把该包的整个 project——以及它引用的每个 project——拖进 Host 构建图**。`ui-settings-general`/`ui-models`/`ui-permission`/`ui-command` 四个消费者 references `api/remotes` 的 client face，而该 face 必须等 host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 才能编译，于是形成构建期死锁：host tsc → api/remotes client face → `goal/remote` → host tsdown → 排在 host tsc 之后。

本次的处置是在测试侧**镜像**所需的客户端符号（`scaffold.ts` 导出镜像后的 welcome-notice 常量，两个 chat e2e 直接引 `dsh-client-runtime/client` 因为 `runtime` 工程本来就在 host 图里），从而让那 4 个消费者离开 host 图；`apps/cli/tsconfig.json` 里 15 条 client 工程引用随之失去 owner-map 职责，一并删除。镜像值与源逐字一致，漂移的表现是选择器失配或通知未被抑制，都是响亮失败。

### 改动清单

| 位置 | 改动 |
|---|---|
| `dsh-type-meta` | `src/types.ts` 加 `TypeRTForwardableEvent`、`TypeRTRemoteEventSelection`、`TypeRTRemoteEvent` 与 `'remote/host-event'` 声明；`TypeRTClientRemote` 增 `$on`。纯类型，零运行时 |
| `api/gateway` client 半 | `ClientRemoteService` 实现 `$on`（订阅表、`ctx.effect` 归属调用方 fiber、按注册顺序派发并隔离 listener 异常）+ 订阅 `'remote/host-event'`，`dispatch` 保持私有 |
| `api/remotes` | 新增 `src/types.ts`（名单 + 类型投影 + 选择座位），双列进两个 face 的 `files`；`./types` 出口 + `files` 补 `lib/types/**/*.js`；host 半加形状断言并 `import type {}` 三个 owner 包的 `./types`；client 半 `export type {}` 那三个 `./types` 与 `@deepseek-ai/dsh-api-gateway/client`；`./invariant` 断言名单内事件的运行期关系（`thisArg === null` + `mode === 'emit'`） |
| 根 `tsconfig.base.json` | 加 `dsh-settings/types`、`dsh-credentials/types`、`dsh-api-remotes/types` 三条 `paths`，全部指向**源**平面 |
| `dsh-commands` / `dsh-settings` / `dsh-credentials` | `interface Events` 子块移入各自 client-safe 的 `./types`（settings/credentials 新建该出口，brand 与纯类型一并移入，index 继续 re-export 并留住构造器；`files` 补 `lib/types/**/*.js`） |
| `host/apiproxy` | `HostFrame` 增 `host/remote-event`、删 `host/commands-changed`/`-settings-changed`/`-credentials-changed` 三变体及其 zod；`events.host()` 按名单挂监听（位置在 `settings/document-updated` 之前）+ `assertJsonArgs`；`settings/document-updated` 监听保留以继续喂 `host/models-changed` |
| `dsh-session` | `src/types.ts` 补 `export type { JsonValue }`，让 wire 契约文件能走 client-safe 子路径 |
| `client/runtime` | 桥里三条 `ctx.emit` 换成一行 `ctx.emit('remote/host-event', frame.event, frame.args)`；`Events` 声明删 `commands/changed`/`settings/changed`/`credentials/changed`（`models/changed` 保留） |
| 5 个消费者 | ui-command / ui-models / ui-settings-general / ui-permission / ui-agent-preset 改订 `ctx.remote.$on(...)`；照 `ui-goal` 先例 type-only 引 `@deepseek-ai/dsh-api-remotes/client` 并把 `'remote'` 加进 `inject` |
| `client/connection` | fixture 的 `emitHost` 造 `host/remote-event` |
| `apps/web/tests` + `apps/cli` | 客户端符号镜像（见上节）；`apps/cli/tsconfig.json` 删 15 条 client 工程引用 |

## 备选方案

**给 Remote 事件新开一条通用下行通道**（`ctx.connection.rpc` 的推送对偶，第三条 WebSocket）。最符合「Connection 独占载体、Gateway 不碰传输」；但要同时改 host 下行、`WebApiClient`、`ConnectionController`、fixture 与 web e2e 各一条流，代价与本次收益不匹配。寄生 host 流的代价是新契约暂时寄居在 legacy 帧联合里——host 流将来整体搬家时它随之搬走，消费端契约不变。

**在 type-meta 立一张独立的 `TypeRTRemoteEventMap`，让 owner 包 declare-merge 进去**。消费端键集会精确等于「被声明为可远程投递的事件」；代价是每条事件的签名要在 cordis `Events` 之外**再写一遍**，于是需要一条双向 `extends` 的等价性证明来防漂移，还要给三个 owner 包新增 type-meta 依赖。共用同一份 `Events` 声明让等价性变成构造性成立，这张表因此不立。

**让 typert generator 从 host `Events` 声明生成事件投影**（codec + `.d.ts` + 声明映射，与 `/remote` 同族）。generator 已经在分析 host 事件；但它拿不到投影与脱敏语义，且要动生成器与构建面。原样转发这条路本就不需要投影。

**给可转发事件加载荷投影函数**（`{ 事件名, 投影, zod }` 转发表）。能一举覆盖 `models-changed` 的 fan-in 与 workspace 的 view 派生；代价是投影逻辑与载荷类型手工对齐，回到方法侧刚刚消灭的中心表形态。

**把 apps/web 的 browser e2e 搬进 client 聚合**。看似「客户端测试归客户端面」，实测立刻 21 条错：它们用 host 服务，而 client 程序里 `ctx.sessions` 是 `ISessions`。已否。

**给 `directory-picker-browse`/`-native` 做 host/client 双 face 切分**，从根上让客户端包不进 host 图。方向正确（它们确实是未切分的双半包），但与本单的 capability seam 是两件事，且改动落在别人属地——记为独立后续单。

## 验收标准

- host emit 三条事件后，真实 host 流各出一帧 `host/remote-event`，`event` 为 host 原名、`args` 与实参逐元素相等（真组合测试）。
- 名单在类型层拒绝三类候选：不存在的事件名、绑 Scope 的事件（`goal/changed`）、非 `void` 返回的事件。
- `$on` 的键面等于名单：`$on('slots/changed', …)` 与 `$on('skills/change', …)` 都必须编译失败。
- `TypeRTClientRemote` 上**不存在** `$dispatch`：开发者可见契约只有 `$on`（加既有 `$mount` 与生成的 namespace）。
- 名单内事件发射非 JSON-safe 实参时，`assertJsonArgs` 抛错而非静默降级（对该函数直接单测，不从事件总线造畸形 emit）。
- `ctx.remote.$on` 的 disposer 归属调用方 fiber：处置 fiber 后订阅消失。一个 listener 抛错不影响同事件其余 listener，也不中断后续帧投递。
- 转发帧与由同一条 host 事件派生的失效帧在同一次 emit 里的顺序与改动前逐帧一致。
- 消费端 `$on('settings/document-updated', …)` 的 `ns` 形参解析为 `SettingsNamespace`（brand 未丢）。
- 三条 `HostFrame` 变体、client 侧三条 `Events` 声明、client 手写桥的三条分支在同一 PR 内消失；`host/models-changed` 行为不变。
- `pnpm run build` 全量通过。

## 风险

- **寄生 legacy 帧联合**：新契约暂时住在 apiproxy 的 `HostFrame` 里，读者会误以为 Remote 事件归 apiproxy 拥有。缓解=帧注释指明名单归 `api-remotes`，并在 apiproxy README 的已知欠账里记这条寄居关系。
- **共享文件破了 api/remotes 的 face 互斥契约**：`src/types.ts` 同时属于两个 project，两侧各自 emit 一份同名声明到共用的 `lib/types`。内容逐字相同、`.tsbuildinfo` 各自独立，实际无害，但 README 的 Build boundary 节必须写明这条例外及其成因（paths 指向 src）。
- **任一 client 插件都能 `ctx.emit('remote/host-event', …)` 伪造一条 host 事件**：与 `connection/reset` 可被伪造成重连同一量级（client 是单一信任域）。测试只钉「事件到 `$on` 的转换」，不假装它有来源鉴别。
- **名单的形状断言当前处于注释态**（`packages/api/remotes/src/index.ts`，连同它所需的名单 import 与三条 owner `./types` 的 `import type {}`），因此本节描述的三条静态保证暂未生效：此刻往名单里塞一个 scoped 事件或拼错的名字不会有编译错误。恢复它对构建图无影响（那四个消费者已不在 host 图里），是 PR 前必做项。
- **测试侧的镜像会漂移**：`apps/web/tests` 里镜像的客户端常量与源之间没有机械校验，只能靠「漂移即选择器失配」这种响亮失败兜底。理想上该加一条 grep 级门禁禁止 `apps/web/tests` 引入 `@deepseek-ai/dsh-client-*`，本轮未加。
- **动态订阅的类型擦除**：按名单 `ctx.on(name, …)` 必须擦一次 handler 类型；若名单谓词将来被放宽，这处断言就不再有静态支撑。
- **放弃的能力**：不支持带载荷投影/脱敏的事件、不支持 Scope 化事件（`agentCtx.remote.$on`）、不支持重连重放（纯失效信号，重连后的重新拉取由既有 `connection/reset` 覆盖）。mux 流的 session 事件、可答帧与快照基线不在范围内。
- **host 图里仍有客户端包**：`connection`、`runtime`、`ui-slots` 等 12 个工程经 `directory-picker-browse|native`（未切分的双半包）与 `api/gateway → client/connection` 仍在 host 构建图内。它们当前都能编译、且不再牵连 api/remotes 的 client face，所以不阻塞；根治留给上面那条独立后续单。
