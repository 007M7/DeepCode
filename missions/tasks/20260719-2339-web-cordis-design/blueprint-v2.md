# web-cordis 蓝图 v2（用户口述定稿外化）

> 2026-07-20。本蓝图与 design.md（旧设计）冲突处**以本文为准**，旧文后续按此重写。与旧文的推翻/保留关系见文末对照表。
> 命名裁决：web-cordis 相关配置与命名**一律用 client，不用 browser**（入口名、program、Loader 等全部 client 措辞）。
> 入口形态修正：**不做 `./node` 入口**——node 半边就是各包现有的 index 主入口（`"."`），不干涉存量；双端包只**新增**两个子路径。

## 1. 双端包入口：主入口 + 新增 client/shared

一个 npm package 的双端形态 = 现有主入口 + 新增两个子路径：

| 入口 | 内容 |
|---|---|
| `"."`（主入口，即现有 index） | 插件 node 半边——存量不动 |
| `./client`（新增） | 插件 client 半边 |
| `./shared`（新增） | 双边通信类型（双向 RPC 方法声明住这里） |

package.json `exports` 写清楚；**构建规范强制**——导出信息、入口形态都定死，不留每包自由发挥。

## 2. 类型宇宙强隔离（必须拦住）

client 的 TS program **不得看见** node 侧对 cordis Context 的 interface merge——client context 上只能看到 client 自己挂的 service。

- 这是**理论正确方式**，必须做到，不是 review 红线级的口头约定。
- 拦截在**编译期**：file-set 不相交的 program / gate 脚本等，工程方案待定。

## 3. client 挂什么 service

暂无倾向，可能都先不挂；cordis 本身基建（timer 等）先挂着。旧 design.md §B.1 的服务清单（api/connection/sessionHub…）降权，不是本蓝图关注点。

## 4. 对等 Loader：1:1 强对等

node Loader 加载的插件，若声明了 client 半边，client 侧**对等 Loader 以同一插件 ID 拉起对等体**；代码也许同一套、ID 同一个。

前置顺序（依赖链即时序）：

1. host 侧先注册（resolve 出 node 路径与实体）；
2. client 侧持有 host 已加载插件列表（**要具备更新能力**）；
3. client 按 ID 经 web server 代理拉取该插件的 client JS 产物。

## 5. 产物形态与构建强限制

- client 半边产物 = **完全 bundle 好的 dist.js**（非 CommonJS）。
- 外部依赖**强制 external**（cordis 等）；提供启动器、由宿主注入依赖——封装性比现在高一级。
- **用我们的构建模型自动打出插件 client 半边**：内部包改 tsdown 配置加一份特殊编译方式，全员共用，不许每包自造。

## 6. 点对点 + 双向 RPC

- **拓扑**：client 插件实例与 host 插件实例**点对点**（父亲也点对点）；更复杂形态先不考虑，但设计时要想一遍有没有特殊问题。
- **双向通信**：client ctx 挂一个符号访问 host 侧该插件声明的方法；host ctx 挂一个符号访问 client 侧声明的方法。
- **声明方式**：方法由插件包自己在 `./shared` 入口声明（遵循我们提供的 creator/泛型）；框架自动解析出**带类型的双向 RPC**并自动挂 context。官方不代为声明。

## 6a. ctx.peer API 设计

> 设计前置全部闭环（2026-07-20）：三入口/类型隔离/builder（无 callback）/hold/ClientPeerProxy 路由/config 同源/Q3 拉取式/四问。

**①已拍：per-plugin scoped `ctx.peer`**——符号名即 peer（点对点语义自明）；方法面来自 shared 声明；插件只能 serve/of **自己的**通道。

**shared 声明严格走 zod**（用户裁决，否掉 `{} as {...}` 幻影类型——「只为代码提示没意义」）：

```ts
// ./shared 入口
export const echoPeer = definePeer('echo', {
  host:   { method: { args: z.tuple([...]), result: z.schema } },  // host 侧供 client 调的方法
  client: { ... },                                                  // client 侧供 host 调的方法
})
```

