# web-cordis 正式设计稿（v2，按全套裁决重写）

> 2026-07-20 重写。裁决源=本目录 [blueprint-v2.md](blueprint-v2.md)（用户逐项拍板记录，含落选项与原话）；本稿是其系统化展开，冲突以 blueprint-v2 为准。旧版 design.md（web 总线/服务清单方案）已被推翻，见 git 历史。

## 目录

- §1 总述与三层对象图
- §2 双端包形态
- §3 类型宇宙强隔离
- §4 peer 体系（ctx.peer API）
- §5 对等 Loader
- §6 装配与配置
- §7 分期（v1 = echo demo 全链验收）
- §8 妥协台账
- 附录 A：echo demo 规格

---

## §1 总述与三层对象图

web-cordis = 让 harness 插件同时拥有 node 半边与 client（浏览器）半边：host 侧 Loader 加载插件的 node 半边，client 侧对等 Loader 以**同一插件 ID** 拉起 client 半边，两半经 `ctx.peer` 双向 RPC 对话。与 React 无关——这是朴素浏览器插件层（注入/双向通信/启动注册/依赖注入），cordis×React 关联后置。

**命名规则**：无 Proxy 后缀=本体（在本进程）；Proxy 后缀=对岸实体在本进程的替身。两对镜像：`ClientPeerProxy`(host 侧)↔`ClientPeer`(client 本体)、`HostPeerProxy`(client 侧)↔`HostPeer`(host 本体)。

**三层对象图**（前两层均 host 侧实现）：

```
hostCordisContext            PeerGateway + ClientPeerProxy ×N        clientCordisContext ×N
（现有 host 运行时；     ↔   （host 侧新组件；宿主位置=apiproxy   ↔   （各浏览器真实 cordis 运行时；
 插件 node 半边 apply 处）     plugin.invoke 域旁、runtime 装配层挂载）    插件 client 半边 apply 处，
                                                                       内含 ClientPeer+HostPeerProxy）
```

| 组件 | 侧 | 职责 |
|---|---|---|
| `HostPeer` | host | host 自己的 peer 本体：serve 注册 / `ctx.peer` 实现所在 |
| `PeerGateway` | host | group 管理者：`clients: Map<ClientId, ClientPeerProxy>`、broadcast 扇出、serve 来源路由——host 插件面向 group 的那个 group 就是它 |
| `ClientPeerProxy` ×N | host | 每个远端 client 的替身：`.send` 定向能力、per-client hold/pending 账本挂它上，dispose 随连接断 |
| `ClientPeer` | client | client 自己的 peer 本体 |
| `HostPeerProxy` | client | host 的替身（`ctx.peer.host`）——client 发起调用经它；单对端所以无 gateway |

两侧 Proxy 用同一套信封编解码（shared zod schema）——「代码也许同一套」的实现落点。

## §2 双端包形态

一个 npm package 的双端形态 = 现有主入口 + 新增两个子路径（**不做 `./node` 入口**，不干涉存量）：

| 入口 | 内容 |
|---|---|
| `"."`（主入口，即现有 index） | 插件 node 半边——存量不动 |
| `./client`（新增） | 插件 client 半边 |
| `./shared`（新增） | 双边通信声明（peer 定义住这里） |

约束（构建规范强制，导出信息与入口形态定死）：

- **client 半边产物 = 完全 bundle 好的 dist.js**（非 CommonJS）；外部依赖**强制 external**（cordis 等）；提供启动器、由宿主注入依赖——封装性比现有包高一级。
- **构建统一**：用仓库构建模型自动打出插件 client 半边——内部包在 tsdown 配置加一份共用的特殊编译方式，不许每包自造；无 src 出口，.d.ts 独立发射零增补。
- **shared 纪律（方向性）**：shared 必然含运行时（zod schema + peer 定义调用），不再是「零运行时/import type only」；纪律=shared **不得 import 任何半边**，半边消费 shared 的 peer 对象是值 import（拿 schema）。文件数不重要，核心是有一个专门定义类型与双边函数签名的东西。

## §3 类型宇宙强隔离

client 的 TS program **不得看见** node 侧对 cordis Context 的 interface merge——client context 上只能看到 client 自己挂的 service。这是理论正确方式，必须做到；拦截在**编译期**，不是 review 红线。

- **主线（三大件）**：client 专属 tsconfig program（file-set 与 node 侧不相交）+ 入口子路径的物理分文件 + gate 脚本核查——client program 编译单不含任何 node 半边文件。
- **备选注记**：package.json conditions（条件 exports 切类型视界）——因「读的是哪半边取决于解析环境」不可 grep、violates explicit>implicit 而降为备选；触发条件见 §8 台账。
- **转正形态**：gate 脚本按仓库门禁惯例落 `scripts/`（gate-api 形态），PR 窗口进 doc-sync/verify 车道。

## §4 peer 体系（ctx.peer API）

