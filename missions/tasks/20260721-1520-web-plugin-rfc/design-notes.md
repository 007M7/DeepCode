# dsh Web 插件体系 RFC——细则版（自用）

> 2026-07-21。本文档是 [walkthrough.md](walkthrough.md) 的全量细则底稿：裁决出处、约束红线、边界语义、验收面、开放问题。给实现 owner 和未来的自己看；用户 review 走读版即可。裁决源=2026-07-21 主会话对话（用户逐项拍板），冲突以对话原话为准。

## 0. 裁决登记（时间序）

| # | 裁决 | 要点 |
|---|---|---|
| D1 | 浏览器侧不需要强对等，"有 cordis 插件就行" | 拍掉 Loader 1:1 镜像/reload 联动；保留送达层基建 |
| D2 | 需求单 P0–P2（原文见对话） | 尽量插件化；左侧按钮/statusline/tabs/tool卡/详情tab/Traj行为/主题单槽/i18n fallback |
| D3 | 统一 slot registry，不要 N 个 registry | slot scope 路径化（session.chat.toolview）；嵌套声明（区域拥有者开子坑）；三型语义（唯一/列表/按对象多实例） |
| D4 | 包导出注册函数而非组件堆；client 有自己的不对等 cordis ctx | ctx 词汇：slots/i18n/theme/… |
| D5 | 点对点保留：绑定与不绑定 agent scope 的方法要能在声明处分清 | m.scoped('agent') / m.root() |
| D6 | scope 不能只是 key——host 的 Agent scope 是 Context 对象，client 侧要"对等造一遍" | scope 树镜像重建；插件集不对等、scope 树对等 |
| D7 | session 走 SSE 的现状与"数据插件化"冲突 → 要么不动要么全走 | 用户点破半吊子桥 |
| D8 | 不纠结改动量，只论架构合理性 → 会话层信封协议全部收编 | **后续修正（D16）**：载体先还原为既有 SSE/POST，信封寄生其上；WS 收敛降为独立议题 |
| D9 | 两侧 session 范畴不对称是公理：host=过程，client=视窗（任意时机连上，要处理 history） | attach 状态机 |
| D10 | onSessionEvent 太 low level，消费面=物化投影；"history 全读"级别只有 session 一个 | 通道三级分类学 |
| D11 | React 数据管理希望整体在 Zustand → 划辖区：世界 vs 相机 | store 无运行时事实副本 |
| D12 | 聊天面板 props 怎么定 → 位置供数+薄容器；props=身份+展示参数 | hook 从 ctx 取数 |
| D13 | 渲染性能：更新频次/失效半径/重算面走查 | 五段管道、频率递减 |
| D14 | 多视图同订同一 session → 投影单例、订阅分道 | 惰性+保温、一致性边界=投影 |
| D15 | RFC 双文档：走读版给用户（图+类关系+示例代码+上下游链路）、细则版自用；主会话自己写不派 teammate | 本文档结构的由来 |
| D16 | RFC 里先不扯 SSE/POST 与 WebSocket 的关系——数据通道还原成以前的 | 信封/channel/epoch/seq/watermark 语义不变，寄生在既有 SSE mux + HTTP RPC 上；载体收敛（WS/Electron IPC）单独立项再议 |
| D17 | 信封定位确认："只是为了区分以前的 session 流或别的通道，可以预留" | 信封=通道分发+幂等账本，不承载业务语义；通道谱系 v1=session 流+预留插件私有通道 |
| D18 | rpc-log 裁撤 | 不做通道成员；C 级 v1 空置留给将来 metrics 类。（rpclog 面板/badge 的存续另议——通道层先不给它位置） |
| D19 | scope 不放信封层（用户直觉"不应该放这一层"，采纳） | attach 时用 (通道名, scopeKey) 解析出通道实例 id，信封只带实例 id；信封层不理解业务维度 |
| D20 | peer 整体暂缓（"点对点那个 peer 我们先不说"） | 本 RFC 不设计 peer；cordis-web 资产封存待另稿收编；预埋两处：通道谱系留位 + fork ctx 留挂点；动作类需求 v1 走通道 intent |
| D21 | SessionLog 是既有资产不重造；client session scope 必须做进 cordis 架构而非自立设施 | 图上标注"既有资产"；scope-created 处理函数体=一次 cordis 插件应用，无平行 scope 管理器；"ClientRuntime"改述为 client cordis root ctx 本身 |
| D22 | sessionHub 与 per-session session service 两个东西没必要并立；投影清单不是框架筛选对象 | sessionHub 裁撤：会话列表=root 级列表通道上的一个投影（壳声明）；镜像驱动降为运行时内部件。投影全部用户空间：框架只供 defineProjection 机制（reduce 调度/合批/快照/保温），类型定义权与 reduce 实现权归声明者，共享=import 同一 handle，按 handle 去重 |
| D23 | root service 应该只有 loader，其他都靠 loader 拉起来 | root 原生=bootstrap 最小集（carrier/mux 基建+loader，静态写死——鸡生蛋消解的既有裁决）；workbench/slots/i18n/theme 全部改为 loader 拉起的 bundled plugin，与第三方同权 |
| D24 | workbench 更名 **router**（"有 Router 知道各种 current 情况"）；slots/i18n/theme 认可；hooks 无级别、由 ctx 可见性管辖的解释认可 | router=当前选中/导航命令 service；另立 **ctx.sessions**（会话域入口）承接 session 相关消费面，细化中（见 §3.1a） |
| D25 | useService 暴露过分——全删重推：从 React 组件真实诉求出发重新设计 hooks | 组件诉求归并=订阅+动作两类。hook 收敛为两原语一糖：`useWatch(handle)`（唯一读）/ `useAction(handle)`（唯一写,返回 [invoke,pending]）/ `useT()`。**useService 彻底删除**（service 是 apply() 世界的词汇,组件只持 handle——防逻辑漂进组件,红线 16）;useProjection/useIntent/useWorkbench 都是前两者的用例。可见性=import 权+位置两道门 |
| D26 | 用户质疑"fork 架构哪来的"——盘 vendored 源码证实：本仓 cordis 无 ForkScope,只有 Fiber;host Agent Scope=dsh-scope mintScope（no-op 插件 Fiber+ctx.extend 打标+intercept） | 全文废弃"fork"词汇。多实例=不同 scope ctx 下多次 ctx.plugin() 得多个 Fiber;client session scope=mintScope 模式照搬,与 host 同架构。此前所有"fork"表述系我从上游旧版 cordis 记忆带入的错误词汇 |
| D27 | useWatch 需要澄清与既有"反模式"裁决的关系;hooks 必须严格守 React 高性能+多次运行幂等原则 | 之前被判反模式的是"订阅结果拷进 state/双份订阅簿记/在 render 里做副作用",不是订阅本身。useWatch=uSES 严格用法:getSnapshot 纯读+引用稳定（幂等,并发渲染安全）,subscribe 引用稳定,selector 等值短路;useAction 的 invoke 引用稳定。红线沉淀为 hook 实现契约五条（见 §4.2a） |
| D28 | 确认:client scope=agent scope 同套 intercept 架构,session 精度插件守 host tool/system-prompt 同一范式（读自己 ctx 的 scope key 反查）;追问 React 侧如何精确到一个 agent session | 缝合点=SlotOutlet:插件世界靠 ctx 继承,React 世界靠树位置继承。outlet 把"注册者在该 session scope 下的实例 ctx"放进内部 React context;hooks 取最近 Provider 的 ctx 解析 handle+填 scopeKey——组件不做反查、无 ctx 无路由。多实例=两子树两 Provider 两份累加器。跨 session 无隐式通道（读 root 列表投影或另开 outlet） |
| D29 | Provider 里放恒等的 scope 实例对象不会造成 React 反复刷新——确认;useWatch/useAction 是否太 low level?以现聊天/输入框通信范式校验 | 分层裁决:原语归框架（仅有的两条缝,守 §4.2a 幂等契约）,**领域 hook 归 owner 插件**——useConversation 范式原样照搬:owner export handle 的同时 export 组合 hook（快照+引用恒定 ops 包,C3 纪律由 useAction 继承）;签名去 sessionId 参数（scope 从树位置来）;纯展示组件 props 契约一行不改。框架不设"钦定领域 hook 清单"（与 §3.1 投影所有权同构） |
| D30 | "过于声明式"纠偏:用户本义=client ctx 上挂 interface 自己实现 service;插件间调用应是 ctx.conversation.send(...) 这种形态 | 四层定稿:**ctx service（cordis 本义,declaration merging+provide/inject）=插件间 API 面**;channel/intent zod 声明只属 wire 层（跨线边界才出现,不是插件 API）;领域 hook=owner 用原语把 service+投影拼给 React;组件只见 hook。scope 寻址循 host 范式:service 方法从调用方 ctx 读 scope key,scoped ctx 里 ctx.conversation.send() 自动打本 session;跨 session=ctx.sessions.get(key) 返回 **scoped ctx 视图**（get(id) 的答案）。新原语 usePluginCtx 仅限 hook 文件（组件里出现=lint 红线） |
| D31 | 追问 ctx.conversation 的获取链路与 get(key).conversation 可行性——要完整实例代码 | 机制核验（vendor/cordis + dsh-scope 源码）:①service=root 单例 provide,scope 敏感——**不是每 session 一个实例**;②per-session 实例"拿到"它零动作:scope ctx=fiber.ctx.extend({kScope}),extend 链共享 registry/reflect,root service 子 scope 直接可见;ctx proxy 保证方法收到 caller 的 scoped ctx,scopeOf(this.ctx) 读 key（host scoped 路由同机制）;③get(key).conversation 可行:get 返回真 Context（extend 链一员）,service 可见且 scopeOf=该 key——"带 key 路由"改述为"换 ctx"。完整四段实例代码进 walkthrough §7.0 |
| D32 | 现 apiproxy 是 sessions.prompt(sessionId,content) 一体式;实际链路=scope 到 session→找绑定 agent→.steer——client 是否也要一套 agents 集合? | **不要**。host 的 sessions/agents=一实体两面（agents 按 sessionId 键控 1:1,enter 强制 agent.id===session.id;api-proxy agentFor 已证）;client 的二象性已由 session 状态机表达（cold=无 agent/live=有/frozen=已终）,再建 agents scope 树=两本账。session→agent 解析是 host 权威（agentFor 含 resume-on-prompt）;client wire intent 只带 session scope key,永远不认识 agent;resume-on-prompt 的 client 观感=cold→live 迁移 |
| D33 | Scoped<Agent>/Scoped<Session> 两个路由面的寿命差异（agent carrier key=Agent 对象本身,resume=新路由身份）→ 用户拍板:**聊天对话按 session 精度,v1 不做 agent 级隔离** | wire 通道 v1 只有 session 绑定轴;挂 agent 寿命的 host 插件其 client 半边可能见 resume 前的 stale 状态——明知接受,记台账。预研过的两个启用方案存档:①通道 agent 绑定轴（实例随 agent 换代 chan-closed+新快照,epoch 兜）②session 状态机带 incarnation 纪元数（agent 面投影随纪元重置）。触发=第一个真实撞 stale 的插件 |
| D41 | wire 不改（用户自改 RPC 类型走 TS/zod 自动化,通道层另行处理）;开发者不该接触 projection 映射;关切收窄为"指定 session 的组件的 props 与 hooks 传递" | defineProjection 从公开 API 除名（reduce 是 conversation 等 feed 消费者的私有实现手法）;数据契约=Watchable 最小接口（getSnapshot/subscribe）;Session 类原样（已是 Watchable）。三通道定稿:①位置=框架内建 SessionScopeGate（**开发者不写**,Layout/框架自带）Provider 恒等 Session 引用;②活数据=useSession(selector)（内部 useContext 取 Session ctx——今天 useConversation 的 selector 化,非换架构）;③切片=props 递 owner 已物化 frozen 值。useSession 的暴露形态:导出给开发者 or 经 props.useSession 注入——两案待拍 |
| D42 | 确认三点:①SessionScopeGate 框架内建,开发者不写;②useSession 内部=useContext(SessionCtx),要给开发者一个获取途径;③**use hooks 可以绑在 props 上**（props.useSession(selector) 形态成立） | hooks-on-props 可行性确认:hook 规则约束的是调用时序稳定,不是函数来源——SlotOutlet 对某坑位的每次渲染,注入的 useSession 引用恒定（绑定该 scope 的 Session）,组件无条件调用即安全;类型上 SlotMap[K]['props'] 自带 useSession 签名,强类型完整。优点:组件零 import 框架 hook 包（依赖更干净,测试直接传假 useSession）;代价:props 不再是纯数据(白名单加"框架注入的 hook"一类,仍引用稳定不破 memo)。倾向:**两者并存**——props 注入为主推(插件组件零依赖),包导出为补(领域 hook 内部组合用) |
| D44 | 追问:①outlet 是否还要注 useSession;②register 的 key 是干什么的 | ①props 三源合并定稿:owner 供参(SlotMap 锁)+scope 标配注入(框架自动,useSession——owner 不写)+注册方私有注入(inject 工厂);register 类型要求 inject 恰好补齐组件 props 超出前两源的差集。②key 只属 keyed 坑,用途=**运行时按数据分发**(owner 拿 block.tool 当 entryKey 查注册表选组件,即"注册表驱动的 switch-case,case 可由第三方插件添加")+重复注册冲突检测;list 坑无 key 有 label/order(展示排序);single 无 key |
| D43 | 定稿:**完全外部注入模式**——组件所需一切经 props 注入,唯一约束=注入物引用稳定(不引发多余 rerender) | 三入口示例代码按此重写(walkthrough §6/§7):shared=interface+RPC 类型;client=service(持 store,命令式更新)+slot 注册;react=组件只吃 props(纯值+注入 hook),零框架 import。SlotOutlet 注入面={useSession, useAction 域函数, t}——全部构造一次缓存,per-(坑位×scope) 恒等 |
| D39 | 数据流转全景定稿（React 组件↔cordis service 对象↔SSE 通道的完整流向） | 三次形态转换:①JSON→类型化事件(zod,边界一次)②事件→可变 draft(投影 reduce 内部——immer/mutative 的唯一正确落点,实现细节非 API)③draft→不可变快照(finalize,结构共享=下游 memo 根基)。相等性协议表:mux=seq/epoch 数值;投影=引用即版本;useWatch=Object.is,selector 选对象声明 shallowEqual(深比较禁止,有此需求=去投影里物化切片);React.memo=shallow props(白名单保证够用);Zustand 同款语义。组件/容器里 map/filter 出新引用=打穿 memo 的事故源。zstd 压缩属 carrier 内部与数据流无关 |
| D40 | i18n/theme 简单做:纯字符串注册表;React 面标准化 | theme=token→值字典→CSS variables 到 :root,换肤 DOM 级联 **React 零渲染无需 Provider**;i18n=locale×namespace 映射表,React 面=标准 Provider+useT 查表(locale 切换整树重渲染,低频接受)。确认"比较标准化"——不发明新机制 |
| D38 | slot 骨架已定,但 props 数据流未定（class/Zustand/纯 JSON?） | props=跨插件 ABI,白名单四类:branded 身份/纯展示参数/**owner 已物化的不可变快照切片**（owner 本来持有+变化时本来就重渲染该条目）/罕见纯 UI 协调回调（引用稳定）。禁:class 实例、store、ctx、可订阅源。判据:props 传"定位你的已物化数据",不传"你自主需要的数据"（后者 hooks）;owner 不许为子组件当数据泵。swarm 卡双通道样本:props 收 tool-call block,进度自己 useWatch |
| D37 | 嵌套注册最终形态（用户给出完整机制）+ register 直接挂 React 组件函数 | 单一 ctx.slots.register(key, Component, options?) API;**SlotMap declare merge**（typed-events 惯例复用）:layout 挖顶层坑（SlotMap{sidebar,conversation}+define 落账）,conversation inject[slots,layout] 后 register('conversation') 得完整类型推断+再 merge 挖 conversation.* 子坑,chat inject[slots,conversation] 再 register('conversation.views')——**inject 链即所有权链**（没 inject owner=装配 fail loud;卸载级联走 inject 原生语义）。register 第二参=组件函数本身,FC<SlotMap[K]['props']> 直接锁强类型;key/order 走第三参 options（条件类型:keyed 必填/single 禁传）;register 到未 define 的 key=运行期 fail loud。D36 的 owner-registry 独立注册模型方案退场（被本形态吸收:owner 权威改由 inject+declare 表达） |
| D36 | 页面形态定盘:Layout 顶层两坑 sidebar+conversation;projects 不设 service（从 sessions 算出）而是 sidebar 区块插件;**嵌套 slot 一律走 owner 独立注册模型**——conversation.chat 经 conversation 的 registry 注册,不直接上全局 slots | 全局 ctx.slots 只管顶层坑+简单注册（key 字符串寻址,字面量类型查表锁契约）;声明子 slot 的插件必须提供注册模型（registerView/registerToolView 这类 service 方法,返回 disposer）;寻址链=所有权链（conversation→全局,conversation.chat→conversation registry,conversation.chat.tool→chat-view registry）;defineSlot handle 方案退场,换 key+owner-registry 两级模型;输入框/视图切换器=conversation 骨架自有 UI 不开坑 |
| D35 | intent 声明太声明式/不 TS 化;conversation 应统管对话架构,滚动视图呈现形态由子插件注入 | ①跨线契约改 **TS interface 优先**:shared=interface(方法签名即契约)+一行 channel<I>(名字/级别/绑定轴);node=implements 类+serve(缺方法=编译错);client service 内部=channel.remote(ctx) 类型化代理;zod 退为框架内部边界校验(构建期从 interface 推导或运行时反射,复杂载荷才手写覆盖)——builder 链退场。②对话区所有权三层:壳给坑→conversation 插件统管(输入框/statusline/视图切换=骨架)→聊天/甘特图/Traj/Waterfall=注入 conversation.views(list slot)的子插件,各自可再开坑(聊天开 toolview);"session tabs"需求收敛为 conversation.views |
| D34 | apiproxy 是否可简化——不再需要 server 侧把 session/agent/steer/resume 封装成领域 RPC? | 对。apiproxy 从"领域 API 总汇"降为**通用通道路由层**（信封收发/attach/watermark,零领域词汇）。现 RpcMethodMap 领域方法逐个去向:events 流→session A 级通道;history→A 级 attach backfill（不再是独立 RPC）;list→列表 B 级通道;prompt/cancel→conversation 插件 shared 声明的 intent;approvals/questions→respond 域 B 级通道;describe→config B 级通道。**agentFor/resume-on-prompt 不消失**——搬进 conversation 插件 node 半边 serve 实现,host 权威不变,只是从中心 api-proxy.ts 挪到 owner 插件。四象限 carrier 缝保留为传输层。净效果:新领域=新插件自带声明,中心契约不再随领域膨胀 |

前置已验收资产（cordis-web 线，worktree-cordis-web，ACCEPTANCE 12/12）：本稿收编其中的**装载/构建面**——tsdown client bundle 预设、DSHClientProxy.loadPlugin、类型宇宙隔离（verify-client-closure）；**peer 面**（builder/五件套/hold/echo 双向）随 D20 整体封存，见 §6。

VS Code 调研报告（missions/tasks/20260721-1330-vscode-extension-research/report.md）六节，本稿吸收的结论在各节标 [VSC-x]。

## 1. 信封协议（会话层）

### 1.1 分层

```
scope 语义层   通道 intent/事件 / 投影增量 /（将来 peer 调用,D20）/ slot 无关（slot 是纯 client 概念，不过线）
会话层         channel × epoch × seq；attach/watermark；背压；结构化错误；取消
传输层         SseHttpCarrier（现状既有通道，v1 载体）| InProcessCarrier | (future: WS / Electron IPC)
```

- v1 载体=既有 SSE 下行 + HTTP RPC 上行，不动（D16）。信封语义（channel/epoch/seq/watermark）寄生在既有 mux 帧格式上：下行 event 帧走 SSE 流，intent/receipt 走既有 HTTP RPC 面。
- 会话层要抽显式的动机不变：重连补帧目前与 EventSource 行为耦合（baseline-replay 稳定 rpcId），抽出后语义归会话层、载体归 carrier，将来换载体不动上层——但"换不换、何时换"不在本 RFC 范围。
- carrier 缝沿用四象限先例：接口/实现/消费三包分立；InProcess 保 fixture/单测路径（fixture runtime 不走网络）。
- [VSC-4] 单一契约文件两侧共同编译（extHost.protocol.ts 模式）→ 我们的 shared 通道声明即此物；改协议必双侧报错。

### 1.2 信封字段细则

```
{ chan: ChanId             // 通道实例 id（branded）；attach 时由 (通道名, scopeKey?) 解析而来（D19）
  epoch: number            // attach 会话代；client mint（attach receipt 里 host 回填确认）
  seq: number              // 通道实例内单调，host 侧 mint；intent 无 seq（用 rpcId）
  kind: 'intent'|'receipt'|'event'
  rpcId?: RpcId            // intent/receipt 对；发起方 mint、应答方回填（红线 15 原样）
  payload: unknown }       // 通道 schema 双端 parse（zod）
```

- **scope 不在信封层（D19）**：信封只做分发与去重，不理解业务维度。scope 出现在 attach 的解析输入里（`attach(通道名, scopeKey?, fromWatermark?) → chan 实例 id + 应答`），host 侧维护 (通道名×scopeKey)→实例 的表；此后帧上只有实例 id。scope dispose → 该 scope 名下全部通道实例关闭（下发 chan-closed）。
- 通道名命名空间：官方通道与插件通道同一空间，插件通道强制前缀 pluginId/（编译期 route-reservation 断言沿用 R2 模式）。

- 官方 RpcMethodMap 与通道 payload 的关系沿用既有裁决：插件 payload 对官方契约 opaque 透传，不进官方编译期锁。
- 错误：结构化错误码闭集（含 `no-such-chan`、`no-such-scope`（attach 时）、`stale-epoch`（丢弃语义，仅计数））。closed union + assertNever。
- 取消：intent 可携 cancel 帧（rpcId 引用）；[VSC-4] 取消独立报文先例。
- 背压：沿用既有 SSE res.write→drain 流控（R2 加固）+ host 侧每通道发送队列上限；超限策略按级别——A 级不丢（流控），B 级折叠（新快照替换未发旧快照），C 级丢尾。**这是 B 级"快照即全部"语义的直接红利。**

### 1.3 通道三级分类学

判据一句话：关心"过程"→A；关心"现状"→B；调试回看→C。

- **A 级封闭**：只有 session 事件流。新增 A 级=宣称存在 session log 外不可推导的过程性事实，与 Model-visible⟺logged 几乎矛盾 → 架构评审门。
- B 级快照义务：host 侧 per-scope 实例随时可供快照 = 双半边插件契约义务（进 defineChannel 的类型：必须提供 snapshot()）。
- C 级 ring：容量是通道声明字段；"刷新丢旧"写进 JSDoc 为契约行为。v1 无成员（rpc-log 已裁撤，D18），级别定义保留给将来 metrics 类。
- attach 动词统一：`attach(通道名, scopeKey?, fromWatermark?)`；应答形态按级别 backfill-paged / snapshot / recent-N。session 的 history 分页=A 级 backfill 的展开形态,不是独立机制。

### 1.4 幂等定律（全系统唯一一套）

- snapshot + watermark + epoch。seq ≤ watermark 丢；epoch 旧丢。框架在 mux 层统一做，插件作者零自制去重。
- 刷新恢复：boot → sessions list（B 级）→ 重建 session scope → 视图挂载惰性 attach 各通道。
- fork 重建（如插件 reload）：epoch+1，重走 snapshot。
- 在途 intent 丢失（刷新）：无需处理；receipt 超时=unary 30s 既有兜底。

### 1.5 持久化等级

- session 事件帧：进 log，可重放（既有）。
- B/C 级帧（含将来的 peer 帧）：呈现面控制流，不进 log（规矩 18）。同管道不同存续等级，帧上不标——由通道身份决定。
- 重放视图：A 级投影从 log 重算；B/C 级在回放态不存在 → 插件卡片必须可在"无 scope"形态渲染（documented-default 回退,三型卡梯子复用）。

## 2. scope 镜像

### 2.1 结构

- client root 下按 session 建子 scope（cordis 原生）；Session class = scope ctx service，1:1 同生共死。**禁止第二账本**：不允许任何"scope 树 ↔ 对象层"对账表存在。
- 镜像事件：scope-created{key, meta} / scope-disposed{key}，走 B 级 hub 通道的增量。
- mount 轴声明：client 半边 manifest 字段 `mount: 'root' | 'per-session'`。显式声明,不从用法推断（explicit>implicit）。
- **词汇修正（D26）**：本仓 vendored cordis 无 ForkScope（那是上游旧版词汇）,只有 Fiber。多实例机制=在不同 scope ctx 下多次 `ctx.plugin(clientHalf, config)`,每次得一个 Fiber。scope 本身=dsh-scope mintScope 模式（no-op 插件 Fiber 当载体+ctx.extend 打 kScope 标+intercept 随 extend 继承）,与 host 侧 Agent Scope 同一架构,client 侧照搬。
- 实例 ctx 已绑 scope：ctx 上可解析 session service;插件自己声明的 scoped 通道 attach 时自动带本 scope 的 key（将来 peer 挂点同此,D20）。
- dispose 链：host scope dispose → 事件 → client scope dispose → 实例 Fiber dispose → slot 注册/订阅/在途调用（reject no-such-scope）全收。**顺序**：先冻结投影（frozen 快照保留供 UI 显示終局）再收实例——UI 不闪空。

### 2.2 client session 状态机

```
cold → attaching(backfill) → live → frozen
                 ↑ 断线 → reattach(fromWatermark) —— 对消费者不可见（投影不清空）
```

- backfilling 期间投影已可用（先给 history 前缀，water 线后缝 live）；缝合由 session service 保证连续（去重靠 seq）。
- frozen：host 结束/杀死。既有"中断部分冻结"语义是其特例。frozen 后 intents reject（`session-ended`），投影只读。
- cold session（纯 log 无 live）：投影全部从 history 构建；证明投影本体=log 投影,live 只是加速器。

### 2.4 agent 化身差异（v1 不做,D33 存档）

host 两路由面:session carrier key=scope key（跨 resume 恒定）;agent carrier key=Agent 对象本身（resume=新身份,agent 面状态天然不跨代）。v1 client 一律 session 精度,stale 风险记台账。启用方案（想清待用）:
- 方案 A 通道 agent 绑定轴:`scope:'agent'` 的通道,host 侧 agent 换代→旧通道实例 chan-closed→新实例新快照;client 投影收 closed 重置。epoch 机制原样兜住乱序。
- 方案 B incarnation 纪元:session 状态机 live 态带 incarnation(cold→live +1,源=agent 生命周期事件);agent 面投影声明"随纪元重置",session 面投影跨纪元累积;插件 agent 精度状态用 (sessionKey,incarnation) 键控。
- 择案倾向:A 更契约化（差异写在通道声明处,编译期可见）,B 更轻（不动通道层）。真触发时按当事插件形态择一。

### 2.3 边界语义

- 镜像滞后：fork 收 disposed 即冻结,后续 UI 转 stale 态。
- props.sessionId ≡ 所在 scope：SlotOutlet 从同一 fork 记录取 ctx+id,同源不变量,进框架断言（dev 模式 throw）。
- 跨 scope 调用：从 client 运行时查目标 fork 再调,显式;不做隐式路由。

## 3. client ctx 词汇表

root 原生(bootstrap): carrier/mux/loader（D23）
root 上由 bundled plugin 注册: workbench / slots / i18n / theme
scope: session（事件feed+intents+attach 机,框架唯一的 scope service）/ 投影(用户空间,D22) / (插件自注册 service) /（将来 peer,D20）

- workbench [VSC-git activeRepository 模式]：读+订阅+命令（openSession/openTab）;实现内读写 Zustand;插件唯一门。"无命中保持旧值+可 pin"语义抄 scmViewService。
- i18n：locale×namespace;fallback 链 de→en 声明式;插件 namespace=pluginId;t() 同步查（字典 attach 时全量到位,B 级）。
- theme：single 槽;token 空间由壳预注册（[VSC-3] StatusBarItem 只准主题色 id 的推广）;插件组件禁 hardcode 色值（lint 面）;应用=写 CSS variables 到 :root。
- loader：清单=host 声明（config 同源、重启生效——既有裁决沿用）;bundle 分发端点/DSHClientProxy 全复用已验收链。
- 类型宇宙：client 词汇表接口全部在 client-only 包声明;verify-client-closure 覆盖面扩到新包。

## 4. 投影（materialized views）

### 4.1 契约

```ts
defineProjection('conversation', {
  from: sessionChannel,                    // 原料通道
  init: (backfill) => State,               // attach/backfill 构建
  reduce: (state, event) => void,          // 可变累加器（内部）
  snapshot: (state) => Snapshot,           // 不可变快照+结构共享（uSES 正确性前提）
  retain?: 'scope' | 'refcount',           // 默认 scope 保温
})
```

- reduce 一次性：唯一一份计算,视图皆订阅者。
- 通知合批：raf 级 bump（红线 17 Notifier 纪律的新家）;等值短路（status 没变不 bump）。
- 投影全部用户空间（D22）：conversation/status/timeline/usage 只是第一方插件恰好声明的四个,不是框架 API 面;声明者持类型与 reduce 实现权,共享=import handle,按 handle 在 scope 上去重。
- onEvent 生流逃生门：JSDoc 标注"自负 reduce/顺序/重放责任";review 时按红旗对待。
- 一致性边界=投影;跨投影 ≤1 帧撕裂接受（台账 T2）;投影内原子由快照整体替换保证。
- 惰性+保温：首订阅时建（含必要 backfill）,scope 活着不拆;retain:'refcount' 留给重投影。

### 4.2a hook 实现契约（D27,组件侧幂等五条）

1. `getSnapshot` 纯读且引用稳定:数据没变必须返回同一引用（uSES 正确性前提,否则并发渲染下 tearing/死循环）;快照生成在投影 bump 时,不在 render 时。
2. `subscribe` 引用稳定（useCallback/模块级）,render N 次不重订。
3. selector 在 uSES 的 selector 位（带等值比较）,不在组件体里二次加工——加工=每次 render 新引用=失效放大。
4. `useAction` 返回的 invoke 引用稳定;pending 是它内部的 uSES 源,不是组件 setState。
5. render 体内零副作用零解析:ctx/handle 解析全部在包裹层或 hook 内部 memo,组件体可以被 React 并发模式任意重放。

违反任一条=review 打回;Profiler 计数验收（§10）是这五条的行为面证据。

### 4.2 渲染性能红线（进验收）

- ctx 注入的 React context 引用稳定,数据不走 render 树。
- 投影快照结构共享:流式期间历史 turn 引用不变。
- markdown 增量:已闭合块 memo,只 parse 尾部未闭合块。
- 滚动跟随:raf 直接 DOM,不经 React state。
- 列表铁律:父订成员身份（id 序列）,子订成员内容。
- 禁止订阅结果拷进 state/store。
- **Profiler 计数验收**（playwright + React Profiler API）:流式期间 statusline 渲染次数=0、邻居 row=0、历史 MessageItem=0;发送链路各组件渲染次数上限表。

## 5. slot 系统细则

- handle=值:defineSlot 返回 phantom-typed handle;注册递 handle;字符串路径只是调试名。嵌套=export/import 图,无中心名册;壳只 export 第一层。
- 三型状态机:single(冲突 fail loud/config 指定赢家)、list(order 字段,稳定排序)、keyed(key 必填,重 key fail loud)。类型状态机模式抄 peer builder（broadcast 无 output 方法先例）。
- 纯数据 slot:props 位换 value schema（zod）;同一注册表、同一 disposer 纪律。
- SlotOutlet 包裹层:ErrorBoundary（必需品,[VSC-5] 放弃进程隔离的对价）+ ctx Provider（注册者插件 ctx × 所在 scope ctx 两层）+ 身份 props。全部稳定引用,注册表变化才重建。
- 插件卸载:fork disposer → 注册撤销 → outlet 下一次渲染少一项;正在显示的组件卸载由 React 正常 unmount。
- 声明先于行为 [VSC-2 contributes 哲学]:数据性贡献（槽位/token/图标/路由）注册即可消费,行为性贡献（组件/回调）待 apply 完成;两者都走 ctx.effect。

## 6. peer——暂缓（D20），封存备忘

本 RFC 不设计 peer。以下为暂缓时点的备忘,供将来另稿收编时起步,**不是本稿承诺**:

- 封存资产(worktree-cordis-web,ACCEPTANCE 12/12):builder 词汇（input/output 状态机、broadcast 限无 output、serve 第二参来源 proxy）、hold 语义、PeerError 闭集、HostPeer/Gateway/Proxy 五件套。
- 届时的收编方向(本轮讨论已对齐但未定稿):peer 帧=插件私有通道的一种;绑定轴 m.scoped('agent')/m.root();Gateway 路由 (pluginId, scopeKey)→实例;scoped serve 类型随 scope 注入变化;组件侧消费=useAction(peer 动作 handle)（D25 之后无独立 peer hook）;乐观态=observed intent [VSC-4.5]。
- 本稿预埋(见 walkthrough §6):通道谱系留位+fork ctx 留挂点;动作类需求 v1 走通道 intent。

## 7. Zustand 细则

- 单 store 分 slices:nav(选中 session/tab)、layout(面板/尺寸)、prefs(主题选择/语言选择,persist localStorage)、drafts(keyed by sessionId)。
- prune 桥:scope dispose effect → store.prune(sessionId);单向,ctx 通知 store 执行;store 永不反向查询 ctx。
- workbench service=插件与 store 之间唯一的膜;插件 API 面无 Zustand 类型（呈现库可换性）。
- 插件内部私用 Zustand 随意（bundle 私事）。
- 红线 14 新表述:store 无运行时事实副本;lint/review 检查点:store slice 里出现 SessionId 索引的**内容**数据（非观看态）即红旗。

## 8. 迁移地图(现状→目标,给实现排期用)

| 现状资产 | 去向 |
|---|---|
| connection.ts/SSE mux/重连补帧 | **保留为 v1 载体**;其上抽 ChannelMux 会话层（attach/watermark/epoch 显式化）;背压/R1/R2 加固原样 |
| web-api-client/api.ts 四象限 | intents 收编为信封 kind;InProcess carrier 保留测试路径;AbstractApiClient 类层次并入 carrier 缝 |
| apiproxy RpcMethodMap 领域方法（sessions.prompt/cancel/history/list、approvals、questions、describe） | 解体（D34）:通用层只剩信封路由+attach;领域方法化为各 owner 插件的通道/intent 声明与 node 半边 serve;agentFor/resume-on-prompt 平移进 conversation node 半边 |
| Session OOP 对象层/store.ts | Session→scope service;投影从现有 reduce 逻辑拆出(conversation 雏形=现聊天数据流);Notifier→投影 bump |
| RpcLog | 裁撤（D18）：不入通道谱系；现有面板/badge 的去留在壳清理时另拍 |
| 三个 shell registry+toolCardRegistry | 统一 slots service;现有注册点改 defineSlot handle;git mv 保历史 |
| respond/approvals 设计(五刀已归档) | pending approvals=B 级通道范例;PendingInteractionRegistry 即其 host 侧快照源;实施窗口与本 RFC 合流 |
| cordis-web worktree | loader/bundle/类型隔离收编;peer 面封存不动（D20,待另稿） |
| fixture.ts | 造 InProcess carrier 的假 host;历史脚本/重放钩子平移 |
| jsdom/playwright 验收面 | 快照面换新协议帧;Profiler 计数断言新增 |

分期(粗):M1 会话层显式化(既有 SSE/POST 上抽 ChannelMux)+session 通道跑通(对象层换底,UI 无感);M2 scope 镜像+统一 slot+hook 库(壳自迁移,内置=bundled 插件);M3 插件 loader 收编+第一个双半边插件(swarm 或 respond)+theme/i18n 注册表。每期门禁全绿交付。

## 9. 开放问题(下轮 review 待拍)

1. 载体收敛(要不要在某期换单条 WS,或 Electron IPC 直连):本 RFC 明确出局(D16),单独立项;carrier 缝已显式,届时不动会话层以上。
2. hub 通道与 scope 镜像事件是否合并为一个 B 级通道:倾向合并(session 列表项=scope 存在性同源)。
3. defineProjection 给第三方开放的时机:M2 还是 M3(API 稳定前第一方 bundled 插件先用,机制同一套——D22 之下没有"官方投影"只有"先用者")。
4. workbench 命令面词汇表(openSession/openTab 之外还有什么进 v1)。
5. i18n 字典的 bundle 形态:随插件 dist.js 内联 vs 独立 chunk 按 locale 拉(倾向内联,量小)。
6. Electron 线(plan.md 原始诉求):会话层与载体解耦后 renderer=WebUI 天然成立;main 侧 carrier 形态留到 Electron 立项(并入开放问题 1 的载体议题)。

## 10. 验收面规划

- 协议单测:信封 codec、watermark/epoch 丢弃矩阵、三级 attach 应答形态。
- InProcess e2e:双 cordis 运行时同进程,scope 镜像生命周期(创建/断线 reattach/dispose 冻结)。
- 浏览器验收(playwright):9a/9b/9c 三链路+Profiler 计数表+断线刷新恢复+双视图同订。
- 类型负样本:single slot 双注册、keyed 漏 key、通道命名冲突、scoped 通道从 root ctx attach——各一个 expect-error 编译用例。
- 插件样板:双半边示范包(per-session mount+B 级通道+statusline slot)作为验收载体与文档范例(echo 的 peer 面封存,示范包不含 peer)。
