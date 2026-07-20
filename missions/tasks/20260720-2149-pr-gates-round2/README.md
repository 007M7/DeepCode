# pr-gates round2：worktree-web2 主树干第二轮门禁（2026-07-20）

Owner：pr-gates（第二轮冷启动，前身归档 missions/tasks/20260720-1440-pr-gates/README.md）。

## 任务理解

- **树**：/weka-hg/.../worktree-web2，分支 worktree-web2，**直接在主树干干活，无独立 worktree**。
- **目标**：自上轮门禁绿之后主线新进内容（tool 卡四刀、jsdom 车道依赖、missions 文档、32→10 重排）之上，跑 AGENTS.md 完整 CI 序列逐门修到全绿，**不 push**（用户执行）。
- **CI 序列**：typecheck → lint → duplication → test:coverage → test:snapshot → doc-sync → website:build → verify-module-graph → build → hygiene → demo:echo smoke。
- **已知预期雷**（先核实再修）：
  1. translation-pairing：2026-07-20-gui-testing-system.zh.md 单语，需翻英+i18n.yaml（体裁按上轮三篇先例）。
  2. export-jsdoc/knip：tool 卡新导出（ToolEventView/toolCardRegistry/toolViewCards/registerToolCardRenderer 等）。
  3. coverage：tool 卡新增 src 的 per-file 100% 缺口——host 侧补测试；web-runtime 按 web-test 既有纪律（补用例或 v8 ignore 注明）；**web-ui 仍 exclude 不动**。
  4. doc-sync 子门：config-catalog/module-graph 可能需重生成。
  5. 环境性超时三处（compact loader-composition / sdk scripts / TUI 2 例）：复跑验证，真环境性只记录不追修（PR note 材料）。
- **归刀纪律**：机械小修可合批一刀；结构性修（翻译、coverage 补测）各自成刀；**不改已入库历史，只顶上追加**。commit --no-verify、无 co-auth 尾注。
- **铁律**：批间清收件箱（头号整改项——前身两次基点事故均因跳单）；小步落盘每批回执；见「暂停/冻结」立即停。

## 前置同步（开工第一件事）

确认 history-rebase 收官：HEAD 为 missions 顶刀 + host-runtime.spec 无未提交改动 + test:gui 全绿。

- [x] HEAD = e1226eebf chore(gui): mission work logs（missions 顶刀）✓
- [x] host-runtime.spec 无未提交改动、无进行中 rebase ✓；239857d8a vs 旧 12e491db4 差异恰为该 spec 3 断言 `.event` 解包 ✓
- [ ] test:gui 全绿（进行中）

## 门禁进度表

| # | 门 | 状态 | 备注 |
|---|---|---|---|
| 1 | typecheck | 未跑 | |
| 2 | lint | 未跑 | |
| 3 | duplication | 未跑 | |
| 4 | test:coverage | 未跑 | 雷 3 |
| 5 | test:snapshot | 未跑 | |
| 6 | doc-sync | 未跑 | 雷 1/2/4 |
| 7 | website:build | 未跑 | |
| 8 | verify-module-graph | 未跑 | |
| 9 | build | 未跑 | |
| 10 | hygiene | 未跑 | 雷 2（knip） |
| 11 | demo:echo smoke | 未跑 | |

## 新增刀清单

（随修随记）
