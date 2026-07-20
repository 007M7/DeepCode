# Tool 卡 wire 设计页(F1:host 现算 view 随帧下发)

> **实施记录(host 半,用户确认后生码)**:契约刀 `a9a4adc92`(events.ts ToolEventView + mux view 槽 + sessions.ts HistoryEntry 改形 + 两 schema 判别外层锁/内部透传 + index 再导出 + apiproxy 增 dsh-tools type-only 依赖);impl 刀 `e8a24ecf1`(viewFor 纯函数 + live openCalls 表(turn/end 清、断连中开流走 session.events 回扫兜底)+ history 页内回扫 + throw/parse 失败软回退;spec 2 用例覆盖三型到达/无 presenter 无字段/throw 兜底/双路配对)。apiproxy+runtime tsc 绿,apiproxy 载体 21 spec 全过。client 半归 arch-session(在途,history 改形他侧接)。

> 已拍口径:①F1=host 算好下发,只发标准三型(generic/terminal/diff);②范围=标准三型,diff 自然涵盖(write/edit 已声明 DiffCallView),特化富卡不做;③G7 不动(presenter 现状给啥画啥);④view 不进 session log——纯派生物,live 出帧现算、history 分页现算,无 presenter → 无 view → client 回退 generic JSON 卡。零新 session 事件。

## 1. wire 形态

view 附着在**载体信封层**(mux 帧与 history 响应),不动 SessionEvent 本体——「view 不进 log」在类型上的兑现就是 SessionEventMap 零改动。

```
// events.ts — mux 帧:session/event 帧加可选 view 槽
| { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }

// sessions.ts — history 响应:events 数组改为条目化(事件+可选 view 并排)
history(...): Promise<RpcResponse<{ events: HistoryEntry[]; hasMore: boolean }>>
interface HistoryEntry { event: SessionEvent; view?: ToolEventView }

// 新增共享类型(events.ts 定义,sessions.ts 复用):
type ToolEventView =
  | { for: 'call'; view: ToolCallView }      // 配 tool/call 事件
  | { for: 'result'; view: ToolResultView }  // 配 tool/result 事件
```

要点:
- **字段名 `view`,可选**。只在 event.type 为 tool/call、tool/result 且 presenter 产出非 undefined 时出现;其余事件类型永远缺席。缺席=client 走 documented-default(generic JSON 卡)。
- **放信封不放事件内**:event 保持「session log 可重构」不变量(model-visible ⟺ logged);view 是 host 对同一事件的伴随注解,同一事件重放时 view 可以不同(注册表变了),这正是「不进 log」的语义。
- **`for` 判别**:call/result 两套 view 词汇类型不同(ToolCallView vs ToolResultView),一个判别字段让 client switch 不必回看 event.type;也给将来 merge-extensible 留位(自定义卡插件线加成员走 declaration merging,本页不展开)。
- ToolCallView/ToolResultView 类型**从 @deepseek-ai/dsh-tools 型面 re-export 进 apiproxy 契约**(type-only import,先例:契约已 import dsh-session/dsh-llm 类型);三型词汇的 owner 仍是 core tools 包,契约只引用。
- history 的 `events: SessionEvent[]` → `HistoryEntry[]` 是**破坏性改形**(pre-release 立场直接改,不留兼容),client fold 侧同步改由 arch-session 承接。

## 2. host 侧实现点(runtime/src/api-proxy.ts)

两条产帧路径共用一个纯函数 `viewFor(event): ToolEventView | undefined`:

- **live 路径**:mux() 里 `ctx.on('session/event', ...)` 的 push 处,`queue.push(frame({ type:'session/event', sessionId, event, ...viewFor(event) 折叠可选 }))`。
- **history 路径**:history() 的 paginate 返回后 `events.map(event => ({ event, ...viewFor(event) }))`——「按当时注册表现算」即分页时刻的 ctx.tools。

`viewFor` 内部(遵 ACP 桥先例 ui/acp/index.ts:1169-1172):
1. event.type 非 tool/call、tool/result → undefined。
2. `const def = ctx.tools.get(name)`(全局视图;host 面向 web 无 per-agent scope 语境——scope 语义如需细化属后续,不阻塞)。tool/result 要拿同 callId 的 tool/call 的 name+arguments:live 路径维护 session 内 callId→{name,args} 小表(bounded,turn/end 清),history 路径在页内回扫配对;跨页断配对 → undefined(documented-default 兜底,不跨页取数)。
3. call:`def?.presentCall?.(JSON.parse(arguments))`;result:`def?.presentResult?.(args, { content, isError, meta })`(ToolResult 三字段直接从 tool/result 事件搬)。
4. **presenter throw / arguments JSON.parse throw → catch 折 undefined**(软失败,console.error 一行;错误不上 wire,client 只见「无 view」)。tool 已卸载(def undefined)同路。

## 3. 契约文件改动清单(packages/host/apiproxy)

| 文件 | 改动 |
|---|---|
| api/events.ts | MuxFrame session/event 成员加 `view?: ToolEventView`;定义并导出 ToolEventView(for-判别双成员) |
| api/sessions.ts | history 返回值 events 改 `HistoryEntry[]`;定义并导出 HistoryEntry |
| api/events.schema.ts | 新增 toolEventViewSchema:**外层结构校验**(for 判别 + view 是 object),view 内部 `z.record(z.unknown()).passthrough` 级**透传不深校**——view 是 host 产物、client 只读不回传,深 schema 会把三型词汇手抄一遍进 schema(A5 教训:手抄 core 形状必漂移);外层校验保证判别可 switch |
| api/sessions.schema.ts | historyEntrySchema(event 沿用现有 sessionEventSchema 透传纪律 + 可选 view 同上) |
| package.json / 无 | 无新依赖:apiproxy 已依赖(或 type-only 引用)dsh-tools 需在 devDeps/peer 核对,type-only import 不产生运行时依赖 |

zod 纪律一句话:**C→S 不涉及(view 无上行方向);S→C 侧 view 按「host 产物 client 只读」透传,只锁判别层。**

## 4. client 侧消费(概述,细节归 arch-session)

fold 侧把 HistoryEntry/帧上的 view 随事件带进 surface 节点;组件层按 `view.view.card` switch 三组件(generic/terminal/diff),无 view 或未知 card 走 generic JSON 卡(documented-default,merge-extensible 词汇的落空成员天然兜住)。

## 5. replay / 卸载语义

view 是 args/result 的纯函数派生物,**任何时刻的真相源都是当时的 presenter 注册表**:live 帧用出帧时刻、history 用分页时刻。同一事件两次 history 可以得到不同 view(插件更新)或从有到无(tool 卸载)——这不是 bug 而是契约:log 里只有事件,卡片外观跟着当前运行时走。client 对「无 view」一律 generic JSON 卡,不缓存旧 view 跨会话。

## 不做清单(三段式)

| 触发条件 | 返工点 | 预埋 |
|---|---|---|
| 自定义卡片插件线启动(cordis 插件注册自有 card 词汇) | ToolEventView 加成员 + client 注册渲染器 | for-判别 union 已 merge-extensible;client unknown card 落 generic 兜底已documented |
| run_code 时间线等特化富卡需求被用户点名 | 特化 view 类型 + 专组件 | 同上一行,无额外预埋 |
| host 出现 per-agent tool scope 场景(子代理卡片) | viewFor 的 ctx.tools.get 加 scope 参数 | get(name, scope) 签名 core 已有,call site 单点 |
