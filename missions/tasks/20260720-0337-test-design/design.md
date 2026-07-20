# GUI 测试体系设计（e2e + 单元测试）

> 命题：为当前 GUI 架构设计分层测试体系。事实基线：HEAD 11694b553 + 工作区未提交改动；四篇 gui RFC（分层/协议/web 架构/样式）为架构事实源。设计阶段不写测试代码。
>
> 读法：§A 是骨架（每层测什么/不测什么/工具/假体）；§B/§C 处理两项存量资产（verify 脚本、fixture）的定位；§D 是可直接开工的落地清单；§E 是工作流接线；§F 妥协台账。文末列需用户拍板的分叉点。

## §0 三个设计前提

1. **GUI 免门禁现状**（用户已定）：per-file 100% coverage、REAL-composition、doc-sync 等正式门禁 GUI 期不套用。但这不等于测试可以随便写——本设计按「转正时能平滑升格」的形状落测试，豁免的是阈值不是结构。
2. **架构已给出天然测试缝**，测试体系贴缝切，不造新缝：①纯函数层（lineage/partial/conversation 分类器）零依赖；②对象层（Session/Manager）依赖收口在 `IApiClient` 单接口，可编程假体即可行为测试；③协议层有**进程内同构点**——`InProcessApiClient(toFetchHandler(impl))` 不过网络但真跑 wire 序列化/zod 两级 parse/rpcId 回显/SSE 分帧，这是整个体系里最值钱的一条缝；④host impl 层依赖收口在 bootHost 的 ctx，mock LLM adapter（echo-agent 先例）即可真 core 测试。
3. **两次「fixture 全绿真浏览器炸」的实证**（连接风暴=桥层 req/res close 误判、桥 abort bug）定性了 fixture 的盲区：fixture 短路的恰是 wire 承载链（doFetch/SSE 分帧/node:http 桥/close 语义/真网络时序）。治理方向不是「让 fixture 更像真的」，而是①结构性缩小短路面（§C.1）②把不可 fixture 化的面下沉到 Node 层哨兵（§C.3）。

## §A 分层测试策略

总表（层序 = 数据流自底向上；「假体」列写该层测试中被替换的边界，未列者一律真身）：

| # | 层 | 被测物 | 测什么 | 不测什么 | 工具 | 假体策略 |
|---|---|---|---|---|---|---|
| A1 | 纯函数层 | `lineage.ts` / `partial.ts` / `conversation.ts` 分类器 / `notifier.ts` | 输入→输出全分支、引用纪律 | — | vitest（node env） | 零假体 |
| A2 | fold 适配层 | `fold-adapter.ts`（含 core `SurfaceManager` 真身） | padding 哨兵、增量 append、节点缓存引用稳定、降级分支、六型物化 | SurfaceManager 自身正确性（core 已有覆盖） | vitest | 零假体（core surface 用真的——它就是被适配对象） |
| A3 | 对象层 | `session.ts` / `manager.ts` / `connection.ts` | 状态机与时序：open 缝合/去重/翻页锚定/乐观清稿/pendingBuffers 重放/重连重建/退避 | wire 形态（A4 管）、渲染 | vitest | test-local **FakeApiClient**（可编程响应 + deferred 控时序；见 §D.4，≠ FixtureApiClient） |
| A4 | 协议层 | `AbstractApiClient` + `toFetchHandler`（apiproxy fetch/ 两文件） | 四象限信封往返、rpcId mint/回显/校验、zod 两级 parse 拒收、SSE 分帧边界、错误分层（业务 200 vs 载体 4xx/5xx）、envelope tap 合批、unary 超时 | 业务语义（history 分页对不对是 A5 的事） | vitest，经**同构点**全链 | 微型脚本化 ApiProxy impl（十几行，每 case 自定义） |
| A5 | host impl 层 | `api-proxy.ts`（createApiProxy） | 会话语义承诺（RFC「impl 侧承诺」节）：分页消息边界、隐式 resume 去重、prompt/cancel 1:1 映射、帧发射（subscribed 基线/event 透传/status 翻转） | LLM 输出内容 | vitest，真 core ctx | 手挂 ctx（agent-loop-testkit + mock LLM adapter，echo-agent 先例）；**只 mock LLM 一个边界** |
| A6 | 承载层 | `dsh-host-webserver`（bridge + static） | **连接稳定性哨兵下沉位**：res-close 语义回归钉死、client abort 传播、SSE 逐 chunk 写出；static 403/SPA/mime/405 | WHATWG handler 内部（A4 管） | vitest，真 node:http + 裸 `http.get` | stub fetch handler（发帧脚本） |
| A7 | hooks 层 | `useConversation` / `useSessionList` | （本轮暂缓，见 §F.5）uSES 合同四条里可脱 React 断言的部分已在 A1/A3 覆盖（getSnapshot 缓存引用、先重建后通知） | hook 内部——它只是 uSES 接线模板 | （将来 RTL） | — |
| A8 | 组件层 | web-ui components/ | **不单测**。组件是耗材（web 架构 RFC 明示「换 UI 库=重写组件目录」且已知要重做），单测是负资产 | props 渲染、样式 | — | — |
| A9 | 全链 e2e | 真浏览器 × 真页面（fixture 或真 host） | 用户可见行为与跨层集成：渲染齐全、滚动锚定、输入框回归钉、连接稳定性（浏览器侧） | 单层逻辑（下层各测各的，e2e 只兜集成缝） | playwright chromium headless 验收脚本 | fixture 模式 / 真 host 双轨（§B） |

