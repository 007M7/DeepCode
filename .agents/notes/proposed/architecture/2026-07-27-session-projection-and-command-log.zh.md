# Agent Note: Session projections and command lifecycle logging

Status: proposed

[English](2026-07-27-session-projection-and-command-log.md) | 中文

## Problem

三个在途的 web 功能——todo（#497）、goal（#527）、plan mode（#587）——都要从会话日志推导按会话的状态并呈现到浏览器客户端，而三者各自发明了一套同样的机制：

- **客户端核心类吸收每一个领域。** 三者都往客户端运行时的 `Session` 类里添加私有字段、拉取编排和事件 switch 分支，并经 `ConversationSnapshot` 投出各自的值。仅 plan 一家就加了七个私有字段和三层栅栏（请求版本、事件版本、最新活值缓存）；goal 加了写 revision 栅栏外加一个合并式重取循环；todo 加了一个投影（projection）字段和一条事件 case 分支。再来第四个领域，就要第四次改动核心类。
- **三条基线通道。** todo 搭在历史尾页的 `todos` 字段上——由 **api-proxy 内部**的 `backscanTodos` 计算，业务折叠（fold）逻辑寄居在载体里；plan 加了一个专用的 `session.planMode` 一元 RPC；goal 加了 `goals.get`。同一个问题，三种协议格式（wire format）。
- **命令结果不可恢复。** `/goal`、`/plan` 以及其余所有斜杠命令都只在 `command.execute` RPC 响应里返回结果，以一条转瞬即逝的 composer 通知呈现在发起命令的标签页上。会话日志里什么也留不下：刷新、另开标签页、恢复（resume）或 fork 都会丢掉「该命令曾经运行过」的记录。领域*状态*变更是持久的（goal 提交 `goal/change` 元数据，plan 提交 `plan/mode`），但命令调用本身及其结论不是。

底层缺口是架构性的：客户端没有一个 seam 让插件在会话 scope 内观察会话事件并维护自己的派生状态；host 侧也没有统一的方式把日志派生状态的当前值交给客户端——而该状态的历史可能已被分页挤出客户端窗口之外。

## Proposal

先立四件基础设施，之后各领域都退化为纯贡献方。

### 全量值事件规则

携带状态的日志事件必须携带变更后的完整状态，绝不携带增量。三个领域现状已然合规：`todo/write` 是整表快照，`plan/mode` 是一个完整布尔值，`goal/change` 元数据是完整的 `GoalSnapshot`（或一个全量值清除墓碑）。在该规则下，客户端侧的折叠退化为 **last-wins**：一个领域的状态，就是已见 seq 最高的该领域事件所携带的全量值。无需客户端状态机（goal 的 revision/CAS/阶段检查留在 host 侧写路径），不依赖历史，靠 seq 比较获得乱序免疫，而且自愈——漏掉的事件会被下一个事件纠正。

### host 侧投影注册表（`dsh-session-projection`，新包）

一个轻量的接口包（package）：merge-extensible 类型表、注册表服务、边界上的 zod 校验。能力 seam 三方拆分：领域 host 插件负责贡献，载体负责消费，两侧互不相识。

```ts
export interface SessionProjectionMap {}   // the single type table for the whole chain

export interface ProjectionProvider<K extends keyof SessionProjectionMap> {
  key: K
  schema: ZodType<SessionProjectionMap[K]>  // validates the payload before it leaves the host
  get(agent: Agent): SessionProjectionMap[K] // MUST be synchronous; whole current value
}

declare module 'cordis' {
  interface Context { sessionProjections: SessionProjectionRegistry }
}
```