- `z.infer` 推导编译期签名；wire 两端各 parse 一次（发送端出参、接收端入参），坏载荷在 peer 框架层拒收。
- 信封层对 args/result 照旧透传——「官方协议不代表插件类型」（四问裁决③）不变，只是插件侧从幻影类型升级为 zod 实证。

**API 形态**：

| 面 | 形态 | 语义 |
|---|---|---|
| 接收方 | `ctx.peer.serve(echoPeer.host, 实现对象)` | 一次性注册；缺方法/类型不符=编译错；fiber dispose 自动撤 |
| 发送方 | client 侧发往 host：形态留正式稿定（单对端，`ctx.peer.host.send` 或 `ctx.peer.call`）；host 侧见 §6a.3（broadcast / clientPeerProxy.send） | Proxy 按属性转发 `plugin.invoke`；client→host 走 unary、host→client 走帧+respond |
| 生命周期 | `ctx.peer.available` + `peer/connected\|disconnected` 事件 | 事件随 ClientPeerProxy 建立/dispose 发（见 §6a.3） |

**shared 运行时口径精化**：shared 必然含运行时（zod schema + definePeer 调用），「零运行时/import type only」不再成立；纪律改为**方向性**——shared 不得 import 任何半边；半边消费 shared 的 peer 对象是值 import（拿 schema）。

附带红利：zod 实现 StandardSchemaV1，与 fiber Config 校验同机制（design.md §A 早有记录）。

**待拍余项**：**清零**。~~②多 client 时 host→client 的路由语义~~〔已拍：ClientPeerProxy 模型，见 §6a.3〕；~~③client 半边 config 与 host 同源确认~~〔已拍（2026-07-20）：**同源**——client 半边插件的 config 与 host 侧同一份，host 声明单一事实源，boot/重连拉取下发（Q3 拉取式的自然延伸）〕；~~声明风格圈选~~〔已圈定 builder，见 §6a.1〕。

### §6a.1 shared 声明形态：builder 终版（已圈定 2026-07-20）

**裁决：builder（A 系）胜出**，吸收 raw shape 优点+「全对象」原则：`.input()/.output()` **只收 raw shape**（框架代包 `z.object`，全对象物理强制）。**v1 方法只有 input+output（一次请求一次应答）**——`.callback()` 不进 v1 词汇（收紧修正见下）。用户原话：「大家的 callback 形式都不太好看，更偏向 builder，能有效限制」。

```ts
// ./shared 入口
export const echoPeer = peer('echo', (m) => ({
  host: {
    echo: m.input({ text: z.string() }).output({ reply: z.string() }),
  },
  client: { notify: m.input({ message: z.string() }) },
}))
```

builder 状态机约束：链只有 `.input(shape)` 与 `.output(shape)` 两段，`output` 后链终结、每段至多一次——编译期限制。

**落选记录**：B 纯字面量（`{ input, callbacks, output }` 表驱动）与 C raw shape 字面量（同 B 但去 z.object 包裹）——两者的 callbacks 字面量形式均被否（「都不太好看」）；C 的 raw shape 与「全对象物理强制」被吸收进 builder 终版；B/C 完整代码块见 git 历史。

**调用侧**（声明形态不影响此面）：

```ts
// client 半边：发（单对端；形态留正式稿定，此处示意）
const { reply } = await ctx.peer.host.send(echoPeer.host).echo({ text: 'hi' })
// client 半边：收
ctx.peer.serve(echoPeer.client, {
  notify: async ({ message }) => { showToast(message) },
})
// host 半边：收（第二参=来源 ClientPeerProxy，见 §6a.3）
ctx.peer.serve(echoPeer.host, {
  echo: async ({ text }, client) => ({ reply: `ECHO: ${text}` }),
})
// host 半边：发——广播（void 方法）或经 ClientPeerProxy 定向
await ctx.peer.broadcast(echoPeer.client).notify({ message: 'host started' })
```

**回调（多次进度通知类）不进 v1**：多次回调本质是流语义。触发条件=真实插件出现「执行中多次通知」需求时再议，届时评估流/事件形态而非塞回请求-应答。（曾评估过「回调=关联原 rpcId 的反向 server-request 帧」方案，完整讨论见 git 历史。）

