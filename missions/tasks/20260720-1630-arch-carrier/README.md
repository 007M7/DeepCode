# arch-carrier：载体错误通道批 + apiproxy/webserver nice（2026-07-20）

> 任务书 = 审计台账 20260720-0300-web-dev-2-onboarding/audit.md 批 1 + 批 2 的 webserver 半边。属地：packages/host/apiproxy + packages/host/webserver。

## 落地清单（两刀）

**刀 1 `f720e8847`（apiproxy 错误通道）**

- A1（must）：sseResponse catch 里真发 `stream/error` 帧（错误折成 RpcError internal）再 close；enqueue 二次失败（消费者已 cancel）单独吞并注明。
- A2（must）：S→C 双层校验补齐——readSse 对帧过 serverRequestSchema + muxFrame/hostFrame schema；callUnary ok 值按 method 查 `UNARY_VALUE_SCHEMAS`（mapped type，key 锁 RpcMethodMap）二级 parse。8 个死 schema 全部激活。
- A9（nice，并入 A2）：坏帧单帧 try/catch，console.error + 跳过不杀流。
- A4（should）：信封 parse 失败时 body 里捞 string rpcId 回填；捞不到用固定哨兵 `RpcId('invalid-request')`；rpcIdSchema 去掉 min(1)（自伤性校验，注释说明理由）。
- A3（should）：UNARY_ROUTES 改 mapped type（key 覆盖性 + per-key schema/invoke 类型双锁），`as never` 删除；唯一保留 cast 是 Wire<>→exact 收窄（与 exactOptionalPropertyTypes 约束相符，注释指向 Wire 文档）。
- A5（should）：askUserQuestionItemSchema 补 `satisfies z.ZodType<Wire<AskUserQuestionItem>>`——**核实未漂移**，锚上即编译通过。
- A7（nice）：抽 `postJson` 收 callUnary/respond 双 POST 重复。
- A8（nice）：`parse(...) as ServerResponse` 冗余 cast 删除。
- A10（nice）：IApiClient unary+respond 加可选 `signal?: AbortSignal` 第二参，与 timeout 用 `AbortSignal.any` 合并。连带修 InProcessApiClient：真 fetch 语义是 signal abort 即 reject（即使 handler 无视 signal），原实现会让挂死的 impl 击穿超时/取消。
- 跨属地协调（main 裁决）：openMux/openHost/readSse 加 `onOpen?: () => void` 第三参，语义=响应头已到、流可读、首帧之前；IApiClient.events 同步。供 arch-session 修 C2 就绪握手接线。

**刀 2 `5a880f202`（webserver 半边 + R5）**

- R2 webserver 半边：bridge 尊重 `res.write` 返回值，false 时 await drain（'close' 同时唤醒，防断连卡死泵）。**FrameQueue 上限是 runtime 属地没做**，留给 feature-session 或后批。
- R5（跨属地已备案）：dsc web 打印行补 LAN 地址（首个非环回 IPv4），因实际 bind 0.0.0.0。

## A1 矛盾核实结论（main 前置核实令）

审计「stream/error 零生产者、空 catch 静默吞」在其时点**属实**：`git show f720e8847^:...fetch/handler.ts` 的 sseResponse catch 为空体（仅一句谎称收敛的注释）。web-test 的「mid-stream throw → stream/error」用例之所以绿，是因为其 suite（c945b4ae9/d04d5d018）跑在我**已落盘未 commit** 的工作树改动之上——即可能性 a（代码已变），变更者就是本批在途 diff，不存在第二条已工作路径，无范围收窄。此事同时是「测试先于源码 commit」倒挂的成因，已由两刀 commit 收口。

## A2 漂移探测结论

补上双层校验后跑真流量同构路径 + web-test 21 用例 + satisfies 锚定编译：**未发现任何 schema 漂移**（askUserQuestionItemSchema 锚上即过、6 个 Value schema 对现有 impl 返回全通过）。无需上报用户裁决的清单。

## 验证

- `scripts/verify-carrier-errors.mjs`（新增，tsx 跑，InProcessApiClient 同构路径）：A1×2、A2×2、A4×2、A10、onOpen 共 8 断言全绿。
- `scripts/verify-webserver-backpressure.mjs`（新增，起真 startWebServer 于 3097 + net socket pause/resume）：慢客户端泵停在低水位（41/200 chunk）、恢复后推进到完成，2 断言全绿。
- `packages/host/apiproxy/tests/client-handler.spec.ts` 21/21 绿（web-test 在我改动落盘后钉的套件；其外部 abort 用例原依赖「transport 自己响应 signal」，按真 fetch 语义改为 reason 透传——见刀 1 的 InProcessApiClient 修正）。
- 包内 tsc 绿：apiproxy/webserver/runtime/web-runtime/dsc 全部。

## A6（已裁：不做）

`since` 续传参数在 GET SSE 载体上无承载通道；曾建议契约 §6 补「载体通道未定（query vs POST）」一行。用户裁决：**不做、RFC 不补，实现续传时再定载体**。本条关闭。

## 遗留/移交

- FrameQueue 无界缓冲（R2 runtime 半边）→ feature-session 属地。
- repo 全量 typecheck 有一条 tsconfig file-list 报错（tests 文件不在 root project file list，web-test/构型批属地），包内 tsc 不受影响。