- 值就是协议层的 JSON 载荷；同一张类型表经 `import type` 端到端贯通（host 提供方、协议块、客户端 cell、React 钩子）——没有第二张 DTO 表，也没有独立的客户端「views」表。值如何*渲染*是 slot 体系的事，永远不归投影层管。
- `get` 面向 host 的全量内存日志（`agent.session.events`）运行——分页只存在于返回给客户端的历史切片里，绝不出现在提供方的视野中，所以「窗口里缺这个事件」在 host 侧不可能丢状态。last-wins 领域可以回扫（有界：从尾部起首个命中即终止；事件本就在内存里）；折叠开销大的领域维护一份以已见 seq 为键的增量缓存（goal 的 `GoalCache` 即范本）。无论哪种方式，提供方都同步返回当前全量值。
- 注册是 effect（disposer 随 fiber 走）：插件卸载后其 key 从后续响应中消失，客户端将其读作能力缺失——HMR（热模块替换）语义随之自动成立。key 重复直接 throw。领域插件在 `ctx.inject(['sessionProjections'], …)` 下注册，因此不带注册表的 headless 组装完全不受影响。
- 该包拥有 `./invariant`（每个被服务的 key 都有一条存活的注册）。

### 协议层：历史尾页上的 projections 块

```ts
// session.history response, tail page only (beforeSeq absent):
{ events, hasMore,
  projections?: { asOfSeq: number, values: Partial<SessionProjectionMap> } }
```

api-proxy 的历史处理器切出尾页后读取 `session.seq`，然后同步遍历注册表——全程没有一个 `await`，因此所有 key 的值与 `asOfSeq` 构成同一个一致切面，且 `asOfSeq` 等于窗口尾部 seq。api-proxy 不持有任何领域知识（与 `viewFor` 面向 `ctx.tools` 是同一种载体/贡献方关系）。

不新增 RPC 方法。时机上的重合是精确的：客户端每一个需要新基线的时刻（打开、重连重同步、缺口修补）本来就要拉尾页，而唯一永远不需要基线的路径（loadOlder）恰好是唯一传 `beforeSeq` 的路径。因此客户端**完全没有**独立的「重取基线」决策。窗口内容从不充当信号：「窗口里没有该领域的事件」这个问题在窗口内从构造上就无法回答，只有基线能回答它。

随此块下线的旧通道：`session.planMode`（读侧；`setPlanMode` 保留）、`goals.get`（读侧；六个变更 RPC 保留，但其响应不再喂状态——mux 事件反正会到）、`todos` 搭载字段，以及 api-proxy 里的 `backscanTodos`（移入 todo 领域的提供方，落在 `tool-todo`）。

### 客户端：会话 scope 的事件分发与投影 cell

客户端运行时的 `Session` 对象在它的两个事件入口——`appendLive(event)`（实时信号）与 `installWindow(…)`（窗口替换信号，响应携带 projections 块时附带基线重置）——获得一个分发 seam。实时与窗口替换是可区分的两种信号：#527 为避免重取风暴手工造出的、#587 为重扫替换窗口手工造出的，正是这个区分。核心类回归纯 transcript（文本记录）关切；各领域的 switch 分支撤出 `applyEventSideEffects`。

领域客户端插件在 scope 物化时注册**投影 cell**（即 `InputHub.shellFor` 模式；销毁随 scope fiber 走）：

```ts
export interface ProjectionCellSpec<K extends keyof SessionProjectionMap> {
  key: K
  schema: ZodType<SessionProjectionMap[K]>   // validates the baseline at the wire boundary
  fromEvent(event: SessionEvent): SessionProjectionMap[K] | undefined  // whole value, or not-my-event
}
```

框架语义对所有 cell 只实现一次：一条从基线 `asOfSeq` 初始化的 `lastAppliedSeq` 水位线（watermark）；唯一一条应用规则——`event.seq > watermark` 且 `fromEvent` 命中 ⇒ 取全量值、抬高水位线、`markDirty`（Notifier 批处理）；实时事件与窗口替换事件过同一道过滤，所以重放的旧页按 seq 被丢弃，永远不可能把状态往回滚；基线重置会重设值与水位线，块中缺席的 key 则把对应能力标记为缺失。所有按领域自造的栅栏（#587 的三层、#527 的写 revision）都消融进这一条 seq 规则。plan 的待定意图不入日志（turn-enclosure）但在投影值之内——host 的 `planMode.get()` 返回的恰是这个形状；待定态不向其他标签页传播（已接受：它是发起标签页本地的「等待边界」事实；其他标签页看到的是提交事件）。

### React：`useProjection`，第五个框架钩子席位