### §6a.2 加载窗口 hold 语义（已拍 2026-07-20）

host→client 调用遇 client 半边**尚未 apply** → **hold 不 reject**。根据：启动流程=host 通知 client 创建，client Loader 持有「创建中」集合——「加载中」与「不存在」可区分。

| # | 机制 | 内容 |
|---|---|---|
| 1 | 持有方=client | per-plugin hold 队列，apply 完成按到达序 drain；host 侧不感知 hold，unary 30s 超时天然兜底 |
| 2 | 三出口 | apply 成功→drain；加载失败→全队 reject（`plugin-load-failed`）；host 超时先到→client drain 时弃（`not-pending` 兜） |
| 3 | 「不存在」立即 reject | 不在列表也不在创建中 → `no-such-peer`；hold 只覆盖「已通知创建、尚未 apply」窗口 |

### §6a.3 多 client 路由：ClientPeerProxy 模型（已拍 2026-07-20；API 面简化修正同日）

每个 client 连接一个 `ClientPeerProxy`（派发语义类比 AgentScope/dsh-scope 的 `Scoped<T>` 先例——scope 一词下文仅作此语义说明用）：连接建立分配 clientId+ClientPeerProxy，断线即 dispose（hold 队列/pending 随清）。（推翻曾提的「主对等体」方案。）**host 与 client 插件不是点对点——host 插件面向 group**：host 侧 `ctx.peer` 顶层只有 **serve / broadcast / clients 三件**，定向 send 下沉到 ClientPeerProxy 对象。

| # | API | 语义 |
|---|---|---|
| 1 | `ctx.peer.serve(X.host, impl)` | 实现第二参=来源 ClientPeerProxy（host 必须知道来源，沿 tools/execute 的 exec.agent 先例） |
| 2 | `ctx.peer.broadcast(X.client).method(...)` | 广播全部在线对等体；**只准调无 `.output()` 的方法**——builder 类型状态机编译期强制（有 output 的方法不出现在 broadcast 代理上） |
| 3 | `ctx.peer.clients` | 全对端 ClientPeerProxy Map |
| — | `clientPeerProxy.send(X.client).notify(...)` | **顶层无 peer.send/peer.of**——定向能力只在 ClientPeerProxy 上：从 serve 来源参数或 clients Map 拿到 proxy 才能定向发；proxy 随连接断而 dispose，send 自然失效，无悬空 clientId 问题。要返回值必须定向——「通知=广播、问答=定向」由 API 形状物理强制 |

client 半边对称简化：单对端，形态（`ctx.peer.host.send` 或 `ctx.peer.call`）留正式稿定。

hold 融合（§6a.2 的 per-client 化）：hold 队列归 per-client 的 ClientPeerProxy；定向调用按 §6a.2 hold；**广播对未就绪 client 跳过不 hold**（通知 best-effort）。

### §6a.4 实现组件与命名（已拍 2026-07-20）

**命名规则**：无 Proxy 后缀=本体（在本进程）；Proxy 后缀=**对岸实体在本进程的替身**。两对镜像：

| host 进程 | ↔ | client 进程 |
|---|---|---|
| `ClientPeerProxy`（替身） | ↔ | `ClientPeer`（本体） |
| `HostPeer`（本体） | ↔ | `HostPeerProxy`（替身） |

**host 侧三件**：

| 组件 | 职责 |
|---|---|
| `HostPeer` | host 自己的 peer 本体：serve 注册 / `ctx.peer` 实现所在 |
| `PeerGateway` | group 管理者：`clients: Map<ClientId, ClientPeerProxy>`、broadcast 扇出、serve 来源路由——host 插件面向 group 的那个 group 就是它 |
| `ClientPeerProxy` ×N | 每个远端 client 的替身：`.send` 定向能力、per-client hold/pending 账本挂它上，dispose 随连接断 |

**client 侧两件**：`ClientPeer`（client 自己的 peer 本体）+ `HostPeerProxy`（host 的替身，即 `ctx.peer.host`——client 发起调用经它；单对端所以无 gateway）。