per-plugin scoped `ctx.peer`：符号名即 peer；方法面来自 shared 声明；插件只能 serve/send/broadcast **自己的**通道。plugin.invoke **无独立信封设计**——peer 的 serve/send/broadcast 语义即信封全部，wire 表达从 peer 语义直接推导（对官方 RpcMethodMap 而言 payload 是 opaque 透传，插件类型不进官方契约编译期锁）。

### §4.1 shared 声明：builder 词汇（v1 = input+output）

```ts
// ./shared 入口
export const echoPeer = peer('echo', (m) => ({
  host: {
    echo: m.input({ text: z.string() }).output({ reply: z.string() }),
  },
  client: { notify: m.input({ message: z.string() }) },
}))
```

- `.input(shape)`/`.output(shape)` **只收 raw shape**（框架代包 `z.object`，「全对象」物理强制）；逃生门：也接受完整 `z.object(...)` schema（`.refine` 跨字段校验等少数场景）。
- builder 状态机约束（编译期）：链只有 input/output 两段、`output` 后链终结、每段至多一次。
- **v1 无 callback**：方法只有一次请求一次应答；多次回调本质是流语义，见 §8 台账。
- **zod 双端 parse**：`z.infer` 推导编译期签名；wire 两端各 parse 一次（发送端出参、接收端入参），坏载荷在 peer 框架层拒收。

### §4.2 host 侧 API：顶层三件 + send 下沉

host 插件面向 group（不是点对点）：

| # | API | 语义 |
|---|---|---|
| 1 | `ctx.peer.serve(X.host, impl)` | 一次性注册（缺方法/类型不符=编译错，fiber dispose 自动撤）；实现第二参=来源 `ClientPeerProxy`（沿 tools/execute 的 exec.agent 先例） |
| 2 | `ctx.peer.broadcast(X.client).method(...)` | 广播全部在线对等体；**只准调无 `.output()` 的方法**——builder 类型状态机编译期强制 |
| 3 | `ctx.peer.clients` | 全对端 `ClientPeerProxy` Map |
| — | `clientPeerProxy.send(X.client).method(...)` | **顶层无 peer.send/peer.of**——定向能力只在 ClientPeerProxy 上（从 serve 来源参数或 clients Map 拿到 proxy）；proxy 随连接断 dispose，send 自然失效，无悬空 clientId。要返回值必须定向——「通知=广播、问答=定向」由 API 形状物理强制 |

client 侧对称简化：单对端（`ctx.peer.host` 即 HostPeerProxy），发起调用形态（`ctx.peer.host.send` 或 `ctx.peer.call`）实施时定；`ctx.peer.serve(X.client, impl)` 收 host 发来的调用。生命周期：`ctx.peer.available` + `peer/connected|disconnected` 事件，随 ClientPeerProxy 建立/dispose 发。

### §4.3 加载窗口 hold 语义

host→client 调用遇 client 半边尚未 apply → **hold 不 reject**（启动流程=host 通知 client 创建，client Loader 持有「创建中」集合——「加载中」与「不存在」可区分）：

| # | 机制 | 内容 |
|---|---|---|
| 1 | 持有方=client | per-plugin hold 队列挂在对应 ClientPeerProxy 账本；apply 完成按到达序 drain；host 侧不感知 hold，unary 30s 超时天然兜底 |
| 2 | 三出口 | apply 成功→drain；加载失败→全队 reject（`plugin-load-failed`）；host 超时先到→client drain 时弃（`not-pending` 兜） |
| 3 | 「不存在」立即 reject | 不在列表也不在创建中 → `no-such-peer`；hold 只覆盖「已通知创建、尚未 apply」窗口 |
| 4 | 广播例外 | 广播对未就绪 client **跳过不 hold**（通知 best-effort） |

## §5 对等 Loader

> 产物打包/启动器注入/拉包执行/分发端点/dev 模式的明细设计单独成文：[bundle-loader-design.md](bundle-loader-design.md)（含选型理由与关键设计点选项，供 review 圈定）。本节只留链路骨架。

**1:1 强对等是 Loader 层硬保证**（Loader 之外的对应关系不外溢承诺）：node Loader 加载的插件若声明了 client 半边，client 侧对等 Loader 以**同一插件 ID** 拉起对等体；host 侧 reload → client 侧也 reload。

加载链（依赖链即时序）：

1. host 侧先注册（resolve 出 node 路径与实体）；
2. client 侧持有 host 已加载插件列表——**更新面须能表达 reload 事件**（快照 vs 增量的 wire 形态以此为约束，实施时定）；
3. client 按 ID 经 web server 代理拉取该插件的 client JS 产物（bundle dist.js）；
4. client Loader 维护「创建中」集合（§4.3 hold 的判据来源）。

**产物分发**：v1 仅分发第一方构建产物、无完整性校验；hash/签名校验见 §8 台账。

## §6 装配与配置

