# P0-2 Web 贡献者规范 packages/client/AGENTS.md — 任务档

- **派发**：夜间自动化（progress.md 〇-pre；决策 #4 用户亲拍：英文 AGENTS.md + 中文摘要供 review）。执行人 i18n-design（i18n 任务封存中人力复用）。
- **交付物**：① `packages/client/AGENTS.md`（英文，体裁对齐仓内 AGENTS.md 惯例：短句、可执行、链接不复述）；② 本 README 附中文摘要。一刀 commit：`docs(client): contributor AGENTS.md for the web stack`，不 push。
- **红线**：不写任何「TUI 环境红」等自家环境问题（用户令）；批间清收件箱（硬前置）。

## 内容清单（派发单六条 → 成文结构）

1. 分层红线：web-runtime 对象层 / hooks 纯数据层 / 纯 props 组件三层；store 无业务对象；Notifier 双通道；web 纯呈现层不进 session log——自 conventions 架构红线节提炼英文化。
2. 目录约定：两级制 `leftmenu/<bar>/`、`sessiontabs/<tab>/`——以 arch-session 的 app-shell design（missions/tasks/20260721-0041-app-shell/design.md，已落盘）为准。
3. 样式：token 体系，引 docs/web-styling.md。
4. 测试与门禁：test:gui 窄循环 / test:web / check:pre-push；jsdom=E2E 行为定位不追覆盖率；web-ui 在 coverage exclude 的口径；新组件配最小 spec。
5. 新组件 checklist：认领坑位→建目录→组件+spec→跑窄循环→commit 规矩。
6. 链接：三篇 GUI Agent Notes（gui-layering-and-rpc-protocol / gui-web-client-architecture / web-styling-system）+ 测试 RFC（gui-testing-system）。

## 素材核实记录

- app-shell design 已落盘（20260721-0041-app-shell/design.md）：两级制目录、三注册表（leftMenu/sessionTab/detail）、互不 import 规矩、共享件下沉 components/。
- 门禁命令核实：package.json `test:gui`（vitest packages/client packages/host）、`test:web`（先 build dist 再 vitest.web.config）、`check:pre-push`（run-gates pre-push）。
- coverage 口径核实：vitest.config.ts exclude `packages/client/web-ui/src/**`（注释：组件重做前暂缓，jsdom 车道已存在）；web-runtime 全量 per-file 100%。
- spec 模板已存在：missions/tasks/20260721-0010-gate-friendly/component.spec.tsx.template（P0-3 产物，AGENTS.md 指向它的正式落点等 P0-3 定，先按模板现位引）。
- verify 脚本惯例：scripts/verify-*.mjs（browser 黑盒回归，每 bug 钉断言）。
- Notifier 双通道：web-runtime/src/session/notifier.ts（markDirty 合批 / notifyNow 手势直达）。

## 工作日志

- 0041 接单，清收件箱（无积压），盘素材：progress.md 〇-pre、app-shell design、vitest 配置、testing note、web-styling、spec 模板。
- 0052 README 落盘。

## 中文摘要（供用户 review；对应 packages/client/AGENTS.md 六节）

**定位**：`packages/client/*`（+构建入口 apps/web）的贡献者规范，英文、agent-readable，补充根 AGENTS.md 与 packages/README.md，不复述链接目标内容。

1. **分层红线**：三层单向知晓——web-runtime 对象层（React-free，grep 可断言）→ hooks 纯数据层（uSES 订快照，无 JSX）→ 纯 props 展示组件（耗材可整体重写）。四条不可谈判：store 无业务对象（zustand 只装跨视图呈现态，视图局部事实进组件 state）；rpcId 严格双向（发起方 mint、业务签名只见 RpcRequest<P>）；Notifier 双通道（notifyNow 仅用户手势直接回响，帧驱动一律 markDirty 合批）；web 纯呈现层（「怎么画」不进 session log，host 现算随帧下发，重放重算）。
2. **目录两级制**（对齐 app-shell design 词汇）：`shell/`（壳+三注册表+builtins）、`leftmenu/<bar>/`、`sessiontabs/<tab>/`、`components/`（共享叶）、`hooks/ utils/ style/`（横切）。互不 import（跨功能共享下沉 components/）；bar/tab/detail 块走 shell 注册表（register 返 disposer，toolCardRegistry 同构，将来插件纯加法）；**坑位认领流程**：挑 placeholder tab→建目录→换掉占位组件，不许在体制外造功能。
3. **样式**：docs/web-styling.md 权威；token 住 global.css，组件 CSS 只引 token 零字面量色值；CSS Modules+clsx、无组件库无 tailwind；产品文案中文、注释英文。
4. **测试与覆盖率（新口径）**：**两个 client 包都进 per-file 100% 门**——web-runtime 走 node 套件、web-ui 走 jsdom 车道；防御臂 `/* v8 ignore -- <reason> */` 必带真理由。web-ui spec=端到端行为核验非单测（真实 props 渲染断用户所见，不断 class/hook 内部/渲染次数——行为形 spec 经得起组件重写）；jsdom 走 per-file pragma；分层断言纪律（数据层语义归 web-runtime/apiproxy 套件，浏览器黑盒归 verify 脚本，每个浏览器可见 bug 修复钉断言进 verify）。
5. **三级检查阶梯**：改 GUI 码=test:gui（秒级内环）；动构建面/boot/静态承载=加 test:web（重建 dist+浏览器 smoke 对）；PR 前=check:pre-push（窗口间不要求每 commit 跑）。别人的红不默修不默过，记 handoff 等 PR 窗口清算。
6. **新组件 checklist 六步**：认领坑位→容器进功能目录（叶子纯 props、数据走 hooks 层）→抄邻近 jsdom spec（一条 happy path+一条边界即完整首版）→token/中文文案/英文注释→test:gui 绿（动构建面加 test:web）→非平凡改动同 PR 配 Agent Note。

**供稿处理**：web-test 两节（agents-md-contribution.md）已融入；其 Section A 前两条（旧「exclude 长期化」口径）按 main 检查点新口径改写，已知会 web-test。

## 工作日志（续）

- 0104 收全停令系列四单，冻结在 README 态。
- 0203 检查点放行（P0-2+P0-3 合刀），开工回执。
- 0206 核对新口径：vitest.config.ts exclude 已只剩 web-ui/src/index.tsx（jsdom-e2e 线口径变更记录一致）；web-test 供稿覆盖率两条须改写。
- 0209 AGENTS.md 本体落盘（英文六节）；回执 main+知会 web-test。
- 0212 中文摘要落盘本 README；下一步 commit。
- 0224 main 补令：目录节加时态说明。盘面核实 shell/leftmenu/sessiontabs 尚未建目录（壳三刀在途），AGENTS.md 目录节加「Shell restructure in progress; tree converges to this layout」一行；amend 进原刀（未 push，历史安全）。
- 0241 web-test 点出残留：checklist 第 3 步「one happy path + one edge state is a complete first spec」是旧口径（01:3x 升级前）；改写为「start from happy path/edges, widen until branches covered — coverage gate applies, assertion style stays behavior-level」。