逐层要点（只写表格放不下的判断）：

**A1 纯函数层**是 ROI 最高的起步位：`flattenLineage`（孤儿降级/环 fail-soft/双层排序）、`PartialAccumulator`（六型 chunk + 稀疏 index 压缩 + 块级引用纪律）、`toAssistantBlock`（四型分类）、`Notifier`（微任务合批/无订阅惰性/同步 notifyNow）全是有边界条件的状态折叠逻辑，bug 藏身处，且零假体即测。

**A2 用真 SurfaceManager 不 mock**：FoldAdapter 的全部风险在「与 core fold 的契约耦合」（seq===下标断言、surface-eligible 判定、replace throw），mock 掉 core 就测了个寂寞。降级分支的触发要构造真能让 fold throw 的事件序（replace 指向窗口外目标）；若实现时发现无法稳定构造，允许注入缝降级（见 §D.3 条目 2 的备注）。

**A3 的假体是 test-local FakeApiClient，不是 FixtureApiClient**。fixture 是 UI 开发资产：脚本固定（60 turns/80ms 打字机/5s gamma 翻转）、走真实时钟、语义面向「人看着像真的」。行为测试需要的是每 case 自定义响应和 **deferred promise 控制的时序**（history 挂起时注入 live 帧才能测 liveBuffer 缝合；vi.useFakeTimers 控退避）。两者用途正交，硬复用 fixture 会把测试时序绑死在演示脚本上。

**A4 是体系的中枢**：协议不变量全住基类+handler，两端各测一半都不如同构点全链测一遍——`InProcessApiClient(toFetchHandler(脚本化impl))` 一条管把 mint→tap→POST→parse→回显校验→窄形吐出全跑真。这层绿了，「换载体」（将来 Electron IPC）的回归面就只剩 doFetch 切面本身。

**A5 的「真 core + mock LLM」**：createApiProxy 的风险全在与 core 服务（ctx.agents/ctx.sessions/事件总线）的映射语义，mock ctx 等于自证。手挂 ctx 用 `mountAgentLoopTestDependencies` + 内联 mock adapter（echo-agent 的 mock-llm.ts 形态，测试 harness 里十几行），prompt 后消费 mux 流断言事件序。**不走 Loader/cordis.yml**（REAL-composition 政策的 GUI 期豁免，入 §F.4 台账）。

**A6 是两次实证 bug 的最低成本回归位**：req/res close 误判 bug 在纯 Node 里 100% 可复现（裸 http.get 挂一条 SSE，坏实现在 GET body 读尽后立刻 abort）。把它钉在 Node 层意味着**跑这条回归不再需要浏览器、不再需要 12 秒**；浏览器侧 12s 哨兵保留（它还覆盖浏览器 fetch 语义与真网络），但不再是唯一防线。

## §B verify-*.mjs 的定位与演进

### 结论：保留验收脚本形态，不迁 vitest；三脚本各自定位固化，增量规则收敛

