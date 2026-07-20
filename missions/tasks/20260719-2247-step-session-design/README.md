# step-session 里程碑设计（session 列表 + 对话流）

设计「session 左侧列表 + 单 session 对话流」里程碑的实现级设计文档。排在 RPC 调试面板里程碑之后实施。核心命题：Session 面向对象 + 逻辑面与 UI 展示面分离。只写文档不写代码。

## 进展

| 时间 | 事项 |
| --- | --- |
| 2026-07-19 22:52 | 归档目录建立，开始读上下文 |
| 2026-07-19 23:05 | 上下文读毕（契约 v2.0 + api/ 真码 + RPC 面板设计 + surface.ts + ui-product）；design.md §A.0–§A.4 落盘（对象层布局/Session/SessionManager/快照类型） |
| 2026-07-19 23:14 | §A.5–§A.9 落盘（fold 适配 padding 方案/chunk 累积器/store·intents 增量/boot 装配/通知合批+帧分发表）；§A 完 |
| 2026-07-19 23:20 | §B 落盘（useSessionList/useConversation/useSelectedSession 实现规格 + uSES 防撕裂清单）；hook 层住 web-ui/hooks/，分界即包界 |
| 2026-07-19 23:28 | §C 落盘（容器/View 全 props 契约：列表+对话流+工具卡+占位卡+InputBar；滚动锚定算法；App 两列改版） |
| 2026-07-19 23:36 | §D–§G 落盘（契约消费清单/翻页数据路径/缝合规则/成本模型/两级验收/不做清单/工单切分）；**v1 完稿待 review** |
| 2026-07-20 00:0x | **review 整改 #3（v1.2）**：§F 升级架构妥协台账——12 条妥协各带【触发条件→返工点→预埋要求】（F.1 视图态 vs 虚拟列表、F.2 tool 卡 key vs 动画、F.3 replace 降级 vs 契约补语义、F.4 PAGE_MESSAGES vs 配置化 + 8 条自查隐性妥协），纯范围排除收 F.13 一行；F.10/F.11 预埋（PendingCard.onRespond?/MessageText 单组件）同步写进 §C。单例边界澄清入 §A.7：SessionManager 单例维持，只革视图选中态。**设计定稿，免二次 review，转入实现（本 teammate 任 owner）** |
| 2026-07-19 23:5x | **review 整改（v1.1）**：①选中态去全局单例——selectedSessionId 移出 zustand 归 SessionsScreen 容器 useState（多视图前瞻：分屏=多实例各持选中态）；drafts 同题裁定挂 Session 对象（per-session 数据跟对象走，容器局部会随 key 重挂载丢稿）——store 本里程碑零增量，useSelectedSession/selectSession/drafts intents 删除，§A.0/§A.1/§A.2/§A.4/§A.7/§B/§C 联动改写。②新增 §D.5 core 对齐对照表——方法链+数据推导逐条直核 core 源码 file:line；0 红线，2 个注意点（ToolCallBlock 字段名 id/arguments 与事件 callId 命名不一致；AgentStatus 三态→running 二态投影）；接缝 #4（SurfaceManager 出口）顺带核实收口 |

| 2026-07-20 00:3x | **实现 S1+S2 落盘 tsc 绿**：web-runtime session/ 六文件（conversation/fold-adapter/partial/notifier/session/lineage/manager）+ connection sinks + boot/intents/index 增量 + api-types 扩展（RpcRequest<帧> 窄形、SessionEvent/ContentBlock 真 core 类型）+ fixture 全重写（fx-alpha 60turn 历史脚本、prompt 打字机回放、cancel 中断、常驻 pending approval、fx-beta 子 session 谱系）。tsconfig 加 llm/session/brand references，package.json 加两 workspace dep |

| 2026-07-20 01:2x | **W3 真契约对接 + S3 组件层 + S4 验收全绿**：api-types.ts 删除→api.ts 集中转口（apiproxy 新增 ./api、./client 浏览器安全出口；dsh-session 新增 ./surface 出口）；rpc-log/fixture/connection/session/manager 全链改真四象限形（unary RpcRequest→RpcResponse 回显、流 RpcRequest<帧>、根 respond/RpcReceipt）；hooks 2 文件 + 组件 11 文件（SessionsScreen 局部选中态/翻页锚定/工具卡双态/占位卡/InputBar）；fixture host 流加 fx-gamma 5s 翻转（面板 §D-6b 素材）；Manager 加审批/问答帧未实例化缓冲（pending 不落 history 的 F.7 例外面）。client.ts 修浏览器 base（dsh.internal→location.origin，Node 注入不变）。**验收：verify-session.mjs 31/31 PASS（fixture 级全清单）+ verify-session-real.mjs 5/5 PASS（真 host：真列表/真历史/真模型流式回显）+ verify-rpclog-panel.mjs 10/10 PASS（面板零回归）**；web-runtime/web-ui/apiproxy 三包 tsc 绿 |