既有四个席位都装不下这份状态（store 纪律禁止业务对象；inject 禁止钩子；`ConversationSnapshot` 正在被清退）。`useProjection` 成为一个框架席位，在 web-react（唯一的钩子铸造点）铸造，经与 `useSession` 相同的标准套件通道（`provideInfo` → SessionProvider → props）送达：

```ts
type UseProjection = {
  <K extends keyof SessionProjectionMap>(key: K): SessionProjectionMap[K] | undefined
  <K extends keyof SessionProjectionMap, S>(
    key: K, selector: (v: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean): S
}
```

`undefined` 统一表示能力缺失（host 插件未挂载、客户端插件未挂载，或基线尚未到达）。cell 只暴露裸的 `{subscribe, getSnapshot}`；其余交给带逐 cell 缓存的 `bindSnapshotSelector`——引用稳定性成立，因为全量值是冻结的事件数据，两次事件之间恒等不变。写路径不变：变更回调留在 inject 共享面（回调出自 inject，活状态出自 `useProjection`）。

「钩子不得穿过 inject」的唯一既有违例——`DetailsInjected.useSelection`——随本变更一并收编：选中态是住在聊天 store 里的查看状态，因此 details 注册声明共享 store 句柄，组件改读 `props.useStore(s => s.selection)`；`useSelection` 退出 inject 契约。

### 日志中的命令生命周期

两个仅日志（非 surface、模型不可见）事件，镜像 `tool/call`/`tool/result` 的配对：

```ts
'command/run':  { commandId: string; name: string; line: string; source: CommandSource }
'command/done': { commandId: string; kind: 'success' | 'error'; text?: string }
```

两者都合并进 `OutOfBandSessionEventMap`。host 侧命令执行器（`packages/ui/commands`）在调用处理器前追加 `command/run`，在结算时追加 `command/done`。`text` 是处理器的原样结果——与 `tool/result.content` 同一性质的事实数据，不是呈现（版式如何编排仍由客户端在渲染时计算，满足「呈现永不入日志」这条红线）。想让模型知道结果的领域继续做它们今天在做的事（plan 的旁白、goal 的注入）——那是领域自己的决定，保持不变。

由于已提交事件会在 mux 流上广播，刷新后仍在、多标签页同步、fork/恢复后可还原这三件事随之全部自动获得。`command.execute` RPC 退化为纯准入判定（是否匹配命中、语法错误立即打回 composer）；一次性通知通道（`runDetached` → `noticeFor`）就此下线。

客户端 flow 构建器新增一个通用命令节点（run/done 按 `commandId` 配对；跨窗口截断时与工具配对同样软降级）。渲染走一个新的 keyed slot `'conversation.chat.commandview'`，key = 命令名，**兜底 = 通用命令卡片**（零注册即可用——从前的通知文本现在持久地渲染在 flow 里）。领域要升级展示，只需注册一个行组件，取材于 `command/run.line` 与自己的 cell 状态——与 toolview 解散之后的工具行同一形状。

## Delivery plan

基础设施先行；三个在途 PR（Pull Request）原样不动，待基座落地后重新对接（它们的迁移映射即指南）：

1. **host 基座**：`dsh-session-projection` + api-proxy 的 projections 块。零领域注册也可合入（此时块直接缺席）。
2. **客户端基座**：分发 seam + cell 框架 + `useProjection` 席位 + `useSelection` 收编。与 1 并行（fixture（测试前置数据）喂合成基线）。
3. **命令通道**：两个事件、执行器落日志、通用节点 + keyed slot、通知通道下线。与 1 并行。
4. **领域重新对接**（在 1+2 之后）：先 todo（最小：提供方进 `tool-todo`，cell 取自 `todo/write`，删掉搭载字段），再 plan（删掉一元 RPC 和各道栅栏），最后 goal（删掉 `goals.get`，把六个 `Session` 方法移入领域插件的 inject）。

## Alternatives considered

**专设一个 `session.projections` RPC**——不予采纳：基线刷新时刻与尾页拉取精确重合，单独的一元 RPC 只会换来第二次往返、第二个待调和的 seq，以及一个客户端「何时重取」决策——而搭载设计把这个决策整个删掉了。