**理由**（逐项对过 vitest 化的收益）：

1. **它们的价值恰在「非测试框架」形态**。三脚本是 agent 自验工具+用户「改完重跑」工作流的一部分：顺序步骤即用户操作剧本（§E1-1→§E1-11 是一次真实走查），PASS/FAIL 逐行流式输出让 agent 在中途失败时立刻看到「走到哪一步断的」。vitest 化后步骤会被拆成隔离 test case——但这些步骤**本质上是共享一次浏览器会话的有序剧本**（§E1-5 发消息是 §E1-7 停止的前置），拆散要么靠 `test.sequential` + 共享 page（形式化收益归零），要么每 case 重开浏览器重走前置（12s 哨兵 × N 的时间成本）。
2. **vitest 的三项收益在此场景全打折**：断言体系——playwright 的 locator/waitFor 已是断言主体，`report()` 十行顶掉 expect；并行——浏览器剧本天然串行；watch——真浏览器 e2e 没人 watch 着跑。
3. **防回归资产的地位不靠框架**：脚本已有 exit code（0/1）与稳定输出格式，任何 runner（pre-push、CI、agent）都能消费。
4. **迁移是纯改造成本**：三脚本 ~350 行断言逻辑要逐条改写并重验时序语义（waitForSelector 的竞态注释都是踩坑记录），换来的是负收益。

### 三脚本定位固化

| 脚本 | 定位 | 前置 | 何时跑 |
|---|---|---|---|
| `verify-session.mjs` | fixture 全量 UI 走查（渲染/翻页/发送/插话/停止/切换/新建/输入框回归钉/RPC 面板交叉验证） | dsc web + dist + `?fixture` | 每次改 web-runtime/web-ui 后（agent 交付前必跑） |
| `verify-rpclog-panel.mjs` | fixture RPC 面板专项（台账/配对/暂停/清空） | 同上 | 改 rpc-log/面板/envelope tap 后 |
| `verify-session-real.mjs` | 真 host 抽查 + **连接稳定性哨兵**（12s 请求数≤10、零 requestfailed）+ 真模型流式 | dsc web + 真 key | 改连接层/桥/handler/SSE 后；发版前 |

### 增量规则（防脚本无限膨胀）

- **新交互面**（新面板、新对话能力）→ 新专项脚本（rpclog-panel 先例），不塞进 verify-session。
- **回归钉**（修一个 bug 钉一条）→ 挂进所属脚本的回归节（§E1-11 输入框钉是先例形态：一钉一行 report，注释标 bug 编号）。
- **一次性验收**（某次重构的专用检查）→ ignore 目录，不进 scripts/（既有分流纪律）。
- 每脚本头注释三行契约保持：用途、前置、运行命令；步骤标签（§E1-x/§D-x）与 report 文案一一对应——这是 agent 读输出定位失败点的接口，视为稳定面。
- **转正路径**（门禁回收时）：脚本形态不变，包一层 vitest e2e 壳（`it('verify-session', () => spawn 脚本断 exit 0)`）即可挂进 test:e2e 车道——届时也只做这一步，脚本本体永不改写成 test case。

## §C fixture 与真链路的差异治理

### 差异的结构分析（先定性再开药）

FixtureApiClient 在**协议层**覆写（callUnary/openMux/openHost/respond 四虚方法直连内存 impl），被短路的面自上而下：

| 被短路面 | 住址 | 两次实证 bug 是否在此 |
|---|---|---|
| wire 序列化/zod 两级 parse/rpcId 回显校验 | AbstractApiClient.callUnary/readSse + handler | 否 |
| SSE 分帧（`\n\n`/data: 拼接/comment 行） | readSse + sseResponse | 否 |
| node:http↔WHATWG 桥（close 语义、abort 传播、逐 chunk 写出） | webserver bridge | **是**（req-close 误判） |
| 浏览器 fetch/网络时序（重连风暴的放大器） | 真浏览器 | **是**（连接风暴表现层） |
| host impl 语义差（分页算法、resume、running 判定） | api-proxy.ts vs fixture 手写对应物 | 潜在（fixture 的 pageOf 与 impl 的 paginate 是两套手写实现，已在漂移） |

