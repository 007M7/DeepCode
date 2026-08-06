# Agent Note: subagent 列表经投影单元读取身份

Status: proposed

[English](2026-08-06-subagent-list-identity-projection.md) | 中文

## 问题

`SubagentService.listChildren`（[list-children.ts](../../../../packages/subagent/subagent/src/list-children.ts)）对每个 `header.origin === 'subagent'` 的直接 child，每次列表都执行 `listEvents` 加 `readEvent` 两次整日志物化，且每次物化都伴随整日志 structuredClone，只为从描述符事件里折出 mode 与 label 两个字段。描述符在日志中的位置不固定——fork 前缀任意长，zstd 压缩帧没有 seq 索引——因此定位没有捷径；这条路径没有任何缓存，代价随 transcript 长度 × child 数量 × 列表频率放大。它还把 session-query 拉成列表的硬依赖：没有 query backend 的部署，`list_agents` 以 `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE` 整体拒绝，尽管枚举所需只是 header 事实。

同一根因还有第二个症状：host 侧的 `hasSubagentDescriptor()`（[api-proxy.ts](../../../../packages/host/apiproxy/src/api-proxy.ts)）在每次 Agent 绑定 RPC 的属主判定上扫描目标会话的 own suffix，即便 `SessionHeader.origin` 已经回答了同一个问题的绝大部分。

根因在于 [durable-subagent-catalog 决策](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)把描述符事件（`subagent/descriptor`）定为目录的唯一持久权威，却没有为描述符读取配任何缓存层，并把逐 child 双读明确接受为"无索引的正确性基线"。[web subagent conversations](../../implemented/feature/2026-07-27-web-subagent-conversations.md)（#1569）已把"是不是 subagent"放进了 header（`SessionHeader.origin`），身份判定不再读日志；mode 与 label 仍然要扫。

## 提案

mode 与 label 由新的 `subagent` projection unit（纯身份两臂）折叠，unit 是折叠规则的唯一权威；`listChildren` 摘除 session-query 依赖——枚举由 subagent 自管的 live-preferred 合并完成，取值走 live/cold 两级"算完即止"阶梯：live child 同步读注册表的既有水位缓存（零日志读），cold child 一次 `persistence.inspect` 整读加 `registry.restore` 折叠。无索引、无缓存、无回写。

消除逐 child 扫描的出路有三类：把 mode/label 提升进 header（写路承担）；为投影建持久派生（checkpoint 阶梯，或随查询索引重建落值、读端对账）；读时现算（live 走水位缓存，cold 一次整读）。本记录取第三条。"值随查询索引落库"曾是本记录的定稿方向并一度施工，最终整体退役：查询基础设施被迫认识领域词汇，而唯一消费方读时现算即可满足——live child 的零读由 session-projection 既有水位缓存白拿，cold child 的一次整读被"算完即止"显式接受。前两条与退役理由详见考虑过的替代方案一节。

方案要点：

- **subagent 列表不再依赖 session-query**：枚举由 subagent 自管的 live-preferred 合并完成，mode/label 经 `ctx.sessionProjections` 取值；没有 query backend 的部署照常列表。
- **取值两级"算完即止"阶梯**：live child 读 `sessionProjections.snapshot()`（注册表既有水位缓存，零日志读）；cold child 一次 `persistence.inspect` 整读加 `registry.restore({}, events, 0)` 折叠；再没有就没有——无缓存、无回写、无索引。
- **`subagent` projection unit 是折叠规则唯一权威**：live snapshot、cold restore、GUI history 的 detached 折叠全部经 registry 计算，不存在第二份描述符解释逻辑。
- **session-query 的净变化只剩读路径去 clone 加浅 readonly 借用视图**（附带工作项；DeepReadonly 被实证否决，见替代方案）。
- **header、描述符（v2）、session-persistence、session-projection(-cache)、session-query-sqlite 全部零改动**；存量数据第一次被列表时一次 `inspect` 现算获得精确值，无 unknown 降级态、无迁移。

与既有记录的关系：

- 本记录取代 [durable-subagent-catalog](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md) 中列表读路径的两项设计：经 `sessionQuery.traceSession` 枚举，与逐 child 读取描述符事件（`listEvents` 加精确 `readEvent` 双读、就地诊断分类）。diagnostic 行语义保留，分类改由列表按投影值缺席与 activity 派生；描述符事件仍是 mode/label 的唯一持久权威与折叠输入，恢复鉴权与激活契约不动。属部分取代，两记录保持交叉链接。
- [session-projection RFC](2026-07-27-session-projection-and-command-log.md) 的 registry 契约（`ProjectionDefinition`、`snapshot`、`restore`）零改动，本记录只为其新增 `subagent` 身份 unit 一个注册项，并成为 snapshot（live）与 restore（cold）两处既有读法的又一消费实例——GUI history 的冷读已是同款。折叠规则只在 registry 注册一份；任何消费面都经 registry 计算，不存在第二份折叠逻辑。

