# RFC: 作用域分层存储——每 scope 一个聚合层与统一调度 helper

Status: proposed

[English](2026-07-12-scoped-layers-store.md) | 中文

## 问题

agent 作用域落地之后（[agent-scope RFC](../../implemented/architecture/2026-07-08-agent-scope-contexts.md)、[运行时设计篇](../../implemented/architecture/2026-07-12-agent-scope-runtime-design.md)），「一张全局层加若干 per-agent 层的注册表」成为反复出现的形态，而每一处都是手写的。今天已有七个登记口——`dsh-tools` 的 `tools.register`/`tools.restrict`/`tools.guard` 与 `dsh-system-prompt` 的 `section`/`tools`/`variable`/`protect`——每处都是一个全局容器配一张自己的 `Map<ScopeKey, 容器>`，并重复同一段 10-15 行的 effect 编排：读调用方上下文的标签、按需建层、校验、变更、yield 一个「删条目 → 回收空层 → 发 change 事件」的回滚，然后发事件并返回 cordis effect 的原始 disposer。

除此之外：风险集中在编排细节上：
- 回滚必须在 change 发出之前被收集（抛错的监听器才能回卷插入而不是泄漏）
- 返回的 disposer 必须是 cordis 自己的那个函数（包装器会静默破坏嵌套的有序拆除）
- 清空的专属层必须被回收（被 dispose 的 agent 不得留下以死 `ScopeKey` 为键的残余）

每个新消费者都要把这一切重新写对一遍，而各副本的写法已经分叉——`dsh-tools` 里有两个私有 `layerFor`，`dsh-system-prompt` 里是四处内联 IIFE。

最后，一个 agent 在一个服务里的贡献散落在几张互不相识的 Map 里——不存在一个「这个 scope 在这里贡献了什么」的对象——而消费者还在持续增多：guard 与提示词 protection 是最近落地的一批，per-agent 的 `fs/*` 策略、`llm/*` 覆盖、per-agent compaction 策略都排在同一个模式上。

## 提案

`dsh-scope` 新增 store 模块（其 `src/` 下新增 `store.ts`，peer 依赖仅 cordis，与键类型无关），核心是一条分工：**业务逻辑封在层类里，helper 只负责调度层**。一个服务一个 helper 实例；其 Map 的 value 就是「一个 scope 在该服务的全部贡献」这一聚合对象。

- **`ScopedLayers<L>`**——具体的调度器，不作继承点。持有全局层与一张 `Map<ScopeKey, L>`，按需以 `new layerClass(scope, this)` 建层，层 `isEmpty()` 时回收，并把所有写入收拢到 `effect(ctx, action, options?)`。单一 `ctx` 参数同时决定可见层（`scopeOf(ctx)`）与属主 fiber（`ctx.effect`），「对 X 可见、随 Y 销毁」因此不可表达——与 agent-scope RFC 否决显式 scope 参数用的是同一个形状论证。action 可以产出单个撤销、撤销的可迭代、Promise 或异步可迭代——即 cordis `Effect` 的四种形态——且撤销允许异步。helper 把收集到的撤销（逆序执行）、空层回收与 change 通知合成**一个** disposer，并在通知运行**之前**先把它交给 cordis：因此 change 监听器抛错时，cordis 会执行已收集的回滚再重抛，与今天手写的「yield 在 emit 之前」逐字等价。读取件是 `global`/`peek`，外加把表视图提升到两层的三个 selector 原语——`merge`（命名条目，专属遮蔽全局、保留全局位置，可选放行谓词）、`values`（拼接、含匿名条目、刻意不做遮蔽）、`keys`（限制前名字全集）——以及跨全部层、返回数组的 `forEach`/`filter`/`map`。
- **`createLayer({ 表名: table<V>(kind) })`**——`defineTool` DSL 传统的类工厂。生成的基类在构造器里建好每张声明的表、把 scope 传下去、接收同族回引（`protected readonly layers: ScopedLayers<this>`，由 helper 建层时注入；多态 `this` 型在子类中自动收窄），并对声明的表聚合 `isEmpty()`。`layer.<表名>` 是带完整类型的映射属性，写错表名是编译错误；表名 `scope`、`isEmpty`、`layers` 保留，冲突即抛。业务子类在类体里追加领域方法——单层查询、登记校验，以及经 `this.layers` 的跨层**只读**（写入仍必须走 `effect`）；完全自定义的层也可以只实现单方法接口 `ScopeLayer`（`isEmpty()`）。
- **`Entries<V>`**——罐装条目表：命名条目（`insert`，同层重名抛一对指向 `agent.ctx` 的标准化文案）与匿名条目（`append`，进程内唯一 symbol 键、O(1) 撤销删除）共用一张保插入序的 Map；读视图（`keys`/`entries`/`values`）返回数组快照。