药方按面分三条：C.1 收窄短路面（结构性）、C.2 语义合同双跑（断言性）、C.3 不可 fixture 化的面下沉哨兵（已在 §A6/§B 落位）。

### C.1 fixture 迁移到同构管道（结构性收窄）

fixture.ts 头注释已预告此路：**FixtureApiClient 从「协议层覆写」改为「InProcessApiClient over toFetchHandler(createFixtureApi())」**。改造后 fixture 模式真跑 wire 序列化、zod 双向 parse、SSE 分帧、rpcId 纪律——短路面从上表五行缩到只剩后两行（node:http 桥 + 真浏览器网络），**fixture 掩盖 wire 层 bug 的能力被结构性拆除**（例如信封字段漏写、schema 拒收、分帧边界 bug 在 fixture 模式下将直接炸给开发者看）。

- 前提核实：`createFixtureApi()` 返回的就是 `ApiProxy` 形（已满足）；toFetchHandler 在浏览器可跑需确认唯一 Node import（`node:crypto` randomUUID）换成 `globalThis.crypto.randomUUID`——一行改动，vite 即可 bundle。
- 代价：fixture 模式多一层 JSON 往返（每帧序列化+parse）。60 turns 历史+80ms 打字机的量级下无感；RPC 面板反而更真（现在 tap 看到的是 fixture 手工捏的全形，改后是真信封）。
- FixtureApiClient 类保留为薄壳或直接删除（boot 处 `new InProcessApiClient(toFetchHandler(createFixtureApi()))`），倾向后者——少一个类少一份「fixture 特有语义」的藏身处。

### C.2 语义合同双跑（contract suite 跑两遍）

fixture impl 与真 impl 的**行为合同**用同一套断言各跑一遍钉住。合同即 RPC 协议 RFC「会话语义（impl 侧承诺）」节的可机验子集：

| 合同条目 | 断言要点 |
|---|---|
| 分页消息边界 | `history(maxMessages=n)` 返回窗口内 message 型事件数 ≤ n 且切口对齐消息组边界；`beforeSeq` 翻页与首页拼接后 seq 连续无重叠；hasMore 与切口>0 一致 |
| prompt→事件序 | queue prompt 后 mux 流依序可见 turn/start → user/message →（流式期 chunk*）→ assistant/message → turn/end |
| running 翻转 | prompt 后 running=true 帧、turn 结束后 false 帧（fixture 经 host/session-status，真 impl 经 agent/status 映射——wire 形一致即合同） |
| cancel 语义 | 运行中 cancel → turn/end reason kind ∈ {cancelled,...} + running=false；空闲 cancel 不炸 |
| session-not-found | 对不存在 id 的 history/prompt 返回 `{ok:false, code:'session-not-found'}` 且 details.sessionId 回显 |
| create→列表可见 | create 后 list 含新 id；host 流见 session-added |
| subscribed 基线 | 开 mux 流即收 attached session 的 subscribed 帧且 lastSeq=当前尾 seq |

落法：`describe.each([fixtureApi, realApi])('ApiProxy contract', …)`——fixture 侧直接 `createFixtureApi()`，真侧 A5 的手挂 ctx + mock LLM。**跑的是 ApiProxy 接口层**（C.1 完成后两者又都能再套同构管道跑一遍 wire 形）。fixture 若过不了某条合同，修 fixture 而不是放宽合同——合同的事实源是真 impl+RFC。
维护规则：**改真 impl 的会话语义必须同步跑合同套件**，红了either修 fixture either改合同并在 PR 说明——合同套件从此是「fixture 漂移」的机械检测器（今天 pageOf/paginate 的双实现漂移就该由它抓）。

### C.3 残余差异的哨兵矩阵（结构收窄后仍不可 fixture 化的面）

| 残余面 | 哨兵 | 车道 |
|---|---|---|
| node:http 桥 close/abort/流写出 | A6 纯 Node 回归（裸 http.get 挂 SSE 12s→秒级断言 + abort 传播 case） | vitest 单测 |
| 真浏览器网络时序 | verify-session-real E2-0 十二秒哨兵（保留） | 验收脚本 |
| 真模型流式 | verify-session-real E2-3（保留） | 验收脚本 |

