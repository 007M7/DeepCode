# T5 注释清扫 sweep 清单（2026-07-20 02:50）

命题：GUI 系列包存量中文**注释**翻英并减量（判据=CLAUDE.md 注释家规：保契约/失败/时序/所有权/安全约束，删复述代码与过程叙述）。**字符串中文不动**（UI 产品文案、fixture 数据、verify 脚本 report/断言文案——后两者与 UI 文案耦合）。

**追加纪律（用户裁决 2026-07-20，回刷批次沿用）**：注释里对 missions/tasks 工作文档的引用（`design.md §X`、`契约 vN`、`F.N 台账`、`ruling N`、归档文件名）全部清除。两级处理：①首选自含——把约束本身一句话说清，不留链接；引用删掉后注释失去信息量的说明它只是指针，整条删。②确需出处的复杂契约改引 docs/rfc/ 正式 RFC（gui-host-client-layering / gui-rpc-protocol / gui-web-client-architecture / web-styling-system 四篇）——例外不是常态。

## 存量盘点（grep -P '[一-龥]' 实测，非任务书口径）

| 范围 | 中文行 | 其中注释（要清） | 其中字符串（不动） | 处置 |
|---|---|---|---|---|
| packages/host/apiproxy/src/api/（14 文件） | 114 | 114（全契约 JSDoc/节注释） | 0 | 批 1：翻译+慎减量 |
| packages/host/runtime | 0 | — | — | 已清零（任务书口径过期） |
| packages/host/webserver、apps/dsc、apps/web | 0 | — | — | 复核零残留 ✓ |
| packages/client/web-runtime/src | 16 | 7（store.ts×5、index.ts×1、session.ts×1） | 9（fixture.ts 全是 fixture 数据串） | 批 2；session.ts 跳过（见下） |
| packages/client/web-ui/src | 72 | ~37（global.css×19、RpcLog.module.css×5、LogRow/PayloadJson/RpcLog/ToolCallCard 各 1-2、InputBar.module.css×1） | ~35（JSX 产品文案：发送/插话/等待审批/载入中…等） | 批 2 |
| scripts/verify-{session,rpclog-panel,session-real}.mjs | 82 | ~13（文件头与节注释） | ~69（report 文案+断言/选择器串，与 UI 文案耦合） | 批 3 |

## 跳过（input-ux 在途，回刷时补）

- packages/client/web-ui/src/components/conversation/InputBar.tsx（字符串本就不动；另 1-2 行 `design §C.6`/`§D.5` 引用待清）
- packages/client/web-ui/src/components/conversation/InputBar.module.css:3（1 行中文注释）
- packages/client/web-runtime/src/session/session.ts（:236 中文节注释 + 9 处 `§A/§D`/`F.4`/`ruling 2` 引用）

## 批次回执

- 批 1（apiproxy src/api/ 14 文件，114 行）：契约 JSDoc 全量翻英、语义保真；减量仅删评审史引用（「22:1x 用户裁决」）；包内 tsc 绿；src/ 中文清零。
- 批 2（web-runtime store.ts/index.ts + web-ui global.css/RpcLog 族/ToolCallCard，11 文件 ~44 行注释）：全部翻英；web-ui tsc 绿；web-runtime tsc 现有 2 个错误全在 input-ux 在途改动的 session.ts（PromptError/draftInFlight），与本清扫无关（本批对该包只动了 store.ts/index.ts 注释）。残留=跳过清单+字符串。
- 批 3（scripts/verify-rpclog-panel.mjs 12 行注释）：翻英，node --check 过；verify-session.mjs / verify-session-real.mjs 注释本已是英文（历史批次已翻），余下中文全是 report 文案与选择器字符串（与 UI 产品文案耦合，不动）。
- 批 5（design-ref 专项终扫，7 处清除，grep 到零）：用户抽查后全变体扫（含 ruling/shape-a/22:0x/step-session/milestone/ledger 等标记样式）。清除：fixture.ts「shape-a ruling」、rpc-log.ts「2026-07-20 ruling」、connection.ts「22:0x ruling」+「step-session extension」、intents.ts/index.ts 节注释「step-session」改「Session」、verify-session.mjs 文件头「step-session」、verify-rpclog-panel.mjs §D-1 的「step-session milestone 替换 blank 壳」叙述整删。终扫残留仅 3 条且均非注释引用：PendingCard.tsx:28（JSX 产品文案）、web-styling.md:101（引正式 RFC 的例外通道链接）、verify-rpclog-panel.mjs:36（report 文案「台账」=面板 UI 概念）。验证：web-runtime tsc 绿、三脚本 ALL PASS。
- 批 4（design-ref 补扫，69 处清除）：全 GUI 包 + 三脚本 + docs/web-styling.md 清除 missions 文档引用。处置分布：apiproxy 契约层 14 处文件头 `design.md v2.0 §X` → 改引 `RFC gui-rpc-protocol`（复杂契约、确需出处）；web-runtime/web-ui 约 45 处 `design §A-E.N` / `F.N 台账` / `ruling N` / `post-W3` → 引用删除+语义内联自含（如 F.7 → 直写 drop 语义、ruling 2 → resident-instance rule）；纯指针注释整条删（partial.ts 的 §A.6、RpcLog.module.css 的 upgrade-rpclog-v2 归档链）；web-styling.md 头部+§6 两处 missions 链接 → 改引 web-styling-system RFC。验证：5 包 tsc 绿、三脚本 node --check 过且重跑 ALL PASS。残留=input-ux 在途两文件（InputBar.tsx:1-2、session.ts 内 9 处 §refs），列入回刷待补。

## 全量验证（2026-07-20）

- tsc：apiproxy / host-runtime / web-ui / apps-dsc 绿。web-runtime 现有 2 错误全在 session.ts（`PromptError` 未定义 + `draftInFlight` 未用）——input-ux 在途改动所致，非本清扫引入（本批该包只动 store.ts/index.ts 注释）。
- 三验收脚本：verify-session、verify-rpclog-panel、verify-session-real 全部 ALL PASS（真 host 3080 在跑）。

## 文件→所属 commit 映射表（回刷批次对号入座）

注释注入的注释所属 commit 以「注释首次出现」为准；下表按文件首次引入 commit（git log --follow --diff-filter=A），已核对本次清扫涉及的注释均源自各自引入 commit（index.ts 的 step-session 节注释经 git log -S 核对属 8372a94b0）。

| 回刷批次 | commit | 文件 |
|---|---|---|
| A | c7037bf42 feat(gui): apiproxy contract package | packages/host/apiproxy/src/api/ 全部 14 文件 |
| B | 2598370e9 feat(gui): RpcLog debug panel | web-runtime/src/store.ts；web-ui global.css、RpcLog.{tsx,module.css}、RpcLogBody.tsx、LogRow.tsx、PayloadJson.tsx；scripts/verify-rpclog-panel.mjs |
| C | 8372a94b0 feat(gui): session milestone | web-runtime/src/index.ts（节注释属此 commit，文件引入是 b9c801bad）、ToolCallCard.tsx；【回刷时补】session.ts:236、InputBar.module.css:3 |
| —（不动） | 8372a94b0 | InputBar.tsx（全字符串）、fixture.ts（全字符串）、verify-session{,-real}.mjs 字符串 |