`dsh-tools` 把三张表合并进一个 `ToolLayer`（领域方法 `addRestriction`——空过滤器/读取一次性/保留名/已知名校验，保留名单因读服务状态而以数据传入——加上 `admits` 与 `guardReason`），`dsh-system-prompt` 把四张表合并进一个 `PromptLayer`（`addProtection` 经同族回引做全局冲突自检，加上 `shadowedSections` 谓词）。每个门面都变成单次 `effect` 调用，携带 per-call 的 `label`、`silent`（guard 不发 change 事件）或 `scopedOnly`（布尔，或携带领域报错文案的字符串）选项。`assemble` 留在门面，三条硬理由：它没有合法接收者（主体 scope 的层可能不存在，而读路径绝不建层）、遮蔽语义强制先合并后求值（逐层渲染会求值被遮蔽的 provider，行为可观察地改变）、组装 waterfall、`toolOrder` 与 protection 恢复需要层不应持有的服务级资源。

迁移保持行为等价，带两个声明的例外：三处重名文案统一为一个模板（断言旧文案的测试在同一变更中更新）；校验相对 effect 边界发生挪动（restrict/protect 的检查移入 action，variable 的名字正则移到门面），因此多重非法输入的报错**先后**可能改变，而所有单一错误路径不变。两个已知的不可观察差异：聚合层要等全部表清空才回收；读视图是快照而非活容器（仅对「在自己的遍历回调里再注册」可见）。

## API 草图

```ts ignore-check
interface ScopeLayer {
  isEmpty(): boolean
}

type LayerClass<L extends ScopeLayer> = new (scope: ScopeKey | undefined, layers: ScopedLayers<L>) => L

declare function table<V>(kind: string): TableSpec<V>
declare function createLayer<S extends Record<string, TableSpec<unknown>>>(
  spec: S,
): LayerClass<ScopeLayer & { readonly [K in keyof S]: Entries<EntryTypeOf<S[K]>> }>

type Undo = () => unknown
type LayerAction<L> = (layer: L) =>
  | Undo
  | Iterable<Undo, void, void>
  | Promise<Undo>
  | AsyncIterable<Undo, void, void>

class ScopedLayers<L extends ScopeLayer> {
  constructor(layerClass: LayerClass<L>, options: { label: string; onChange?: () => void })
  readonly global: L
  peek(scope: ScopeKey | undefined): L | undefined
  merge<T>(scope: ScopeKey | undefined, pick: (layer: L) => Entries<T>, admitGlobal?: (name: string) => boolean): Map<string, T>
  values<T>(scope: ScopeKey | undefined, pick: (layer: L) => Entries<T>): T[]
  keys<T>(scope: ScopeKey | undefined, pick: (layer: L) => Entries<T>): string[]
  effect(ctx: Context, action: LayerAction<L>, options?: { label?: string; silent?: boolean; scopedOnly?: boolean | string }): () => Promise<void> | void
  forEach(fn: (layer: L, scope: ScopeKey | undefined) => void): void
  filter(fn: (layer: L, scope: ScopeKey | undefined) => boolean): L[]
  map<T>(fn: (layer: L, scope: ScopeKey | undefined) => T): T[]
}

class Entries<V> {
  constructor(kind: string, scope: ScopeKey | undefined)
  insert(name: string, value: V): () => void
  append(value: V): () => void
  get(name: string): V | undefined
  has(name: string): boolean
  keys(): string[]
  entries(): ReadonlyArray<readonly [string, V]>
  values(): readonly V[]
  isEmpty(): boolean
}
```

迁移后的消费者长什么样——现存最重的登记口从 30+ 行编排缩为一份声明加一行门面：