三条防线的分工语句（写进将来 docs）：**wire 形靠同构点（A4），语义靠合同双跑（C.2），承载靠 Node 哨兵（A6）+ 真浏览器抽查（verify-real）**——fixture 从「全责假体」降格为「UI 开发数据源」，掩盖真 bug 的结构位被逐一填掉。

## §D 单元测试落地形态

### D.1 vitest 配置：独立 `vitest.gui.config.ts`，无 coverage

```
根目录 vitest.gui.config.ts：
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })]   // 与根 config 同款
  test.include: ['packages/{client,host}/*/tests/**/*.spec.ts']
  environment: 'node'（对象层/协议层全部可 node env 跑；hooks 层暂缓故不需 jsdom）
  无 coverage 段（GUI 免门禁的机械表达：不是把阈值调低，而是不进 coverage 车道）
package.json 脚本：
  "test:gui": "vitest run --config vitest.gui.config.ts"
```

- **文件位置守仓库惯例**：包级 `tests/`（`packages/client/web-runtime/tests/partial.spec.ts`），命名 `.spec.ts`。这使根 config 的 include 模式天然也能扫到它们——GUI 期用 test:gui 跑，转正时**零搬迁**（解除的只是 coverage 豁免）。
- 解析注意一条：web-runtime 源码 import `@deepseek-ai/dsh-session/surface` 子路径。根 tsconfig paths 若命不中（host/client 组是显式条目），gui config 补一条 `resolve.alias`——写第一个 fold-adapter 测试时即验证。
- 时序控制约定：连接层退避用 `vi.useFakeTimers`+`vi.spyOn(Math, 'random')`；unary 超时不 mock `AbortSignal.timeout`（fake timers 控不住），用 `timeoutMs` 构造参数给短真值（10ms）。

### D.2 第一批单测清单（按 ROI 排；「断言要点」即验收标准）

**T1 `web-runtime/tests/partial.spec.ts` — PartialAccumulator 六型**（纯函数、零假体、bug 密度高）
| 测试名 | 断言要点 |
|---|---|
| block-start 四型建空块 | text/reasoning/tool-call 各建对应空块；未知 blockType → `{kind:'other'}` |
| text-delta 拼接 | 两次 delta 累积；prev 缺失或异型时从空串起 |
| reasoning-delta 拼接 | 同上（reasoning 支线） |
| tool-call-delta 累积 | argsRaw 逐段拼接；callId 首个 id 定死不被后续覆盖；name 后到覆盖先到（`??` 语义） |
| block-end 整块替换 | 定稿块经 toAssistantBlock 整体换入（覆盖累积中间态） |
| usage/finish 返回 false | push 返回 false（不触发通知）；blocks 不变 |
| 稀疏 index 压缩 | 先 block-start index=2 再 index=0：toPartial 输出压缩后连续数组，无 undefined 洞 |
| 引用纪律 | 无变更时 toPartial 恒返同一引用；一次 push 后引用更换且只换一次 |

**T2 `web-runtime/tests/fold-adapter.spec.ts` — padding 哨兵与节点缓存**
| 测试名 | 断言要点 |
|---|---|
| baseSeq>0 窗口折叠 | reset(events, baseSeq=100) 后 nodes() 输出与事件一一对应、seq 正确（哨兵不漏出） |
| 尾 append 增量 | reset 后 append 一条 → nodes 含新节点，旧节点引用不变（缓存生效） |
| 节点引用稳定 | 两次 nodes() 调用，同 seq 节点 `toBe` 同一对象；数组本身每次新建 |
| tool-result 回填 | 窗口内先 tool/call 后 tool/result → result 节点 call={name,argsRaw}；窗口外 call → call:null |
| 六型物化 | user/assistant/steering/context/tool-result/unknown 各一条，kind 与字段映射正确 |
| 降级分支 | 构造跨窗 replace（surfaceOp:'replace' 目标 seq 在哨兵区）使 fold throw → degraded=true、输出退化为线性扫描序、后续调用稳定走降级不再 throw。若真事件序造不出 throw，允许给 FoldAdapter 注入 fold 失败缝（内部 seam），并在测试注明 |