| 2026-07-20 02:3x | **重连风暴 bug 修复 + 注释英文化**。根因=node:http 桥接层：`req.on('close')` 自 Node 16 起在请求体读完即触发（无体 GET 立即），两条 SSE 一开即被 client abort→循环重连（12s 132 请求）；fixture 假流不走桥接故三脚本全绿掩盖。修复=改挂 `res.on('close')` + `writableEnded` 区分正常结束（落在 webserver/src/index.ts——step1-design 拆包后的新家，bin.ts 旧址改动随拆包废弃；注释写明 Node 16 语义防回归）。verify-session-real.mjs 增 E2-0a/b 连接稳定性断言（12s ≤10 请求+零 abort，防 fixture 掩盖类 bug）。同批：我 touch 过的 web-runtime/web-ui/scripts 全部代码注释翻英文（新纪律：注释英文、文档中文；fixture 数据字符串与 UI 文案保持中文——产品语言非注释）。**验证：12s 请求 132→4、零 abort；三脚本 31/31+10/10+7/7 全绿**；真 host 验证 E2-1 改走「+」新建（fresh host 列表空是 impl 已知 TODO 非本层 bug） |

| 2026-07-20 03:2x | **rpcId caller 视图（形状 a）落地**：createApiClient 返回新类型 CallerApi（unary=payload 直传、载体内 mint+包封；泛型面从 RpcMethodMap 的 RequestPayload/ResponseValue 机械导出；流=payload+signal；respond=ClientResponse 透传不 mint）——契约 ApiProxy 签名零改动，impl 侧照旧。web-runtime 全调用点去 rpcRequest 包裹（session/manager/connection/intents 持 CallerApi）；rpcRequest 降级 carrier-internal（唯一消费者=fixture 假载体，wrapApiWithFakeEnvelopes 改吐 CallerApi 与真载体同形）。验证：apiproxy/web-runtime/web-ui tsc 绿 + 三脚本 31/31+10/10+7/7 全绿。headless.ts（step1-design 属地）3 处调用点如预期破——已回执 main 转派 |

| 2026-07-20 04:5x | **泵方向反转（用户架构纠正）**：批量缓冲从 rpc-log 模块级 let（pendingBatch/flushScheduled——多实例/测试串台隐患）收进 AbstractApiClient 实例——envelope 观测升格数据中间层正式切面：实例私有 batch+微任务 flush+`subscribeEnvelopes(listener)` 订阅面（listener 异常隔离，观测不得破坏载体）；onEnvelope 保留为逐条虚方法（内喂缓冲，无订阅者零成本）。rpc-log 降级纯订阅者：`ingestEnvelopeBatch` 只做 batch→RpcLogEntry 映射+环形截断入 store（nextId 留模块级——纯展示 key 非 wire 态，注明理由）；tapToStore/clearPending 删除，WebApiClient/FixtureApiClient 的 tap 构造参数删除（boot 里 `api.subscribeEnvelopes(ingestEnvelopeBatch)` 一行接线）。三包 tsc 绿+三脚本 ALL PASS×3 |
| 2026-07-20 04:3x | **收口批**：fetch/handler.ts（本轮 touch 文件）注释全翻英按减量口径；client.ts 文件头随改。全仓 grep 确认 ApiClientBase/CallerApi 零残留（headless.ts 已由 step1-design 并轨 InProcessApiClient）。apiproxy/dsc tsc 绿 + 三脚本 ALL PASS |
| 2026-07-20 04:1x | **命名修订落地**：ApiClientBase→`AbstractApiClient`、CallerApi→`IApiClient`（用户拍板）；三面关系一句话已写进 IApiClient JSDoc——ApiProxy=impl 实现的窄形签名契约、IApiClient=client 消费的 payload 直传视图、AbstractApiClient=两者之间的桥。9 文件机械改名，三包 tsc 绿 + 三脚本 31/31+10/10+7/7 全绿 |
| 2026-07-20 03:5x | **caller 视图 + 抽象基类合并落地（追加拍板）**：createApiClient 废弃 → `ApiClientBase` 抽象类（协议不变量全在基类：mint/四象限信封/zod/SSE 解析/CallerApi 域方法；切面=abstract doFetch 传输 + 可覆写 onEnvelope tap 默认 no-op；callUnary/openMux/openHost 设 protected virtual 供无 HTTP 平台覆写）。子类三个：`InProcessApiClient`（apiproxy 内——进程内注入是本包自有能力，-p 用）、`WebApiClient`（web-runtime 新文件，doFetch=globalThis.fetch+同源 base、onEnvelope=tapToStore）、`FixtureApiClient`（fixture.ts，覆写协议层 virtuals 直连内存 impl，替代 wrapApiWithFakeEnvelopes 包装器——已删）。ApiProxy 契约不动；rpcRequest 从 api.ts 撤下（fixture 本地私有 mint）。验证：三包 tsc 绿 + 三脚本 31/31+10/10+7/7 全绿。headless.ts 届时改 `new InProcessApiClient(host.handler)`（step1-design 排队单里带上） |