### `subagent` projection unit

挂在现有 `subagentTiming` 旁（[projection.ts](../../../../packages/subagent/subagent/src/projection.ts)、[projection-types.ts](../../../../packages/subagent/subagent/src/projection-types.ts)），key 为 `subagent`：

```ts ignore-check
export type SubagentIdentityProjection =
  | { mode: 'one-shot'; label?: string }
  | { mode: 'continuable'; label: string }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    subagent: SubagentIdentityProjection
  }
}
```

- 投影是纯身份，**projection 体系不做失败通道**：unit 永不抛错；载荷损坏、版本不认识与整日志没有描述符一样，折叠结果就是"无值"，该 key 在这个 session 上缺席。"算出来没有"如何呈现是消费方自己的事（见下文 `listChildren` 四态映射）。
- label 强度由描述符 schema 决定：continuable 的 label 解析强制必有，one-shot 的本就可选；该判别式与下文 child 行的 mode/label 强契约完全一致。
- 折叠规则：`subagent/descriptor` last-wins，与 `subagentTiming` 同一条 descriptor-reset 纪律——fork 前缀里的祖先描述符被自身描述符覆盖。

### 枚举：subagent 自管 live-preferred 合并

`listChildren` 的枚举不再经任何查询服务：`ctx.sessions.list()` 与 `ctx.get('sessionPersistence')?.list()` 两个来源按 id 合并，live 优先、不做一致性校验。枚举所需全部是 header 事实：

- 过滤：`header.origin === 'subagent' && header.parentSession === parentSessionId`。
- `hasChildren`：同一份合并材料向下看一层——存在 `origin === 'subagent'` 且 `parentSession` 为该 child 的直接后代。
- `activity`：live 记录为 `running`，仅存在于持久化的为 `inactive`。
- 排序：`createdAt` 升序、再按 child id 升序（与旧契约一致）。
- **persistence 缺席退为 live-only 枚举，不报错**：没有 persistence 的部署，cold child 本就无法 resume，列出 live child 仍然有意义。（对照：旧实现在 sessionQuery 缺失时整体拒绝。）

### 取值：两级"算完即止"阶梯

对每个枚举出的 child，mode/label 取值走两级阶梯，与 apiproxy `session.history` 的冷读同款——算完即止，无缓存、无回写：

| 级 | 读法 | 成本 |
| --- | --- | --- |
| live child | `ctx.sessionProjections.snapshot(session).values.subagent` | 零日志读——注册表既有水位缓存，同步取值 |
| cold child | `persistence.inspect(id)` 整读 + `registry.restore({}, events, 0).snapshot.values.subagent` | 每次列表一次整读现算 |

- 错误契约：`ctx.sessionProjections` 未挂载是配置错误，`listChildren` 在枚举前无条件检查并以 `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE` 响亮失败——零 children 的部署同样确定失败，不因列表恰好为空而掩盖配置问题。`SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE` 随 session-query 依赖一并删除。
- per-child 隔离：单 child 的 cold 整读失败只使该行成为 `unavailable` diagnostic，不影响 sibling（见四态映射）。
- 冷读成本如实记录：cold child 每次列表一次整读，成本与其 transcript 大小成正比；定案"算完即止"，不为它建缓存。整读经 `inspect()` 走 [Session 准备阶段](../../implemented/architecture/2026-08-05-session-preparation.md)的冷读，同 id 短期重复读取可命中其 LRU 复用，但列表不依赖此。live child 全程零日志读。

### 权威模型

- session log 是唯一权威；本方案不新增任何派生持久化——没有索引值、没有 checkpoint、没有进程 memo，取值现算现弃，值的新鲜度就是读取时点的 live 状态或持久化 revision。
- Session 与 persistence 写路完全不感知列表与投影消费：没有事件监听回写，没有写时折叠。
- 枚举与取值不构成第二个鉴权来源，也不让尚未发布的 child 可见——两个来源只见已发布的 live 记录与已落盘的持久化记录，与 durable-subagent-catalog 记录对派生读面立下的规则一致。

### `listChildren` 行形状与消费面

