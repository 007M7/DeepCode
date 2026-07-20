# tsconfig host/client 拆分实施细案（fw-react 起草 2026-07-22；只方案不实施）

> **终态修订（2026-07-22 收敛刀）**：用户裁定不设 tsconfig.host.json——根 tsconfig.json 恢复 host 聚合原职（含 exclude packages/client），新增文件只有 tsconfig.client.json；typecheck=`tsc -b tsconfig.json tsconfig.client.json`；verify-cordis-config 双聚合并列种子。下文 §1 的 host.json/根壳化描述为拆分期中间形态，已被此终态取代；其余结论（A 类切断/归属表/刀序）不变。

> 背景：client 与 host 对 cordis Context 的 declare merge 撞名（`sessions`：SessionStore vs SessionsService；`loader`：vendor Loader vs ClientLoader）。用户已拍板**多 tsconfig 拆分**方向；v3 §4.0 ClientContext 裁决作废待删。本文=可执行细案，执行者按刀序照做。
> 现状确诊（盘上核实）：**撞名发生在两层**——①根聚合 program（tsconfig.json 的 include 把全仓 tests 聚成单 program，127 个 references 的 d.ts 同室，llm-retry/app-boot 两处红即此）；②**client leaf program 内部也撞**（packages/client/runtime/src/index.ts:48 FIXME 实证：runtime 自己的 `sessions: SessionsService` merge 与经 connection→dsh-session index d.ts 链进来的 host merge 同 program）。**拆聚合只治①；②必须切类型链**（见 §4）。

## 1. 拆分后 tsconfig 文件清单

### 1.1 文件表

