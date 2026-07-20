# fw-react 实现计划（web-react 包；契约=api-contracts v3 §2）

> 2026-07-21 预习完成。权威序：v3 §2/§1 → architecture §11/§13/§17 → dispatch 任务行+§2 → conventions → t0-checklist。
> **状态 2026-07-22：v3 §2 全部完工**。七刀：e873a846e 依赖+.d.ts / e7384bc6e bind / c7d20d53a store 引擎 / 219ce8af9 useInvoke / f8890b960 bind.spec / 4de74fac5 SessionProvider+RootBindingProvider / 67679d870 scopedSlots。5 spec 35 测全绿，包内 typecheck 绿。
> 与计划的偏差：①immer 走 update() 内 produce 而非 immer 中间件（中间件 setState mutator 泛型与 vanilla StoreApi 冲突；行为面同）；②仲裁采纳 renderBody/RootBindingProvider（932716e02）。
> 待 T1/T2：~~换真 ui-slots core 重跑 scoped-slots.spec；补 @ts-expect-error 越权负样本~~ 已落（f2eb2287c；初版 a367d78a3 被主会话 reset 误剥、暂存区无损重落，主会话认账并立规：共享 worktree 全员零历史改写）。剩：UseSession 收窄对齐 rt-core 的 ConversationSnapshot（rt-core 类型归家时 main 会叫）。
> 终态：6 spec / 39 测全绿；tsc -b 绿。待命=T2 后机动支援（convo-b Profiler 断言/W5 验收）。

## 1. createSnapshotStore（store 子路径）

**zustand 留 ~4.4.7 不升 v5**：我们只用 vanilla `createStore` + 中间件层，自己经 uSES 出 hook，v5 的变化全在它的 React useStore 层（我们不用）；mutative 换 immer 无 P-I 级收益。不动=无需仲裁，报备即可。

**中间件链**（外→内）：`persist?(rafFlush?(subscribeWithSelector(immer(init))))`

- **顺序理由**：rafFlush 必须在 subscribeWithSelector 外侧——sws 初始化时捕获当时的 `api.subscribe` 作为底座；rafFlush 先跑（外侧）才能让 sws 的 selector 订阅也走合批面。persist 不碰 subscribe，放最外。
- **rafFlush 设计**（自研，真中间件形态）：
  - 持自己的 listeners Set；替换 `api.subscribe` 为「注册进自己的 Set」；
  - 用捕获的原始 subscribe 注册**唯一一个**内部监听：置脏标记 + `requestAnimationFrame(flush)`（已排帧则跳过）；
  - flush：清脏标记后逐个通知自己的 Set。一帧内 N 次 setState = 1 次通知。
  - `flush:'sync'`（省略该中间件）= 每 setState 同步通知。**默认 'sync'**：契约未定默认；受控输入（drafts textarea）与用户手势要求同 tick 通知（architecture §5 Notifier 纪律：延迟到微任务/帧会 DOM 回滚+光标跳尾）。帧驱动 store（sessions.list 等）由创建方显式传 `'raf'`。→ 报备 main，契约若想钉死默认值再补一句。
  - raf 缺席环境（node 单测）回退 queueMicrotask；测试用假 raf 注入计数。
  - 已知取舍（注释入码）：'raf' 模式下同帧内新挂载组件读到新 state 而旧组件未收通知——帧级瞬时不一致，与对象层 Notifier 微任务合批同性质；只用于帧驱动 store。
- **immer**：官方 `zustand/middleware/immer`，`update(mutator)=setState(mutator)`（recipe 形态）、`set(next)=setState(next, true)`（整体替换）。
- **dev freeze**：immer 产物自带 freeze；`set(next)` 整体替换绕过 immer → dev 下（`process.env.NODE_ENV!=='production'`）deepFreeze(next)。
- **persist**：opt-in `{name}` → zustand persist + localStorage（纯 CSR，无 SSR 分支）。
- 门面（SnapshotStore<T>）：`getSnapshot=api.getState`、`subscribe`（走合批面）、`update`、`set`、`useSelector=bindSnapshotSelector(this)`。

## 2. bindSnapshotSelector（uSES 桥）

- 引擎：`use-sync-external-store/shim/with-selector` 的 `useSyncExternalStoreWithSelector`（zustand 4.x 既有传递依赖，需在 web-react package.json 补显式 dep + @types devDep——离线可解，包已在 store 里）。
- 绑定时（每 store/Session 构造一次）闭包生成稳定的 `sub=(cb)=>w.subscribe(cb)` 与 `getSnap=()=>w.getSnapshot()`——**方法经箭头闭包绑定 this**（直接传 `w.subscribe` 会丢 this），且闭包只建一次=引用永稳。
- uSES 契约四条落点：①getSnapshot 纯读缓存引用（源头保证：Session 恒返缓存、store 返 zustand state）；②subscribe 稳定（上条闭包）；③纯 CSR 不传 getServerSnapshot；④等值短路：eq 缺省=Object.is（with-selector 语义），对象切片调用方传 shallowEqual。selector 结果 memo 由 with-selector 自持（state ref + selector/eq 同一性缓存），并发重放安全（getSnapshot 幂等，无 render 期副作用）。
- shallowEqual = re-export `zustand/shallow`。

## 3. scopedSlots 工厂（renderSlot 出口）