`SubagentListEntry` **数据结构与今天完全一致**——child 与 diagnostic 两臂、`kind` 判别、reason 三值、child 臂的 mode/label 强契约全部保留；变化只在诊断的信息来源：投影体系没有失败通道，diagnostic 由列表按投影值缺席与 activity 派生，列表本身仍零事件读取。"没有就等待硬读取"继续保证阶梯对健康数据必然算得出 mode/label。

```ts ignore-check
export type SubagentListEntry =
  | ({
    readonly kind: 'child'
    readonly id: SessionId
    readonly activity: 'running' | 'inactive'
    readonly hasChildren: boolean
  } & (
    | { readonly mode: 'one-shot'; readonly label?: string }
    | { readonly mode: 'continuable'; readonly label: string }
  ))
  | {
    readonly kind: 'diagnostic'
    readonly id: SessionId
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }
```

实现形态：`listChildren` = 自管枚举（id、activity、hasChildren、`origin` 过滤，全部来自 header 事实）+ 投影阶梯（mode/label）。逐 child 的 `listEvents`、精确 `readEvent`、描述符定位与就地分类机器整体删除。

对每个枚举出的 child，阶梯取值结果按四态映射成行：

| 阶梯取值结果 | 行 |
| --- | --- |
| 快照含 `subagent` 值 | child 行 |
| 快照在、值缺席，且 child **inactive** | diagnostic 行，reason `corrupt`（定局残骸：无、损坏或版本不认识的描述符，不再细分） |
| 快照在、值缺席，且 child **running** | 行不出现（创建窗口：描述符尚未追加，与旧实现同窗口 omit） |
| cold 整读失败 | diagnostic 行，reason `unavailable` |

- `unsupported` 不再被产出：类型与 wire 枚举按"数据结构保持现状"留存该成员，本记录留档其为不再产出。
- descriptor-less 定局残骸从旧实现的 omit 归入 `corrupt` diagnostic——库里的坏、死子会话可见，不静默消失，这正是保留 diagnostic 的原始动机。

已知边界偏差（有意接受，随本记录留档）：

- 死于发布窗口的 fork child，seed 里若有祖先描述符，last-wins 会给出祖先身份，误现为 child 行；恢复仍按 own-suffix 折叠权威失败（`NOT_RESUMABLE`）。旧实现靠 `seedLength` 过滤将其 omit；projection unit 看不到 header，接受此残骸级偏差（`subagentTiming` 有同类既有暴露）。
- own suffix 出现多个描述符，旧实现判 corrupt，现 last-wins 取末者（provider 契约本就保证恰一）。
- live/persisted header 冲突，旧实现是 per-child corrupt；现枚举 live 优先、不做一致性校验，冲突不再被察觉，以 live 记录成行。
- 损坏存储的源读失败（如坏 surface 被冷读整读拒收），旧实现映射 per-child `corrupt`，现统一成 `unavailable` 行（读侧无从区分成因）。

消费面：wire、tool、GUI 的 diagnostic 处理**全部保持现状零改动**（`list_agents` 的 description 与 output schema 亦不动；该插件仅加载要求收窄——inject 去掉 `sessionQuery`）。唯一动行为的是 apiproxy 路由段：删 `hasSubagentDescriptor()` 扫描，`hasSubagentOwner` 只看 `header.origin`——pre-#1569 的无 `origin` 存量不再被认作 subagent 属主，其本就不进目录，pre-release 立场接受。

### 附带工作项：session-query 读路去 clone 与浅 readonly

- `SessionCorpus.load()`、`snapshotLive`、`listSessions` 等移除 structuredClone：live Session 的事件快照数组与事件载荷已深冻结（core/session 的 `deepFreeze` 加 `Object.freeze`），持久化读出的对象图为独占新建，克隆纯属浪费。
- 公开查询输出标注**浅 readonly**（顶层属性与数组位）；深只读化被实证否决（见替代方案），深层不可变由 core/session 的运行时深冻结事实保证，类型层面不再表达，`DeepReadonly` 不进任何公共包。
- 契约措辞与 `projectMany` 的借用契约（"borrowed only for that call"）对齐：整个 corpus 面向消费方统一为"只读视图，不得留存可变引用"的不可变借用视图；需要留存的自行克隆。

### 改动面清单

