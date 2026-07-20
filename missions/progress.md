# GUI 项目进度账本

> 2026-07-22 13:2x 版（P-I 已收口+两轮收尾波次完成）。本版=下次冷启动唯一入口；施工期逐日流水已压缩，细节见 git log 与 missions/tasks/ 档案。

## 一、当前态（2026-07-22 13:2x）

- **P-I（UI 插件化系统全链路）已完成并收口**：T0-T5 全里程碑达成，W5 验收通过（真 key 真 host 真模型 8/8 动线+figma 逐屏判定高 0 中 0 低 6+回归钉全入库）。**严禁 push/merge——留用户本人**；conventions 7a 未答问题不得代答。
- **基线**：用户已两轮 rebase/squash——远端 worktree-web2 = origin/master 合并串 + `93d6adea1`（全部产品代码一刀）+ `8b428cb14`（missions 档案一刀）；其上叠本地后续刀。**missions/ 假设最终不进 PR**——一切对外文档（RFC/README/docs）必须自含，不得引用 missions。
- **在途（唯一）**：rt-core 的 RFC①（gui-layering-and-rpc-protocol 双语对）落库后**全线暂停**（用户令）。
- **待用户令**：①对新远端基线的 rebase 叠刀（操作同前两轮：`git rebase --onto origin/worktree-web2 <本地对应点>`，本地对应点=用户指定，上轮为 7e529a633 语义等效点）；②check:pre-push 终验时机；③merge。

## 二、已完成波次台账（P-I 收口后）

| 波次 | 内容 | 状态 |
|---|---|---|
| 门禁修复 | build（tsdown 豁免→后随 apps/web 恢复撤销）/verify-cordis-config/module-graph/doc 全系列/type-equiv/export-jsdoc/knip（最小 diff 重写 69322d3bb）/README×2（118 全 conform）/constraints+invariants（client 12 包 fw-react 四批+host 三包 rt-core，118 伴生全 conform）/llm-retry timeout 提额 | ✅ 除 test/lint/publint/snapshot 终验未跑（等用户令） |
| 工程结构调整（用户三点裁定） | ①apps/web 恢复=vite 应用（@deepseek-ai/dsh-frontend,ui-shell）,packages/client/web 降回 lib（bootWebShell 库导出）;②tsconfig 收敛：删 tsconfig.host.json,根恢复 host 聚合原职,仅新增 tsconfig.client.json,根 diff 压至 ±13 行（fw-react）;③exports 纪律：dshClient 八包 node index=只空 apply 零类型导出,实现/类型全住 src/client/,消费走 /client 子路径,测试 import /src 直取,纯库三包豁免（rt-core 四刀） | ✅ |
| 时效清扫 | 文档半（convo-a 五刀）：missions 根三份 07-18 旧世代档案加取代头注/testing.md 残句/web-styling token 换代注记/四对 GUI Agent Note 路径更新+i18n 重录。测试半（convo-b+rt-core）：死码三件退役——init/getSessionManager 单例对、**Session draft 面整删**（sendDraft/setDraft/snapshot.draft,仲裁 24d413133：真实链走 ConversationService+apply draftsStore,双账=平移残留）、WEB_EVENTS/WebEventName（web-cordis pre-provision 零消费）;判留 4 组有据（对象层五件套/loader stub 契约钉/fake-api 双胞胎/connection 三 spec） | ✅ |
| RFC 刷新（missions 不进 PR 前提） | ②web-client-architecture 已落（0033d7d8a,fw-react）：自含化+新增 cordis 树/装载链/slot 体系/scope 寻址三大节,对象层去 draft 面,目录终态;①layering-and-rpc-protocol（rt-core）在途收尾 | 🔄 ①落库即全线暂停 |

## 三、架构终态速记（防冷启动失忆；对外叙述见两份 RFC）