| 2026-07-20 05:2x | **input-ux 批次1 契约偏差评审入档（设计 owner 评审）**：①PromptError{op:'send'\|'stop'} 判别 union——无冲突，采纳（快照仍单错误槽、清空时机不变，op 只加判别）；②sendDraft 乐观清稿+失败回填+draftInFlight 在途锁——无冲突，采纳：与「draft 挂常驻 Session 对象」恢复语义正交互补（回填依赖实例常驻，切换/切回 sent 不丢；failed 回填 `sent+新输入` 顺序正确）；连带发现 input-ux 给 Notifier 加了 `notifyNow` 同步通知——评审认定合理但需边界纪律，已在 §A.9.6 补「仅用户手势直接回响可用 notifyNow，帧驱动一律合批」防误用扩散。design.md §A.2/§A.4/§A.7/§A.9/§B.2/§C.6 六处同步更新 |

| 2026-07-20 06:2x | **input-ux 定格修正回刷入档（bb1a7ed5f）**：①§A.4 AssistantMessageNode 加 `interrupted?: true`（停止定格终态标记；分数 seq `turn/end-0.9` 保序；中断工具卡同理 `-0.8+偏移`/error.code='interrupted'）；②§A.2 内部状态表加 `frozenNodes` 派生态行；③§A.9 turn/end 行升级「定格清扫」语义（bb16d956b 删除式→bb1a7ed5f 冻结式：中断输出是价值非残渣，live 与 history 重放同函数收敛）；④§C.3 滚动规则改两规则并存（atBottom 改 onScroll 监听维护修跟随链断裂 + 用户发送强制置底至自己消息入流）。纯回刷无代码改动 |

## 接缝问题（草记，随批补充）

1. **history 分页不保证 replace 闭包**：`surfaceOp: {op:'replace', start, end}` 引用的 seq 若被翻页截在窗口外，core fold throw「start seq not found」。§A.5 已设计 client 侧降级防御（foldDegraded），但契约层「页边界对齐消息边界」未提 replace 语义——将来 compact 落地后建议契约补「replace 目标所在页整体返回」或 server 侧展开。只报告不擅改。
2. **隐式 resume 后 subscribed 帧是否补发未明确**：mux 流打开时只对 attached session 发 `session/subscribed`；冷 session 经 `history()` 隐式 resume 变 attached 发生在流已开之后——契约未写 host 是否为新 attach 的 session 补发 subscribed（lastSeq 基线）。不补发时 client 缝检测降级为 liveBuffer seq 去重（§D.3 可运行但基线语义残缺）。请 apiproxy-design 明确并写进契约 §3.3。
3. **SessionSummary 无 title 字段**：ui-product §6 标题规则（首条用户消息生成+手动重命名）无契约支点；本里程碑列表用 sessionId 截断顶替（§F 明确出局），将来 additive 加 `title?: string` 即可，无破坏性。
4. ~~dsh-session 包出口是否 re-export SurfaceManager~~ **已核实收口**（review 整改 #2 顺带）：包根只出口 foldSurface/守卫，SurfaceManager 走 `@deepseek-ai/dsh-session/src/surface.ts` 子路径（`./src/*` 通道在，apiproxy 先例）。已写进 §A.5。

## 接缝问题

（发现契约缺口记在这里，只报告不擅改）