| 区域 | 文件 | 改动 |
| --- | --- | --- |
| subagent | projection.ts、projection-types.ts、index.ts | 新 `subagent` unit 与注册 |
| subagent | list-children.ts 及类型 | 重写为自管枚举 + 投影阶梯四态映射；删 session-query 依赖、逐 child 事件读取与就地分类机器；错误码 `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE` 换 `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE` |
| session-query | index.ts、corpus.ts | 读路径去 clone，公开输出浅 readonly 借用视图（净变化仅此） |
| host/apiproxy | api-proxy.ts | 删 `hasSubagentDescriptor`，属主判定只看 `header.origin` |
| tool | tool-subagent-control/list-agents.ts | 加载要求收窄（inject 去 `sessionQuery`）；model-visible schema、描述与渲染零改动 |
| wire/client | api/subagents.ts、runtime sessions/service.ts、GUI | **零改动**——行形状与 diagnostic 处理不变 |
| core/session、session-persistence、session-projection(-cache)、session-query-sqlite | — | **零改动** |
| 测试/快照 | 相关 spec 与 snapshot | 随行为更新，提 PR 前统一处理 |

### 推进节奏

1. `subagent` projection unit 与注册（纯增量）。
2. session-query：corpus 去 clone 与浅 readonly 借用视图。
3. `listChildren` 重写（自管枚举 + 投影阶梯）；tool 加载要求收窄；apiproxy 路由段 `hasSubagentDescriptor` 删除。
4. 测试与快照统一更新，整体 diff 评审后再拆 commit。

配套文档随实现 PR 处理：[session-projection RFC](2026-07-27-session-projection-and-command-log.md) 增补一节，记录 `subagent` 身份 unit 与 snapshot/restore 两处既有读法的消费实例（registry 契约零改动）；[durable-subagent-catalog 记录](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)的列表读路径段落随实现更新并与本记录交叉链接。

## 考虑过的替代方案

**mode/label 进 SessionHeader。** 零读保证最强——列表只看 header 就能成行。但 header 形状变更传导两个 persistence backend 与 header 兼容检查；SQLite 存量直接拒收，JSONL 存量只能 unknown 降级或 backfill。读时现算对存量的答案是"第一次列表一次 `inspect` 现算"，不碰持久格式。

**projection-cache 阶梯（v3 稿：`cachedSnapshot ?? coldSnapshot` 加 fail-soft 写回）。** 机制成立——session-projection-cache 的 checkpoint 阶梯本就为冷读设计。但它给 subagent 域在 `sessionProjections` 之外再引入 `sessionProjectionCache` 依赖，且 checkpoint 是一套新增的派生数据持久化与失效编排（floor/identity/putSoft）；读时现算不需要任何持久派生。

**给 persistence 加有界读原语抢救存量。** 为一次性问题新开 seam 原语；被读时 `inspect` 整读取代——存量第一次被列表时的整读就是取值本身。

**list 行 mode/label 可选化（v4 一稿）。** 健康数据必然可算；可选化只是把垃圾数据的处理复杂度外溢给全部消费方——每个消费面都要长出过滤分支和 unknown 展示态。强契约加算不出即 omit 更干净。

**彻底删除 diagnostic 行（v5 一稿）。** 删除把库损坏的可见性外溢为行静默消失，wire/tool/GUI 反要各自承担契约与快照变更；而保留只需列表侧按投影值缺席与 activity 派生分类，零成本。库里的坏、死子会话必须可见是 diagnostic 存在的原始动机，保留后消费面整体零改动。

**registry 计算失败通道（per-unit 容错加 `failures` 附加字段）。** 为把损坏、版本不认识报告给消费方，曾考虑让 registry 捕获 unit 异常并在 snapshot 旁附 per-key 失败态。被否：failure 不是值，也不必是通道——unit 永不抛错，缺席本身就是信号，"大不了算出来没有"，如何呈现是消费方要考虑的事。该路线讨论顺带留下一个独立观察：vendor cordis 的 `emit`（[vendor/cordis/src/events.ts](../../../../vendor/cordis/src/events.ts)）对 listener 抛错零捕获，投影驱动挂在 `session/event` 上时 unit 异常会沿 emit 逃逸——这加重了"unit 永不抛错"纪律的分量，但 emit 容错的修复不属于本记录范围。

**值随 query 索引 preparation 落库（v4/v5 定稿，一度施工）。** 投影值在 sqlite backend 的对账重建里折叠落进 session 索引行，读稳态零日志；`projectionsFor` 批量读面、行值随 `(key → stateVersion)` 注册集存储的失效对账与 SCHEMA bump 均已施工过。整体退役：方向反了——查询基础设施被迫认识领域词汇（投影列、注册集对账），而唯一消费方 subagent 列表读时现算即可满足；消费方归零后，这套派生持久化没有存在理由。`SESSION_QUERY_PROJECTIONS_UNAVAILABLE` 随读面一并删除。

