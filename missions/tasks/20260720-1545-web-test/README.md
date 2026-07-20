# web smoke 测试（client 组包三层测试体系）

> owner：web-test（常驻）。口径升级（2026-07-20 16:0x team-lead 转述用户）：三层——①fetch/SSE 协议较强覆盖；②session/connection 对象层编排式测试；③React 层最简浏览器冒烟。

## 三层落点（全部零新依赖）

| 层 | 文件 | 车道 | 用例 |
|---|---|---|---|
| 1 协议载体 | `packages/host/apiproxy/tests/client-handler.spec.ts` | 根 vitest include 天然扫到；窄循环 `test:gui` | 17：unary 往返/业务错 200/rpcId 失配 throw/zod 拒收/method-path 失配/坏信封空 rpcId/404/400/500/超时/SSE 顺序+注释行/跨 chunk 重组/mid-stream throw→stream/error/abort 停流/respond 往返+坏形/tap 合批+throw 隔离+零订阅+退订 |
| 2 对象层 | `packages/client/web-runtime/tests/{session,manager,connection}.spec.ts` + `fake-api.ts`（可编程 IApiClient+deferred 控时序+流手泵）+ `event-script.ts`（事件构造器） | 同上 | 34：open 状态机/幂等/错误折叠/liveBuffer 缝合去重/chunk→partial→定稿/中断冻结（partial+孤儿 tool call）/seq 洞修复重拉/翻页锚定+断层 fail-soft+防重入/乐观清稿恢复/重入丢弃/pending 增删/resync generation 守卫/引用稳定 toBe/manager 懒建常驻+pending 缓冲重放+list 单飞+host 四帧路由+handleConnected 只 resync 已开/connection 就绪握手+断流重连+describe 失败重试+stream/error 收敛+sink 隔离+stop 停环 |
| 3 浏览器 smoke | `apps/web/tests/smoke-{fixture,real}.e2e.ts` + `support.ts`、`vitest.web.config.ts` | `test:web`（独立 config，先重建 dist） | 4：fixture 起页+一轮对话+零 /api+零 pageerror；真 host 起 dsc web+真模型一轮（skipIf 无 key） |

npm scripts：`test:gui`（1+2 层窄循环，~1s）、`test:web`（3 层）。**coverage 处置**：根 vitest.config.ts coverage.exclude 加 `packages/client/*/src/**`（pr-gates 拍板「client 显式排除」的机械落地）；host/apiproxy src 被 1 层测试拉进 per-file 100% 门后的补齐属 pr-gates 既定活。

## 对表状态（已全部闭环 2026-07-20 17:1x）

- **arch-carrier**：五问逐答收到（f720e8847/5a880f202 = 终态），闭环确认无异议。落盘行为全钉：A4 rpcId 抢救/'invalid-request' 哨兵双分支、A2 S→C 值域二级 parse throw + SSE 坏帧三型丢弃不杀流、A1 stream/error 两层分工（载体层断帧到达、connection 层断收敛重连）、onOpen 时机四断言、外部 signal abort（reason 传递）。他的 verify-carrier-errors.mjs 与 vitest 两车道互补不收编。
- **arch-session**：两条对表（S3/S4/S5 + C2/C1 增量）收到并闭环确认。他点名的 vitest 独有断言全钉：pendingBuffers 上限 32 保最新+removed 清 buffer、createEnvelopeIngest 闭包隔离（同 rpcId 双实例不串味/id 各起/orphan→'(unknown)'）、S5 四面引用稳定、C2 严格握手（holdStreamOpen 手控就绪窗口：describe ok 双流未 establish 时 onConnected 必须等；suppressStreamOpen→超时兜底不 wedge）、onStateChange 去重序列。**分工定型**：verify 脚本管浏览器黑盒回归，vitest 管数据层语义一等断言；他后续行为刀会在落盘回执附「对表增量」直接点我。

## 踩坑记录