| 文件 | 性质 | 内容 |
|---|---|---|
| `tsconfig.base.json` | 不动 | paths/编译选项唯一源（两侧共用） |
| `tsconfig.host.json` | **新增**（= 现 tsconfig.json 改名收缩） | noEmit 聚合：include=现 root include 全部 + `"exclude": ["packages/client/**"]`；references=现 127 条**减去 12 条 packages/client/**（vendor/cordis 等保留——host 本来就用） |
| `tsconfig.client.json` | **新增** | noEmit 聚合：include=`packages/client/*/tests/**/*.ts` + `**/*.tsx`；compilerOptions 加 `"jsx": "react-jsx"`、lib 加 DOM；references=12 条 packages/client/*（传递闭包由各包自身 tsconfig references 供给，聚合不重复列 host leaf） |
| `tsconfig.json` | **保留为纯壳** | `{ "extends": "./tsconfig.base.json", "files": [], "references": [{host},{client}] }`——编辑器/工具的目录锚点；**不再有 include**（单 program 聚合就此消灭） |
| `tsconfig.vitest.json` | 改 extends | 见 §3 |
| `tsconfig.build.json` | 不动 | build 走各 leaf 项目自身 program，与聚合无关（但受 §4 A 类切断的益处：client leaf 不再见 host merge） |

要点：
- **12 条 client references 名单**（从现 tsconfig.json 平移）：ui-slots/ui-primitives/web-react/connection/runtime/ui-layout/ui-sidebar/ui-conversation/ui-trajectory/ui-theme/i18n/web。
- client 聚合**不列** vendor/cordis、host leaf（llm/session/tools/brand/apiproxy/user-approval/user-interaction/invariants）——`tsc -b` 自动沿各包 references 建传递闭包；聚合只列直接被 include 文件 import 的项目根。若 client specs 直接 `import 'cordis'`（web-react specs 不用，ui-* client specs 会），再补 vendor/cordis 一条即可，执行时以报错为准。
- client 聚合首次纳管 `.tsx` specs（现 root include 只到 `.ts`，全部 tsx spec 至今零 tsc 检查）——预期首跑翻出存量 tsx 类型错，属还债，修在同刀。
- 编辑器行为不回退：VS Code 对 tests 文件本就取最近包级 tsconfig（不含 tests），现状=inferred project，拆后相同。

### 1.2 typecheck 两跑接线

```jsonc
// package.json
"typecheck": "tsc -b tsconfig.host.json tsconfig.client.json"
```

- `tsc -b` 原生支持多入口，两入口各成独立 build graph（共享 leaf 的 .tsbuildinfo，重复 leaf 只 build 一次）；一条命令仍是一个 pnpm script。
- **scripts/run-gates.ts 零改动**：所有 `pnpmScript('typecheck', 'typecheck')` 调用点（ci-primary/node-compat/pre-push）走 pnpm script 间接层，脚本名不变即全链生效。
- `clean:build` 的 `*.tsbuildinfo` glob 已覆盖新聚合的增量文件，不用动。

## 2. 横跨面归属判定表

判定依据三条（按序适用）：A=运行宿主（node→host / 浏览器→client）；B=类型链是否需要见 client declare merge（需要→client）；C=tests 归其 src 所在侧。

| 范围 | 归属 | 依据 |
|---|---|---|
| packages/client/* 12 包（src 经 references，tests 经 include） | client | A+B |
| vendor/*（cordis/cosmokit/schemastery…） | **两侧闭包共享 leaf**，tests（如有）归 host | cordis 是双方 peer；leaf project 单 build 无冲突（cordis 自身不 merge sessions/loader） |
| packages/host/apiproxy | **双侧闭包共享 leaf**；tests 归 host | 协议同构测试跑 node（InProcessApiClient）；client 只经 /api、/client 两子路径吃类型 |
| packages/host/runtime、host/webserver | host | A（node 载体） |
| packages/hooks/* | host | A（Claude/Codex hook 桥全是 node 进程件） |
| packages/ui/*（acp/tui/jsonrpc/app-boot/commands/permission/tool-ask-user） | host | A（node 侧 UI 桥；「ui」前缀勿与 client/ui-* 混淆） |
| packages/ui/user-approval、user-interaction | **双侧闭包共享 leaf**（apiproxy api 引其 id/answer 类型）；tests 归 host | B（§4 切断后 client 只见其 /types） |
| packages/core/session、llm/llm、core/tools、util/brand | 双侧闭包共享 leaf；tests 归 host | 同上（wire 词汇表供方） |
| packages/support/*（invariants/testkit/llm-replay/acp-snapshot/loader-smoke） | host；invariants 兼双侧闭包 leaf | client 各包 src/invariant.ts import dsh-invariants（其 cordis merge key 不撞 client，容忍，见 §4 C 类） |
| packages/web/*（web-search 能力座——**≠ packages/client/web**，命名雷区） | host | A |
| 其余全部 packages/*（core/bash/fs/lsp/skill/compact/context/subagent/workflow/todo/guard/cordis/session-persistence/sdk/examples…） | host | A |
| examples/*（根目录 cordis.yml leaves） | host | A（node 启动） |
| apps/cli | host | 对 client 的唯一触点是 `require.resolve('@deepseek-ai/dsh-client-web/dist/index.html')`（apps/cli/src/web.ts:33）——运行时资产路径，非类型依赖；执行时核实 apps/cli 是否本就在根 graph 内（现 references 未见其条目），不在则维持现状 |
| scripts/**、website/** | host | A（node 工具与站点构建；verify-client-closure 等脚本读 client 包是当数据读，非 import） |

**无「双跑」条目**：所有共享包都是 leaf project 单 build、两聚合各自引用，不存在同一 tests 进两个 program 的情形。

## 3. tsconfig.vitest.json 拆不拆：不拆，改挂靠

结论：**不拆**。该文件只是 vite-tsconfig-paths 的路径映射范围（文件头注释自证「never a tsc -b target」），vitest 只转译不 typecheck——**specs 的类型隔离由 §1 两聚合负责，不由 vitest 面负责**；运行时不存在 declare merge 冲突问题。

唯一必要改动：现 `"extends": "./tsconfig.json"` 在根壳化（files:[] 无 include）后仍能继承 paths（paths 住 base，经 extends 链传递），**但为了不依赖壳的形态，直接改 `"extends": "./tsconfig.base.json"`**，include 原样保留。验收：`pnpm exec vitest run packages/client/web-react/tests/store.spec.ts`（映射面探针）照过。

## 4. A 类残余：拆聚合后 client program 仍见 host declare 的链路与最小切断点

### 4.1 确诊链路

TS 规则：import 某模块即装载其文件级 module augmentation。client 侧现存两条进水管：

```
① connection/src/api.ts ──→ '@deepseek-ai/dsh-session' index ──→ declare module 'cordis' { sessions: SessionStore }   ★撞 runtime 的 SessionsService
② connection ──→ '@deepseek-ai/dsh-host-apiproxy/{api,client}' ──→ apiproxy 内部 import session/llm/user-approval/user-interaction 的 index ──→ 同上循环
```

`loader` 撞名无 A 类残余：client 侧零 import @cordisjs/plugin-loader（执行时 grep 复核），拆聚合即断根。
C 类（容忍不切）：dsh-invariants、dsh-llm/dsh-tools 等的 cordis merge key（invariants/llm/tools）不与 client key 撞——是类型宇宙污染但不报错；浏览器产物纯度另由 verify-client-closure 把守，本案不扩大。

### 4.2 最小切断点（精确到文件+行；原则=新增类型子路径出口，绕开 index 的 augmentation 装载）

**新增出口四件**（各包 package.json exports + tsconfig.base.json paths 各一条）。闭包纯度已盘上复核：三份 types/presentation 文件自身零 augmentation；**但 session/src/types.ts:2 与 tools/src/presentation.ts:8 都 import `'@deepseek-ai/dsh-llm'` 主入口**——llm index 的 merge key=`llm` 属 C 类不撞，A 类切断不受影响；将来要清 C 类时改这两行指 llm/types 即可（本案不做）。plugin-loader 已复核 client src 零 import，`loader` 撞名拆聚合即断根（§4.1 结论盘上证实）：

| 包 | 新子路径 | 指向 | 供出类型 |
|---|---|---|---|
| dsh-session | `./types` | src/types.ts（已存在） | SessionId、SessionEvent 族 |
| dsh-llm | `./types` | src/types.ts（已存在） | ContentBlock、StreamChunk、CallId |
| dsh-tools | `./presentation` | src/presentation.ts（已存在） | ToolCallView、ToolResultView |
| dsh-user-approval / dsh-user-interaction | `./types` | **新建 src/types.ts**（现纯类型窝在 index.ts，先抽出、index 再 re-export——两包仅 index+invariant，抽取量小） | ApprovalRequestId/ApprovalOutcome；AskUserQuestionItem/AskUserQuestionAnswer |

**改写点清单**（import specifier 机械替换，逻辑零改）：

client 侧：
- packages/client/connection/src/api.ts:12（dsh-tools→/presentation）、:20（dsh-session→/types）、:21（dsh-llm→/types）
- packages/client/connection/src/fixture.ts:8（llm）、:9（session）
- packages/client/runtime/src/sessions/：conversation.ts:6、partial.ts:5、session.ts:6-7、fold-adapter.ts:6（执行时以 `grep -rn "'@deepseek-ai/dsh-\(session\|llm\|tools\)'" packages/client/{connection,runtime}/src` 取全量，防列漏）

apiproxy 内部（②管的根治点）：
- src/api/rpc.ts:11、events.ts:9-12、approvals.ts:8-9、approvals.schema.ts:8、sessions.ts:7-8、sessions.schema.ts:9、questions.ts:8、questions.schema.ts:8、events.schema.ts:8（同样以 grep 取全量）

**augmentation 靶点保持不动**：apiproxy src/api/sessions.ts:12 的 `declare module '@deepseek-ai/dsh-llm'`（ContentBlockMap 扩块）继续指向主入口不改——它是 host program 的合法 merge，client program 不装载该文件即不受影响；执行时以 host 聚合绿+client 聚合绿双验。

**验收探针（④专属）**：切断后在 client 聚合跑一个负样本文件（临时 spec：`const s: import('cordis').Context['sessions'] = null as never` 的类型应解析为 SessionsService 而非 union/error），加 `grep -rn "from '@deepseek-ai/dsh-session'" packages/client --include='*.ts'` 应零命中（/types 除外）。

## 5. 执行刀序（每刀独立绿、可停可续）

| 刀 | 内容 | 验收命令 |
|---|---|---|
| 刀1 | 四件类型子路径出口（session/llm/tools 加 exports+paths；user-approval/user-interaction 抽 types.ts+出口）。纯加法 | `pnpm run typecheck`（现单 program 仍绿）+ `pnpm run build`（exports 面有效） |
| 刀2 | apiproxy 内部 9 处 import 切 /types（②管根治） | `pnpm run typecheck` + `pnpm exec vitest run packages/host/apiproxy` |
| 刀3 | client 侧 connection/runtime 全量 import 切换（§4.2 清单+grep 兜底） | `pnpm exec tsc -b packages/client/runtime packages/client/connection` + 该两包 vitest |
| 刀4 | client/runtime 复原契约 merge：删 index.ts:48 FIXME、`sessions: SessionsService` 落 declare（rt-core 属地，**由 rt-core 执行**，本刀序仅排位） | `pnpm exec tsc -b packages/client/runtime` 绿（此刻 host merge 已不可见） |
| 刀5 | 两聚合落地：新增 tsconfig.host.json/tsconfig.client.json、根壳化 tsconfig.json、package.json typecheck 两跑、tsconfig.vitest.json 改 extends | `pnpm run typecheck`（两 program 各绿）+ llm-retry/app-boot 红消失复核 + vitest 映射探针 |
| 刀6 | tsx specs 还债（刀5 首跑翻出的存量 tsx 类型错，按包分派属地 owner 修） | `pnpm exec tsc -b tsconfig.client.json` 绿 |
| 刀7 | 文档收尾：v3 §4.0 ClientContext 裁决删除+architecture §2 分层表补两聚合一行（**main 属地**，契约文档只有 main 可改） | `pnpm run doc-sync`（免门禁期可缓） |

刀1-3 与刀5 可并行推进后合流（1-3 不动聚合、5 不动包内 import），但**刀4 必须在 3 之后、刀5 的 client 聚合绿依赖 3+4 齐**。风险位：①types.ts 闭包不纯（暗 import index）→ 执行刀1 时 grep 即知，若不纯先做同包内类型下沉小刀；②tsx 还债量未知 → 刀6 独立成刀就是为了不阻塞主链。

—— 以上。执行前待 main 审：§2 归属表（尤其 apps/cli 维持现状项）、§5 刀4 的 rt-core 排程。
