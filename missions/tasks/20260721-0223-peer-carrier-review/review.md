# peer wire carrier 属地评审（apiproxy/host-runtime owner：arch-carrier）

- **时间**：2026-07-21 02:23
- **对象**：worktree-cordis-web 树 f924cc638.. 的 peer 相关刀（9d71a97fa 词表 / 15cd63fa8 gateway / ac0cd98ea carrier+assembly / 76f1f8266 client loader）
- **评审面**：carrier 接入面四象限纪律、handles() 分流谓词、SSE 背压先例。零改码，问题只报不修。
- **总评**：**接入面干净，口径守住了**。RpcMethodMap 零感知（无一处 apiproxy schema/map 改动）、组合收在 assembly 层（start.ts）而非 toFetchHandler 内部、apiproxy 包零文件变更——正是属地期望的搭法。放行没有障碍；下面 2 项建议修、1 项口径确认、3 项 nit/台账。

## 建议修（cordis-impl 处理）

### R1. carrier SSE 流缺 `cancel()`：consumer-cancel 路径永不 detach（carrier.ts peerStreamResponse）

`ReadableStream({ start })` 未定义 underlying source 的 `cancel()`。消费者走 reader.cancel()（而非 req.signal abort）时：push() 内 enqueue 抛 TypeError 被 catch 吞掉，注释声称「abort listener below performs the detach」——但 cancel 不触发 signal abort，onAbort 永不跑，结果 proxy 常驻 clients 表、后续 directed call 全部走 30s 超时。对比 apiproxy 先例：sseResponse 的 for-await 在 enqueue 抛后跳 finally close，FrameQueue.iterate 的 finally 卸 listener——精确覆盖了这条路径；peer 的 push-callback 形态把这层保护丢了。今天被 webserver bridge 掩护（disconnect 必 abort），但 in-process 消费者（未来测试/Electron IPC）一 cancel 就漏。**修法一行量级：underlying source 加 `cancel: onAbort` 同款 detach。**

### R2. 路径预留无守卫：未来 RpcMethodMap 行会被静默吞掉（carrier.ts PEER_ROUTES + start.ts 前置组合）

handles() 对现有路由集验证过零误吞（events.mux/events.host/respond/session.*/host.describe 均不撞）。但前置组合意味着 **`events.peer`、`peer.send` 两个路径从此对 RpcMethodMap 永久预留**：若日后有人加 `'peer.send'` 这样的 map 行，编译全绿、UNARY_ROUTES 也有行，运行时 POST /api/peer.send 却被 peer carrier 截走——正是「误吞」类事故，且无声。建议任选其一：rpc-map.ts 的 RpcMethodMap JSDoc 加一句预留声明（最便宜）；或 assembly 组合处加一条 boot 断言（`keyof RpcMethodMap` 与 PEER_ROUTES 路径段不相交，misconfiguration fails loud 口径）。

## 口径确认（报 team-lead 裁决，非阻塞）

### C1. peer 流量对 RPC log 面板不可见

peer SSE 下行是裸 PeerDownFrame（无 ServerRequest 全形），上行 POST 不经 AbstractApiClient.callUnary——两个方向都不过 subscribeEnvelopes tap，GUI 的 RPC 四象限面板看不到任何 peer 帧。「peer 信封是四象限在 peer 域的实例化」口径下这不算违规（correlation 换了 callId 词表），但 wire 可观测性是 RPC 面板的立身之本，peer 域是否纳入需要明确拍板。建议：记台账（client 侧 peer 传输层加同类 envelope tap 即可接入现有 ingest），不阻塞本刀。

## Nit / 台账（不阻塞）

- **N1** handles() 用裸索引 `PEER_ROUTES[pathname]`，原型键（constructor/toString）因值比较（=== 'GET'/'POST'）不会误命中，无实害；但 apiproxy methodFor 用的是 `Object.hasOwn` 先例，对称性上建议看齐。
- **N2** peer.send body 解析失败统一回 `{accepted:false, reason:'bad-response'}` receipt——该词表是为 answer 帧设计的；坏 **call** 帧拿到 receipt 后，client send() 的报错文案是误导性的「expected an answer, got a receipt」。apiproxy handler.ts 有 rpcId 抢救先例（坏信封仍尽力回填 correlation）；可挖 callId 时回 bad-payload answer 更对症。低优先级。
- **N3** peer 流无 mid-stream error 帧（apiproxy 有 stream/error 词表项）。鉴于 peer 重连=全新 clientId、无 gap 修复语义，静默断流可接受——但这是有意差异，建议在 envelope.ts 或 carrier 注释点一句名，防后人当遗漏补齐。

## 确认合规项（留档）

| 项 | 结论 |
|---|---|
| correlation 纪律 | callId 发起方 mint（两侧 send face）/应答方回填（answerError/handleAnswer 均 echo）✓；receipt 词表逐字镜像 RpcReceipt（not-pending/bad-response）✓ |
| mint 收敛 | mint 在 send face（载体层），插件业务只见 typed SendFace，永不摸 callId ✓（红线 15 的 peer 域等价物） |
| RpcMethodMap opaque | peer 包零 import apiproxy schema/map；payload 双端二级 parse（sender 出参/receiver 入参各自过声明 schema），与 apiproxy 两级 parse 同构 ✓ |
| 组合落点 | assembly 层（start.ts）组合，toFetchHandler/apiproxy 包零改动；「shells must not alter the assembly」不受影响（组合发生在 startHost 内部）✓ |
| SSE 背压 | peer 路由在 /api/* 下走同一 webserver bridge，drain-wait 背压先例自动沿用 ✓；`: connected` 活通道注释、cache-control 先例照抄 ✓ |
| 流生命周期 | attach 同步推 hello（先于 abort 注册，pre-aborted 有护栏）；detach 幂等；dispose 顺序 gateway 先于 host（pending 先拒后拆 ctx）✓；dispose 后流不主动关（等 shell closeAllConnections）与 apiproxy mux 同形态，shell 属主 ✓ |
| 分流谓词现状 | 与既有 6 unary + 2 SSE + respond 全集零交集；非法 method 组合（POST events.peer 等）落回 apiproxy 404，无吞噬 ✓（未来预留风险见 R2） |
| 安全口径 | clientId 即能力凭证（不可猜 UUID、body 携带），与 GUI 现行无鉴权口径一致；auth 窗口一并再议，不单列 |