- `scopedSlots(core, ...keys)` 返回 `{ renderSlot }`；renderSlot 返回内部组件 `<SlotOutlet>` 元素。运行时白名单双保险：key ∉ keys → throw（编译期由泛型 K 挡）。
- **订阅**：SlotOutlet 内 `useSyncExternalStore(cb=>core.subscribe(key,cb), ()=>core.getVersion(key))`——version tick 驱动 `core.entries(key)` 重读（微任务合批归 core）。
- **按 kind 渲染**：spec 缺失（define 前渲染）=throw fail loud；single：0 条→fallback??null；list：order 排序+`only` 过滤 id；keyed：`entryKey` 命中，无→fallback。
- **每 entry 包 ErrorBoundary**（自写小类组件，fallback=极简错误占位含 key/entry id；框架级英文文案，不进 i18n）。
- **props 三源合并**：`{...标配注入, ...cachedInject(binding), ...ownerProps}`（owner 最后=可覆写，与契约顺序一致）。
  - 标配注入：session 坑注 `useSession=binding.session.useSelector`；root 坑无。
  - **inject 缓存链**：
    - session 坑：`WeakMap<SlotEntry, WeakMap<SessionBinding, props>>`——外层 key=entry 对象（依赖 fw-slots 保证 entry 对象跨 entries() 快照恒等，**跨包假设，需与 fw-slots 钉死**）；内层 key=binding 对象（runtime 保证 per-session 恒等引用）。session 拆除→binding 失引→WeakMap 自动回收。
    - root 坑：`WeakMap<SlotEntry, props>`，inject 只调一次。
  - session binding 来源=BindingContext（web-react 模块私有 React context，SessionProvider 写、SlotOutlet 读）；session 坑在 Provider 外渲染（context 空）=throw fail loud。
- P-I 单形态：无 Suspense，接口不留 renderSuspenseSlot（台账 6b）。

## 4. createSessionProvider / useInvoke

- SessionProvider：`useCurrent()` → 无 id 时 `renderEmpty?.()??null`；`resolveBinding(id)`（恒等引用）→ undefined 同走 empty；`<BindingContext.Provider value={binding} key={id}>` 重挂子树。
- useInvoke：pending **不走 setState**（architecture §17 幂等五条）——per-hook 外部微 store（useRef 持 `{count, listeners}`）+ uSES 读 `count>0`；invoke 经 latest-ref 模式包 fn=引用永稳；并发重入用计数（多次在途 pending 恒真）；rejection 归 domain 层报错（事件回声），框架侧 console.error 兜底后复位 pending。

## 5. T0 桩对账（05756560b）

- store/index.ts：五件签名与 v3 §2 逐字一致 ✓。
- index.ts：结构一致；`SessionId→string`、`Context→unknown`、`ConversationSnapshot→ConversationSnapshotLike` 为声明的 T0 占位（桩注释已标 rt-core 替换）✓ 可接受。**遗留类型归家问题**：v3 §2 写 `UseSession=SnapshotSelectorHook<ConversationSnapshot>` 但 ConversationSnapshot 住 runtime（依赖方向 runtime→web-react，不可反向 import）——真类型的家需 rt-core/main 定（候选：类型下沉可共享位，或 runtime 侧收窄别名）。不阻塞我（实现全程泛型 T）。
- ui-slots 桩：`OwnerProps=Partial<E['props']> & object` 占位（精确 Omit 归 fw-slots）——我的越权/漏传 props 类型负样本在 fw-slots 真实现落地前只能部分生效，测试先写 @ts-expect-error 待激活。

## 6. 契约缺口（待 main 仲裁，不自行改接口）

1. **SessionProvider「渲染 conversation+details 两坑」但 deps 无 slots 面**：web-react 拿不到那两个 key（它们是 ui-layout 的 declare merge，web-react 引用=幽灵依赖，且违反白名单纪律「谁 own 谁 render」）。**提议**：deps 加 `renderBody:(id:SessionId)=>ReactNode`（装配方=ui-layout/壳闭包自己的 scopedSlots 供给），Provider 只管订 current+解析 binding+key 重挂+context。
2. **root 坑 inject 的 RootBinding.ctx 无供给通道**：scopedSlots(core,...keys) 签名里没有 ctx；sidebar 契约明写 `b.ctx.layout` 绑 actions。**提议**：web-react 补一个导出 `RootBindingProvider: FC<{binding: RootBinding; children}>`（React context，壳在 AppRoot 顶部挂一次），SlotOutlet 渲染 root 坑 inject 时读取；缺失=throw。

## 7. 测试计划（宽松期口径：关键逻辑有测）

- store.spec：结构共享（update 后未动分支引用不变）；raf 合批计数（假 raf：N 次 update=1 通知）；sync 模式同步通知；persist 往返；dev freeze 抛错；shallowEqual 语义。
- bind.spec（jsdom）：等值短路（eq bail 不重渲）；selector 变更响应；订阅引用稳定（重渲零重订）；StrictMode 双调安全。
- slots.spec（jsdom，假 SlotCore+假 binding）：三 kind 渲染矩阵；version tick 重读；ErrorBoundary 隔离（单 entry 炸不塌邻居）；inject 缓存命中计数（同 entry×session 只调一次；换 session 重调）；三源合并优先级；白名单运行时 throw+@ts-expect-error 负样本。
- provider.spec（jsdom）：current 切换重挂（key 语义）；binding 恒等透传；empty 分支。
- useInvoke.spec：pending 时序、并发重入计数、fn 变更后 invoke 引用不变。
- 工具面：vitest jsdom；渲染用 react-dom/client + act（若 workspace 已有 @testing-library/react 则用之，开工时查）。

## 8. 开工序（T0 广播后）

1. store 子路径全量+store.spec（可独立编译单元，最先落）。
2. bindSnapshotSelector+shallowEqual re-export+spec。
3. useInvoke+spec。
4. BindingContext+createSessionProvider+spec（缺口 #1 裁决前先按提议形态留内部实现位，导出面不动）。
5. scopedSlots+ErrorBoundary+缓存链+spec（缺口 #2 同上）。
6. T1 后删 ui-slots 桩换真包，激活类型负样本。