**三层对象图**（前两层均 host 侧实现，用户确认）：

```
hostCordisContext            PeerGateway + ClientPeerProxy ×N        clientCordisContext ×N
（现有 host 运行时；     ↔   （host 侧新组件；宿主位置=apiproxy   ↔   （各浏览器真实 cordis 运行时；
 插件 node 半边 apply 处）     plugin.invoke 域旁、runtime 装配层挂载）    插件 client 半边 apply 处，
                                                                       内含 ClientPeer+HostPeerProxy）
```

两侧 Proxy 用同一套信封编解码（shared zod schema）——「代码也许同一套」（§4）的实现落点。

### §6a.5 收尾三答（已拍 2026-07-20，设计线闭环）

| # | 问题 | 裁决 |
|---|---|---|
| 1 | client 半边装配上下文 | **「假装都没有」**——ctx 上只有 cordis 基建（timer/logger）+ `ctx.peer`，不暴露 api/connection/sessionHub 任何 web-runtime 对象；插件将来要 session 数据也**走 peer 问自己的 host 半边**，不开白名单服务。连带：旧 design §B.1 服务清单**正式作废** |
| 2 | plugin.invoke 信封 | **无独立信封设计**——peer 的 serve/send/broadcast 语义即信封全部；wire 表达在正式稿从 peer 语义直接推导 |
| 3 | UI 插件线 | 方向预告（不设计）：底层原语 `ctx.ui.registerSlot()`（类比 tool 注册），tool 卡呈现层=其上封装的 tool ui registry；触发条件=三型卡 switch 落地+echo demo 跑通 |

## 7. 与 React 无关

以上全部是**朴素浏览器插件层**（注入/双向通信/启动注册/依赖注入；「浏览器」指运行环境，命名仍用 client）；cordis×React 关联后置。

## 四问裁决（2026-07-20）

| # | 问题 | 裁决 |
|---|---|---|
| 1 | shared 入口纪律 | 可以是一个或两个文件（文件数不重要），核心=有一个专门定义类型与双边函数签名的东西；~~约束手段=对它的 import 必须是 `import type`~~〔已被 §6a 修订：shared 走 zod 后必然含运行时，纪律改为方向性——shared 不得 import 任何半边〕 |
| 2 | 父子树对等 | host 侧 reload → client 侧也 reload；**Loader 两边严格 1:1 绝对对应是硬保证**，Loader 之外的对应关系「别的说不准」——对等性收口在 Loader 层，不外溢承诺。约束推论：client Loader 消费的更新面（§4 前置顺序第 2 步）要能表达 reload 事件，快照 vs 增量的 wire 形态设计时以此为约束 |
| 3 | 双向 RPC 与四象限的关系 | **性质上复用四象限**，新域 `plugin.invoke` 逻辑设计成立；**但类型上官方协议不代表插件类型——底层纯透传**：payload 对官方 RpcMethodMap 是 opaque，插件自己的类型由 `./shared` 入口的 creator 泛型在插件侧两端成型，不进官方契约的编译期锁 |
| 4 | 产物分发安全 | 用户裁「后面再说」→ 记档：v1 仅分发第一方构建产物、无完整性校验；hash/签名校验进妥协台账，触发条件=第三方插件出现 |

## 与旧 design.md 的对照

| 旧结论 | 本蓝图处置 |
|---|---|
| Q1 双端包形态：显式子路径（推荐 B） | **保留并升级**：主入口（`"."`，node 半边即现有 index）+ 新增 `./client`、`./shared` |
| Q2 web Loader：registry map 假动态（推荐 A） | **推翻**：真动态按 ID 经 web server 代理拉取 bundle 产物 |
| Q4 双端互通：v1 不支持（推荐 C） | **推翻**：双向 RPC 是一等公民，框架自动挂 context |
| §B.0 类型宇宙「绕不开」结论 | **推翻**：必须编译期强拦，client program 不得见 node merge |
| §B.1 服务清单 | 降权，非本蓝图关注点（见 §3） |