**T3 `web-runtime/tests/session.spec.ts` — 打开缝合与去重**（体系里最值钱的行为测试；FakeApiClient 见 D.4）
| 测试名 | 断言要点 |
|---|---|
| open 尾页安装 | history 返回后 openState cold→loading→open，events/baseSeq/hasMore 就位 |
| open 幂等 | 并发两次 open() 只发一次 history 调用（openPromise 复用） |
| liveBuffer 缝合 | history 挂起期间注入 3 条 live 帧（1 条与页尾重叠）→ 就绪后仅 2 条新帧 append，重叠帧丢弃 |
| subscribed 补缝 | subscribed.lastSeq > 窗口尾且 liveBuffer 未覆盖 → 第二次 history 拉取发生 |
| live 去重 | seq ≤ 窗口尾的 session/event 丢弃，快照无变化 |
| loadOlder 前插 | beforeSeq=窗口首 seq；成功后 baseSeq 更新、节点序连续 |
| loadOlder 断层 fail-soft | 返回页尾 seq+1 ≠ baseSeq → 丢页、hasMore=false、窗口不变 |
| loadOlder 防重入 | loadingOlder 期间再调直接返回（只发一次请求） |
| chunk→partial→定稿切换 | chunk 帧后快照 partial 非空；同 turn/step 的 assistant/message 到达 → partial=null 且节点 +1（同一快照代内完成） |
| openCalls 增删 | tool/call → runningCalls 含之；tool/result → 移除 |
| pending 双域 | approval/requested 与 question/requested 各入 pending（前缀隔离）；resolved 按 approvalId/questionRpcId 移除 |
| sendDraft 乐观清与恢复 | 发送即清稿；失败时草稿恢复且保住往返期间新键入（`sent+typed`）；in-flight 重入丢弃；纯空白 no-op 零请求 |
| prompt 失败入快照 | RpcResult err → promptError{op:'send'}；doFetch throw → 折叠为 internal |
| resync 重建 | 清窗口清 pending 重跑 open；cold 实例 resync 为 no-op |

**T4 `apiproxy/tests/client-handler.spec.ts` — 信封往返（同构点全链）**
| 测试名 | 断言要点 |
|---|---|
| unary 全链往返 | InProcessApiClient→toFetchHandler→脚本 impl：impl 收到窄形（rpcId 已 mint）、client 吐窄形、value 原样 |
| rpcId 回显校验 | impl 回错 rpcId → client throw 'rpcId mismatch' |
| payload 拒收 | 非法 payload → `{ok:false, code:'bad-request'}` 且 details.issues 非空；HTTP 仍 200 |
| method/path 不符 | 手工 POST /api/session.list 但信封 method=session.create → bad-request |
| 未知 method | POST /api/no.such → 404 → client throw transport failure（业务/载体两层不混的验证） |
| impl 抛异常 | route.invoke throw → 500 → client throw（不是 200 信封） |
| SSE 帧往返 | impl yield 3 帧 → client 依序吐窄形；`: connected` 注释行被跳过 |
| SSE 分帧边界 | 单 chunk 双帧、一帧跨两 chunk（自定义 doFetch 塞 ReadableStream 切割）→ 均正确重组 |
| envelope tap 合批 | 一次 unary 产生 client-request+server-response 两条、同一微任务批送达；listener throw 不影响调用结果；零订阅者时不入缓冲 |
| respond 回执 | receipt 解析；信封坏形 → `{accepted:false, reason:'bad-response'}` |
| unary 超时 | timeoutMs=10 + 永不 resolve 的 doFetch → reject |

**T5 `web-runtime/tests/lineage.spec.ts` — 谱系扁平化**
| 测试名 | 断言要点 |
|---|---|
| 根排序与子缩进 | roots 按 updatedAt 降序；子随父 DFS 展开、depth 递增、同级子亦降序 |
| 孤儿降级 | parentSessionId 指向不存在 id → 以 root 出现，不丢条目 |
| 环 fail-soft | a↔b 互指 → 全部条目仍输出（环成员作 root）、无死循环、console.warn 触发 |
| 自指 | parent=self → 同环处理 |