- **工程结构**：host 三包（apiproxy/runtime/webserver）+ client 纯库三包（ui-slots/web-react/ui-primitives，根 index 库形态）+ dshClient 插件八包（connection/runtime/ui-theme/i18n/ui-layout/ui-sidebar/ui-conversation/ui-trajectory——node index=只空 apply，实现全在 src/client/，消费走 /client 子路径）+ apps/cli + **apps/web（@deepseek-ai/dsh-frontend，vite 应用，薄 main 调 packages/client/web 的 bootWebShell）**。
- **tsconfig**：根=host 聚合（exclude packages/client/**）+tsconfig.client.json=client 聚合（12 包+tsx specs+apps/web+purity spec/preset）；typecheck=`tsc -b tsconfig.json tsconfig.client.json` 单命令双 program——host/client 对 cordis Context merge 同名键（sessions/loader），双 program 隔离撞名；client 经 session/llm/tools/approval/interaction 的纯类型子路径（./types 等）消费 wire 词汇，不装载 host augmentation。
- **装载链**：GET / 注 __DSH_BOOT__（HostWebPluginRegistry 订 Loader+dshClient 声明）→loader（壳静态持有）immediately 四包并行先装→其余 inject 拓扑→DSHClientProxy.loadPlugin 闭包工厂+DI require 模块表+导出面回登记→settled 一次成型。三防线：bundle 纯度门（resolveId 三分类,裸名自动改写 /client）/loader e2e 吃真产物/mount 锚 fiber-less throw。
- **契约史料**：v3 全落款在 missions/tasks/20260721-1520-web-plugin-rfc/api-contracts.md（含 §3.1 apiproxy 纯度/§3.2 导出清单与溶解项/§4.0 双 program 终裁）；style-spec.md=样式对账永久底册。missions 不进 PR，故正式权威=两份 RFC+各包 README+docs/ 生成物。
- **draft 单账终态**：草稿归 ConversationService.drafts（persist keyed by sessionId）+apply.ts composer 编排（乐观清稿/失败回填）；Session 无 draft 面。

## 四、挂账（PR 窗口/P-II）

- **PR 窗口**：pre-push 终验未跑段（test 全量/lint/publint/snapshot——注意 test-invariants 已随伴生齐而自愈过，最后一轮结构调整后需复跑）；低 6 视觉偏差（判定报告尾表）；W5 补拍两项（树展开/hover 已拍过一轮,审批琥珀条=P-II）。
- **P-II 池**：approvals composer 换面板/slash/toast/details 三段/HMR+unload 完整链/history 纯持久化读（1.75s 案已证伪为旧 lib 测量假象——rt-core history-timing-data.md，纯读改造只剩语义论据，动 wire 需用户拍板）/agentFor+summarizeCold 下沉 host/viewFor+backscanArgs 删除刀（涉 wire view 字段）/assertServable O(n) 冷径/delegationDepth 拒收加 warn/drafts persist 回迁/二级树+长列表+暗 hover+审批条视觉复核。
- **终局工程**：回刷历史（missions 消档+注释转英——执行时冻结全部）。

## 五、teammate 名册与现状（2026-07-22 13:2x；主会话可能被 clear/compact——本表=接续依据）

> 九人全部**存活常驻**（SendMessage 按名直达）。主会话重启后：先读本文件+git log 恢复盘面，再按「在途/待命」逐人接管。当前全队在「RFC①落库即全线暂停」令下。

| teammate | 属地 | 当前状态 | 备注（接续要点） |
|---|---|---|---|
| **rt-core** | connection/runtime 两包+host 三包（apiproxy/runtime/webserver）+装载链/纯度门 | 🔄 **唯一在途**：RFC①（gui-layering-and-rpc-protocol 双语对+i18n 重录）收尾中，落库后按令静默 | 超时惯犯但产出全队最大；信箱丢失率高——催报先看 git log。档案 missions/tasks/20260721-p1-rt-core/（含 history-timing-data.md） |
| **fw-react** | web-react 包+tsconfig 双聚合体系+clientcontext-audit 细案 | 💤 待命（RFC② 0033d7d8a 刚交付） | 早期三连超时后改极小步脱困；擅长机械大批量与文档。档案 20260721-p1-fw-react/ |
| **fw-slots** | ui-slots/ui-primitives/ui-theme/i18n 四包+token 体系 | 💤 待命 | 全队质量标杆；图标管线（geometry 直读→实证落库）共识在档。挂账：sparkle 精确字形/wordmark svg 未提取。档案 20260721-p1-fw-slots/ |
| **ui-shell** | ui-layout+packages/client/web（lib）+apps/web（vite 应用）+tsdown preset+W5 探针 | 💤 待命 | W5 probe/smoke-real/boot-chain e2e 全它写；apps/web 恢复刚完工。档案 20260721-p1-ui-shell/ |
| **ui-side** | ui-sidebar | 💤 待命 | 亲验 dump 三方对账典范（纠过底册转录误差）；挂账：行级…菜单锚点/树展开态样式已实装。档案 20260722-p1-ui-side/ |
| **convo-a** | ui-conversation 包 owner（service+skeleton 半+公共类型） | 💤 待命 | 四次超时重灾户但全部完整交卷；M1a 定性/P0 双实例破案是它。与 convo-b 同包分工默契已成。档案 20260722-p1-convo-a/ |
| **convo-b** | ui-conversation 消息流半（chat/+toolviews/+apply 接线）+README 实质化+测试清扫 | 💤 待命 | 判死判留过堂最严谨；12 包 README 两节全它写。档案 20260722-p1-convo-b/ |
| **ui-traj** | ui-trajectory | 💤 待命 | 占位包已齐（10 测+chrome.header 第二挂点）；P-III 真实现时回叫。档案 20260722-p1-ui-traj/ |
| **figma-flows** | 视觉顾问（figma 数据/查询脚本/判定报告） | 💤 待命 | W5 两轮逐屏判定+style-spec 三批底册全它出；PIL 像素实测法；答疑走 SendMessage。无独立档案（产出在 w5-visual-verdict.md/style-spec.md） |

派工惯例（重启后沿用）：契约仲裁只归主会话（v3 落款后广播）；跨属地改动报备制；同包双人（convo-a/b）由 a 划文件边界；视觉问 figma-flows 架构问 main；>15min 零落盘催报，超时唤醒消息要含「从盘上恢复」指引。

## 六、环境与纪律

- dsh web：`pnpm run demo:web`（src 模式启动 ~8.5s 是 tsx 转译；built lib 快一个量级）；DEEPSEEK_API_KEY 在树根 .env；playwright chromium 已装；figma 数据 .artifacts/figma/（gitignored）；W5 探针 .artifacts/w5-full-probe.mjs 可重放。
- 编制九人常驻（fw-slots/fw-react/rt-core/ui-shell/ui-side/convo-a/convo-b/ui-traj/figma-flows），全员待命；档案在 missions/tasks/20260721-p1-*/ 与 20260722-p1-*/。
- 纪律沉淀：pathspec 精确到文件（四起卷刀教训）；共享分支零历史改写；裁决以盘上落款为准信箱只是提醒；状态疑问先 git log；编译只 pnpm exec tsc -b；dist 不入库改完重跑 tsdown；client 值 import 必须走 externals 形态（双实例坑）。
- W5 验收形态（用户定）：真跑不静态绿+截图对 figma 只比要做的+动线亲走。