**把 seam 命名为 `registerFold`**——不予采纳：`get` 并不承诺折叠（goal 读缓存，plan 从服务内存叠加未入日志的待定意图）；本仓库里 `fold*` 专指纯 `(events) => state` 函数，注册表会稀释这一命名。projection（投影）正是事件溯源中指称这种读模型角色的术语，#587 的 Note 标题与 #497 的评论也都已在使用它。

**`invalidate` 式 cell（标脏，遇领域事件就重取）**——不予采纳：它的存在只为伺候增量事件。全量值规则让每个领域都是 last-wins；goal 的重取循环、合并逻辑、陈旧读栅栏随之全部消失。

**把注册表挂到 `ctx.apiProxy` 名下**——不予采纳：会话投影并非 web 专属（TUI、ACP（Agent Client Protocol）、headless 都是未来消费方），且领域包不得依赖 apiproxy 包。独立 seam 还顺带删掉了 #587 从 api-proxy 指向 plan 包的 type-only 导入边。

**独立的客户端 `SessionProjectionViews` 类型表**——不予采纳：一张 `SessionProjectionMap` 端到端贯通正是协议直通纪律（不设第二套 DTO 词汇）；值就是 JSON 载荷，渲染归 slot 管。

**用事件广播收集、替代注册表遍历**——不予采纳：异步监听器给不出那个单一的同步切面，而正是它让 `asOfSeq` 成为横跨所有 key 的一致快照；注册表才是本仓库承接贡献的通行形状（`ctx.tools`、提示词片段、slot）。

**把 plan 的待定意图跨标签页传播**——推迟，不纳入本设计：待定态是刻意不入日志的（turn enclosure），一种实时的非日志控制帧（先例 `session/queued`）日后可以在完全不动本模型的前提下补上它。

**让变更 RPC 的响应喂 cell 状态**——不予采纳：已提交的 mux 事件即刻到达，携带同一个全量值外加 seq；「响应喂状态」正是当初逼出 #527 写 revision 栅栏的根源。

## Acceptance criteria

- 领域插件把按会话的日志派生状态送达 React，只需写：全量值事件声明、一次 host 侧 `register`、一次客户端 cell 注册、以及 inject 回调——除自己那份 `SessionProjectionMap` merge 之外，不改客户端 `Session` 类、`ConversationSnapshot`、api-proxy 或任何协议 schema 文件。
- 历史尾页携带 `projections`，其 `asOfSeq` 等于窗口尾部 seq；loadOlder 页永不携带；未装注册表的部署照常返回不带该块的历史，客户端把所有 key 视为缺席。
- 重放的窗口事件不能让 cell 状态倒退（水位线测试）；在更新的 mux 提交之后才落地的基线不能覆盖该提交（seq 规则测试）。
- 在一个标签页执行的斜杠命令，刷新后、在第二个标签页上、恢复之后都在 flow 中渲染出持久节点；未注册的命令渲染通用卡片；命令结果的 composer 通知路径彻底移除。
- `useProjection` 经标准 props 套件抵达组件；没有任何钩子穿过 inject 契约（包括 `useSelection`）。

## Risks

- **全量值规则是承重结构**：未来某个领域若记增量事件，会无声地破坏 last-wins。缓解：该规则写明在本 Note 与投影包的 README 里；cell 的 `fromEvent` 签名使增量形状若非刻意为之便无从表达。
- **同步 `get` 纪律**：提供方一旦 await 就会撕裂一致性切面。注册表在文档中申明这条纪律，invariant 配套在可行范围内断言同步性；其余由评审把关。
- **投影载荷膨胀**：每个尾页携带每个已注册的 key。载荷是 UI 量级状态的全量值（一张 todo 清单、一份 goal 快照）；将来若某领域的值很大，可以在请求上加逐 key 的 opt-out 或惰性 key，模型本身不用改。
- **命令日志体量**：每条斜杠命令两个仅日志事件；上限由人敲命令的频率决定，相对分片体量可忽略不计。
- **重新对接的返工**：三个未合入的 PR 要变基到挪动后的地基上。这是基础设施先行的既定代价；设计台账中的迁移映射一节逐一列出每个 PR 的保留/删除清单。