**T6 `web-runtime/tests/notifier.spec.ts` — 合批通知原语**
| 测试名 | 断言要点 |
|---|---|
| N 次 markDirty 一次 flush | 微任务后 listener 恰一次；rebuild 先于 listener（顺序探针） |
| 无订阅惰性 | 零 listener 时 flush 不 rebuild；ensureFresh 补建且只建一次 |
| notifyNow 同步 | 调用返回前 listener 已执行（控制输入光标前提） |
| 退订 | unsubscribe 后不再收通知 |

**第二批**（第一批绿后）：
- **T7 `manager.spec.ts`**：懒建+running 同步、pendingBuffers 缓冲/重放/清空、非 pending 帧对未实例化 session 丢弃、refreshList 单飞与错误态、create 立即并表不重复、host 四帧路由（added 去重/removed 标记不销毁/status 双写/agent-error 转发）、handleConnected 只 resync 已打开实例。
- **T8 `connection.spec.ts`**：双流+describe 才算连上（onConnected 时机）、流断→abort 本代→退避重连（fake timers 验区间）、describe 失败走同一失败路径、sink throw 隔离、stop 后不再重连、stream/error 帧触发 break。
- **T9 `webserver/tests/bridge.spec.ts`（A6 哨兵）**：**res-close 回归钉**（stub handler 记录 signal；裸 http GET SSE 路由，等 200ms 断言 `signal.aborted===false`——坏实现秒红）、客户端断连 → signal aborted、SSE 逐 chunk 到达（两帧间延迟，首帧先于流结束可读）、static 403 编码变体/SPA 200/mime 表/405。
- **T10 `host/runtime/tests/api-proxy.spec.ts`（A5）**：testkit 手挂 ctx + 内联 mock adapter；分页边界（maxMessages 计数、sourceEventSeqs 组切口、beforeSeq 窗口）、冷 session 并发 resume 去重（两并发 history 一次 resume）、prompt queue/steer 1:1 与 rpcId 进 MessageSource、cancel 未 attach → session-not-found、mux subscribed 基线+事件透传、host 流 status 翻转。
- **T11 `apiproxy-contract.spec.ts`（C.2 合同双跑）**：§C.2 七条 × describe.each(fixture, real)；依赖 T10 的 harness。

### D.3 断言纪律（承接仓库测试文化里 GUI 期仍适用的三条）

1. **验世界不验自述**：Session 测试断快照与 FakeApiClient 收到的调用记录，不断内部私有位。
2. **行为可换测试随换**：组件重做/协议演进时改测试是预期动作，测试名描述行为不描述实现。
3. **引用纪律是一等断言**：`toBe`（同引用）与 `not.toBe`（换引用）在快照相关测试中与值断言同权重——这是 React.memo/uSES 的合同，破了值全对页面也炸。

### D.4 FakeApiClient 形态（test-local，≠ fixture）

`web-runtime/tests/fake-api.ts`：实现 `IApiClient`，每方法一个可编程槽（默认 ok 空响应）+ 调用记录数组 + `deferred()` 工具（测试手握 resolve 时机以构造「history 挂起期注帧」类时序）。流方法暴露 `pushMux(frame)`/`pushHost(frame)` 手动泵。~60 行，住 tests/ 不进 src/（不是产品资产）。

## §E CI/工作流集成

### E.1 GUI 免门禁期的运行车道

| 车道 | 命令 | 时长量级 | 何时 |
|---|---|---|---|
| 单测 | `pnpm run test:gui` | 秒级、无浏览器无 server | 改 web-runtime/apiproxy/host 任意源码后随手跑 |
| fixture 验收 | `node scripts/verify-session.mjs`（+rpclog 按需） | ~30s，需 dsc web + dist | UI/对象层改动交付前 |
| 真链路验收 | `node scripts/verify-session-real.mjs` | ~1min，需真 key | 连接/桥/handler 改动交付前；阶段收尾 |

不挂 pre-commit hook（免门禁期 + 用户小步快跑分批落盘的工作流，hook 只会添堵）；一切手动/agent 触发。

### E.2 编码 teammate 交付前必跑矩阵（写进派工模板的「改动面→必跑」表）