**subagent 手工 parse 加进程 memo 加创建播种（v6 稿）。** 为摘除 session-query 依赖，曾考虑 subagent 自己解析描述符事件、以进程内 memo 避免重复整读、创建时播种初值。被 v7 阶梯取代：live 走 `sessionProjections` 水位缓存、cold 走 `registry.restore`，复用 registry 这一份折叠权威，不再出现第二份描述符解释逻辑，也不引入进程态缓存与播种时序。

**session-query 输出面 DeepReadonly（去 clone 一稿）。** 公开查询输出深只读化，以在类型层面钉死不可变借用。实证否决：3 处 TS2589（类型实例化过深）加 17 处数组位传染（消费方数组方法与展开处被迫跟改）；退回浅 readonly，深层不可变由 core/session 的运行时深冻结保证。

## 验收标准

- 稳态列表读代价：live child 全程零 events 读取（仅注册表水位缓存）；cold child 每次 `listChildren` 恰一次 `persistence.inspect` 整读；由 subagent 测试断言。
- 行为等价：同一语料下，新实现产出与旧实现相同的行集合（child 行的 id、mode、label、activity、hasChildren 与 diagnostic 行的 id、reason），例外仅限本记录留档的语义变化——descriptor-less 定局残骸由 omit 改为 `corrupt` 行、`unsupported` 归并入 `corrupt`、四条边界偏差（stillborn fork 祖先身份、多描述符 last-wins、header 冲突不再察觉、损坏源读失败由 `corrupt` 转 `unavailable`）——且每处变化有测试钉住新行为。
- 四态映射成立：快照有值成 child 行；inactive 缺值产生 `corrupt` 行（含 descriptor-less 定局残骸）；running 缺值缺席（创建窗口）；cold 整读失败映射 `unavailable`；`unsupported` 不再产出。
- 错误契约：`ctx.sessionProjections` 未挂载时 `listChildren` 于枚举前以 `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE` 失败（零 children 部署同样确定失败）；`SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE` 从代码与文档中消失。
- persistence 缺席退为 live-only 枚举，不报错，live child 照常成行。
- per-child 隔离：单 child 整读失败只产生该行 `unavailable`，sibling 不受影响。
- `hasSubagentDescriptor` 删除后属主判定只认 `header.origin`；`list_agents` 的 description、output schema 与既有无密钥快照零变化，钉住 wire/tool/GUI 零改动。
- corpus 去 clone 后公开输出为浅 readonly 借用视图，既有 session-query 行为测试全数通过。

## 风险

- **折叠规则分叉。** "折叠只在 registry 一份"是本设计的承诺；若未来某消费面绕开 registry 手写折叠，各读面的值可能漂移。缓解：列表两级阶梯与 GUI history 冷读走的都是 registry 的同两处读法（snapshot/restore），不存在旁路折叠。
- **cold child 的每次列表整读成本。** cold child 每次 `listChildren` 都做一次 `inspect` 整读现算，成本与其 transcript 大小成正比、随列表频率重复；定案"算完即止"，不建缓存、不回写。同 id 短期重复整读可命中持久化协调器准备阶段的 LRU 复用，但列表不依赖它；live child 全程零读。显式接受。
- **诊断语义的四处边界偏差。** stillborn fork 的祖先身份误现为 child 行、多描述符改取末者、header 冲突不再被察觉、损坏源读失败由 `corrupt` 转 `unavailable`——完整语义与接受理由见提案的已知边界偏差清单。均为残骸级数据的展示或分类偏差，恢复鉴权不受影响。
- **pre-#1569 存量属主判定收窄。** 无 `origin` 的旧 child 不再被认作 subagent 属主。其本就不进目录，pre-release 无兼容承诺，接受。

## 相关

- [durable-subagent-catalog 与 list_agents](../../implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)——被本记录部分取代：描述符仍是 mode/label 的持久权威与折叠输入，列表的枚举与取值改为自管合并加投影阶梯。
- [session projections 与命令生命周期日志](2026-07-27-session-projection-and-command-log.md)——registry 契约的权威；本记录为其新增 `subagent` 身份 unit，并成为 snapshot/restore 两处既有读法的消费实例。
- [web subagent conversations](../../implemented/feature/2026-07-27-web-subagent-conversations.md)——`SessionHeader.origin` 的出处（#1569），身份判定去日志化的前半步；其 history 冷读（inspect 前缀加 registry 折叠）是本记录取值阶梯的同款先例。
- [发布前可复用的 Session 准备阶段](../../implemented/architecture/2026-08-05-session-preparation.md)——`inspect()` 冷读与 LRU 复用；cold child 整读的成本模型建立其上。