1. apps/web/tests 在根 tsconfig include 外 → vite-tsconfig-paths 不映射 → vitest.web.config resolve.alias 一条解决。
2. temp-cwd 下 tsx 双重失效：包名不可解析（createRequire(REPO_ROOT) 解析绝对 loader URL）+ tsconfig paths 丢（TSX_TSCONFIG_PATH 指回仓库根）。
3. 真回复提示词要求 ~100 字防 pulse 竞态假红（verify-session-real 教训）。
4. `pnpm run typecheck` 对 client/host 包本有 26 处 TS6307（根 tsconfig references 未含 client/host 项目——构型批在途活），我的 4 处同源新增不另修，构型批并 references 后自愈。
5. InProcessApiClient 下 caller abort 表现为流正常结束而非 fetch reject（无真网络）；测试两态兼容。
6. SessionListEntry 是平铺 `{...summary, depth}` 不是 `{summary}` 包裹。

## coverage 复核（2026-07-20 17:2x-18:1x，用户命题「client 排除能否取消」）

**判定：web-runtime → a 档（可开），web-ui → b 档（维持排除，我任长期 owner）。**

实测基线（62 用例时）：web-runtime 整体 65%/63%（session 93、manager 87、connection 97、纯函数件 50-75、boot/intents/fixture/web-api-client 全 0）；web-ui 24 文件全 0（React 层，无 jsdom 基建，组件将大改——结构性缺口，前置条件=组件重做完成+RTL 基建决策（新依赖需用户点头））。

补齐动作（冻结期工作区，+6 个新 spec：partial/lineage/notifier/api-helpers/boot-intents/fixture/preinit + 3 个既有 spec 扩容；web-runtime 用例 62→125，test:gui 全量 149）。终态 **99.5%/97.3%**，残余 12 处全部为防御性不可达臂（逐条核实）：
- session.ts 175/316/371、manager.ts 92：`transportError` 恒 ok:false 的 `folded.ok?` 防御臂、`older[0]?.seq ??` 空数组臂、repairGap 重入卫（acceptLiveEvent 已先挡）。
- connection.ts 101-102：Promise executor 同步替换的占位箭头函数。
- fixture.ts 81/229/285/346：稠密日志的稀疏卫、非空串 match 的 null 臂、steer 前置已保证的 `?? 1`、gamma 恒在的 `!== undefined`。
- rpc-log.ts 45：非空 Map 首键恒非 undefined。
- fold-adapter.ts 32/58/126：materializeNode default 臂（surface-eligible 过滤后不可达）+ padded 稀疏卫。

**已收官（de2180d76）**：main 授权（annotation-only 豁免）后 12 处 `/* v8 ignore -- reason */` 已注（含 connection.ts 双占位箭头需拆两条单行 ignore 的坑——`next 2` 不剥第二个箭头的函数计数）；探针实测 941/941 stmts + 389/389 branches per-file 100% 过门；exclude 已收窄为 `packages/client/web-ui/src/**`；全仓 test:coverage 零 client 阈值报错。临时探针 config 已删。收官时发现 `compact-basic/tests/loader-composition.spec.ts` 1 例 5s 超时——**stash 验证与我的改动无关**（干净树同样红，环境性慢），已按「记台账不追修」口径入账。

**web-ui 缺口档案**（b 档长期表）：24 文件全 0；分层=components/*（17 个 tsx，等组件重做）、hooks/*（useConversation/useSessionList，uSES 接线，RTL 后可测）、utils/*（formatRelative/renderProbe/theme，纯函数，RTL 无关**随时可补**）、App/index（装配，跟组件走）。触发条件：组件重做完成 → 先补 utils 纯函数与 hooks，再议组件层。

## 验证记录（2026-07-20 终态）

- `pnpm run test:gui`：5 文件 62 用例全绿 ~1.2s（apiproxy 21 + session 22 + manager 8 + connection 9 + rpc-log 2；均对两位 arch 落盘终态验证）。
- `pnpm run test:web`：build+4 用例全绿 ~8s（含真模型一轮）；keyless 下 real 自跳。
- commit 链：e561e7e0a（3 层）→ c945b4ae9（1/2 层 +1070 行）→ d04f5d018（carrier A1/A2/A4 终态钉）→ 7130f3658（C2 严格握手对齐+S5 子结构）→ ddf681aa0（pendingBuffers 上限/held 握手窗口）→ cb767aa1e（rpc-log 隔离）。
- 期间两次「teammate 落盘打红我用例」均当场校准（A4 空串→哨兵、C2 grace→严格握手），印证「落盘代码即答案」的对表工作流。