- **client 半边装配上下文=「假装都没有」**：ctx 上只有 cordis 基建（timer/logger）+ `ctx.peer`——不暴露 api/connection/sessionHub 任何 web-runtime 对象，不开白名单服务。插件要 session 数据也**走 peer 问自己的 host 半边**。（旧版 §B.1 服务清单正式作废。）
- **config 同源**：client 半边插件的 config 与 host 侧同一份——host 声明单一事实源（`dsh-web-config` 类 harness 插件承载清单），boot/断线重连时一次性 unary 拉取快照。
- **无热下发**：配置变更靠重启 `dsc web` 生效——**面向开发者的文档必须写明「这些插件的配置修改需要重启服务」**。bootstrap 段（api/connection/timer 等 client 基建）本地静态写死，连上后按拉取的清单挂载其余插件（鸡生蛋问题因此消解）。

## §7 分期

- **v1 = echo demo 全链验收**（规格见附录 A）：三入口包 → bundle 构建 → host 注册 → client 拉起 → 双向调用 + hold + broadcast 各验一次。v1 交付物=peer 框架（HostPeer/PeerGateway/ClientPeerProxy/ClientPeer/HostPeerProxy）+ 对等 Loader 最小链 + builder/shared 词汇 + echo 示范包。
- **UI 插件线（预告，不设计）**：底层原语 `ctx.ui.registerSlot()`（类比 tool 注册），tool 卡呈现层=其上封装的 tool ui registry；触发条件=三型卡 switch 落地 + echo demo 跑通。
- **后续**（各有触发条件，见 §8）：多次通知的流/事件形态、第三方产物校验、conditions 类型切换备选。

## §8 妥协台账（触发条件 → 返工点 → 预埋要求）

| # | 妥协 | 触发条件 | 返工点 | 预埋要求 |
|---|---|---|---|---|
| 1 | v1 无 callback（方法只 input+output 一次往返） | 真实插件出现「执行中多次通知」需求 | 评估流/事件形态（不塞回请求-应答）；届时补 builder 词汇 | builder 状态机为闭集，加词汇=显式扩展点 |
| 2 | 产物分发无完整性校验（仅第一方） | 第三方插件出现 | 分发链加 hash/签名校验 | 拉取协议留版本位（实施时） |
| 3 | 类型隔离走三大件不走 conditions | 三大件维护成本实证过高（多包别名/paths 失控） | 换 conditions 方案（接受隐式解析代价） | gate 脚本先行——无论哪条路，编译单不相交的断言不变 |
| 4 | 广播对未就绪 client 跳过不 hold | 出现「广播也必须可靠送达」的插件需求 | broadcast 加 per-client 入队（复用 §4.3 hold 账本） | hold 账本已挂 ClientPeerProxy，扩展不动结构 |
| 5 | client 发起面形态未定（host.send vs call） | 实施 §4.2 client 侧时 | 正式定名一处 | 语义已定（单对端、经 HostPeerProxy），只差拼写 |
| 6 | web 配置无热下发（重启生效） | Settings 页出「应用配置/重启」按钮，或 Electron 立项 | supervisor/子进程拆分（webserver 常驻壳+cordis 子进程；handler 进程内直调换 IPC——第三种 fetch 伪造已预留）。代价：IPC 一跳、SSE 背压在新边界重现、重启砍在途 turn（「无感」只对空闲成立） | 无（接缝已在） |

---

## 附录 A：echo demo 规格（v1 验收）

**包形态**：`packages/examples/`（或临时 demo 位）新建双端示范包 `dsh-plugin-echo`——主入口=node 半边、`./client`=client 半边、`./shared`=peer 声明（§4.1 的 echoPeer 即其全文：host.echo 有 output、client.notify 无 output）。

**验收清单**（全链各验一次，agent 自跑）：

| # | 验收项 | 断言 |
|---|---|---|
| 1 | 构建 | tsdown 共用配置打出 client bundle（dist.js、非 CJS、cordis external）；.d.ts 独立发射 |
| 2 | host 注册 | node 半边经 Loader 加载，`ctx.peer.serve(echoPeer.host, …)` 注册成功 |
| 3 | client 拉起 | 浏览器侧对等 Loader 按同一 ID 经 web server 代理拉取 bundle → 全局注册（id 对账通过）→ 主框架点火 apply；clientCordisContext 上只见基建+ctx.peer（§6「假装都没有」的 grep/断言面）；自报 id 错配 case 断 `plugin-load-failed` |
| 4 | client→host 调用 | `echo({text:'hi'})` 返回 `{reply:'ECHO: hi'}`；serve 实现第二参收到来源 ClientPeerProxy；坏载荷（缺 text）被 zod 拒收 |
| 5 | host→client 定向 | 从 serve 来源参数拿 proxy，`proxy.send(echoPeer.client).notify(…)` 到达该 client |
| 6 | broadcast | `ctx.peer.broadcast(echoPeer.client).notify(…)` 全部在线 client 收到；编译期断言：broadcast 代理上不存在 echo（有 output 的方法） |
| 7 | hold | client 半边延迟 apply 场景：host 定向调用先 hold、apply 后 drain 返回；「不存在」ID 立即 `no-such-peer` |
| 8 | 断线清理 | client 断开 → ClientPeerProxy dispose、clients Map 移除、`peer/disconnected` 事件 |

**类型隔离随验**：echo 包的 client program 编译单不含 node 半边文件（gate 脚本首个真实用例）。