| 改动面 | 必跑 |
|---|---|
| web-runtime/session/*（对象层） | test:gui + verify-session |
| apiproxy api/ 或 fetch/（契约/载体） | test:gui + verify-session + verify-session-real（wire 面动了必须过真链路） |
| host/runtime api-proxy（impl） | test:gui + verify-session-real |
| webserver | test:gui（含 T9 桥回归）+ verify-session-real |
| web-ui 组件/样式 | verify-session（+改面板则 rpclog）；无单测义务 |
| fixture.ts | test:gui（合同套件 T11 落地后是主防线）+ verify-session |

agent 纪律沿用既有惯例：playwright 验收 agent 自己跑（chromium headless），失败贴 FAIL 行与截图，不留给用户手验。

### E.3 转正路径（门禁回收时的升格清单，一次性做完）

1. 单测并入根车道：GUI 包 tests/ 已匹配根 include，动作=补足 per-file 100%（或对 web-ui 组件目录给 justified 排除）后删 `vitest.gui.config.ts`。
2. T11 合同套件+T10 挂 `pnpm run test`；A5 harness 补 Loader/cordis.yml REAL-composition 版（见 §F.2）。
3. verify 三脚本包 vitest e2e 壳挂 `test:e2e` 车道（spawn+断 exit 0；脚本本体不改写）。
4. 新 seam 计划纪律恢复：新帧型/新方法在 plan 期声明各层覆盖（testing.md 既有要求）。

## §F 妥协台账（三段式：妥协 → 触发条件 → 返工点/预埋）

| # | 妥协 | 触发条件 | 返工点 | 预埋（本轮就守） |
|---|---|---|---|---|
| F.1 | GUI 包免 coverage 门禁（独立 config 无阈值） | 首个 tagged release 门禁回收 | 并根 config 补 100% 或 justified 排除 | tests/ 位置+.spec.ts 命名守惯例，升格零搬迁 |
| F.2 | A5 手挂 ctx，不走 Loader/cordis.yml（REAL-composition 豁免） | dsc 作为产品 bin 进发布面 | test-only cordis.yml + Loader boot 冒烟 | bootHost 保持纯组合函数、无隐藏装配 |
| F.3 | hooks/组件层零测试 | 组件重做完成、props 契约稳定 | RTL + uSES 合同四条逐条验 | 合同四条已成文（web 架构 RFC），对照即测 |
| F.4 | C.1 fixture 同构化只设计未实施（现状仍协议层覆写） | 下次 fixture 掩盖 wire bug，或任何人动 fixture.ts | §C.1 迁移（含 handler randomUUID 平台化一行） | fixture.ts 头注释已标迁移终点；不再往 FixtureApiClient 加新语义 |
| F.5 | 合同套件仅七条可机验子集；审批/问答 pending 语义不在内（host 侧 respond 是 stub） | step2 pending 表实装 | 合同加 requested 稳定 rpcId/基线重放/resolved 收敛条目 | 帧语义已成文（RPC RFC），届时照抄 |
| F.6 | verify 脚本无 CI 车道（纯手动/agent 触发） | 门禁回收或 GUI 进 CI | E.3-3 的 vitest 壳 | exit code 与输出格式视为稳定接口 |
| F.7 | 12s 浏览器哨兵保留双份成本（T9 落地后 Node 层已秒级覆盖同 bug） | T9 绿了且再无浏览器侧独有连接故障两周 | verify-session-real 哨兵窗 12s→5s（只缩窗不删除——浏览器 fetch 语义仍是独有覆盖面） | E2-0 断言保持独立步骤可单独调窗 |

## §G 设计过程 findings（非本任务修，移交实现侧）

1. **fixture `pageOf` 与 impl `paginate` 已在漂移**：切口算法不同（fixture 数满 maxMessages 后找 turn/start 边界；impl 用 sourceEventSeqs 组起点），hasMore 边界行为亦异。T11 合同套件落地即会红——届时按真 impl 修 fixture。
2. **`toFetchHandler` 用 `node:crypto` randomUUID**：换 `globalThis.crypto.randomUUID()` 即浏览器可跑（C.1 前提，一行）。
3. **webserver `RunningWebServer.port` 回显 `options.port` 而非实际监听端口**：port=0（随机端口）时返回 0。测试想用随机端口避免冲突就会撞上；建议改读 `server.address().port`。
4. **`AbortSignal.timeout` 不可被 vi fake timers 控制**：D.1 已定短真值策略，写 T4 时勿踩。