```ts ignore-check
class ToolLayer extends createLayer({
  tools: table<ToolDefinition>('tool'),
  restrictions: table<ToolRestriction>('tool restriction'),
  guards: table<ToolGuardRegistration>('tool guard'),
}) {
  addRestriction(filter: ToolRestriction, reserved: readonly string[]): () => void { /* validate, snapshot, append */ }
  admits(name: string): boolean { /* intersection over this.restrictions.values() */ }
  guardReason(view: Readonly<ToolExecution>): string | undefined { /* first monotonic denial */ }
}

class ToolRegistry extends Service {
  private readonly layers = new ScopedLayers(ToolLayer, {
    label: 'tools',
    onChange: () => this.ctx.emit('tools/change'),
  })

  register(definition: ToolDefinition): () => Promise<void> | void {
    return this.layers.effect(this.ctx,
      layer => layer.tools.insert(definition.name, definition),
      { label: 'tools.register()' })
  }

  visible(scope?: ScopeKey): ToolDefinition[] {
    return Array.from(this.layers.merge(scope, layer => layer.tools, name => this.admits(scope, name)).values())
  }
}
```

## 备选方案

**每 scope 一个注册表实例，父子委托链。** 实例爆炸；「部署工具加我的工具」的合并视图要每个服务手写一个委托注册表；单订阅观察者（持久化、ACP bridge）必须逐实例发现并订阅；委托链表达不了减法（restriction）。子注册表还得反向触及父上下文，扩大暴露面。

**注册 API 上的显式 scope 参数。** agent-scope RFC 已否决：漏传参数即静默注册为全局，且该形状能表达「对 X 可见、随 Y 销毁」——几乎必然是 bug。

**只抽数据结构、编排留在服务。** 消掉的是重复里安全的那一半，留下的是危险的那一半——回滚先于 emit 的顺序、原始 disposer、回收规则，恰是 bug 所在。

**内置视图语义的固定容器 helper。** 容器形态与合并策略被钉死在 helper 里；业务没有自由度，任何命名或单值变体都变成对 helper 的功能诉求。

**每张表一个 helper。** 复刻今天的散装簿记——那正是被替换的现状：每服务 N 张 scope Map，agent 的贡献没有聚合。

**`helper.get(ctx).effect(...)` 两步式登记。** 把建层与挂生命周期拆成两步；两步之间抛错会搁浅一个空层，返回的 handle 还是每次调用一笔额外分配。

**层持有 ctx、自己注册 effect。** 把数据对象变成生命周期管理者，编排在每个业务类里重演一遍。

## 验收标准

- `store.ts` 落在 `dsh-scope`（peer 依赖不变：仅 cordis；模块图位置不变），逐文件 100% 覆盖，包括：层簿记与回收、四种 action 形态、合成顺序、change 监听器抛错回滚（条目被回卷、重名检查可再注册）、新建层的失败回收、`label`/`silent`/`scopedOnly` 选项、`createLayer` 构造、保留表名、同族回引类型、`Entries` 命名/匿名语义。
- `dsh-tools` 与 `dsh-system-prompt` 各收敛为一个 `ScopedLayers`；所有既有测试通过，改动仅限已声明的重名文案断言更新；每个登记门面都是单次 `effect` 调用，并继续返回 cordis effect 的原始 disposer。
- 行为按上文等价性声明与老基线一致：两个声明例外（统一文案；多重非法输入的报错先后）、两个不可观察差异（聚合回收时机；快照读视图），此外无他。
- 文档随同一变更落地：`dsh-scope`/`dsh-tools`/`dsh-system-prompt` 的 README；实现后本 RFC 移入 `implemented/`，并就地更新[运行时设计 RFC](../../implemented/architecture/2026-07-12-agent-scope-runtime-design.md) 的注册章节。

## 风险

- 层/门面边界可能不适配某个未来消费者的形状。缓解：裸 `ScopeLayer` 接口始终是兜底；把 `LayerClass` 拓宽为可接受工厂（供有构造依赖的层）是已记录的非破坏扩展。
- `createLayer` 的映射类型工厂是刻意的类型体操。接受：`defineTool` schema DSL 是仓库先例，体操圈在 `dsh-scope` 内部。
- 两个等价性例外可能让断言精确重名文案或多重错误顺序的测试意外；在此声明，使评审是核对而非发现。
- 快照读视图会隐藏「回调在自己的遍历中注册」的条目——病态但可见的模式；快照使其转为确定性行为。
- 两个核心注册表同时迁移。缓解：设计期已完成逐行为对比，且 store 连同钉住等价性的测试先于任一迁移 commit 落地。
