# 20260719-2315 style-research：deepseekchat 样式风格调研

**负责人**：style-owner（GUI 样式常驻 teammate）
**参考仓（只读）**：`/weka-hg/prod/deepseek/permanent/ys/private/workspace/gitlab/deepsuite-frontend`（主应用 `apps/chat`）
**目标**：产出「风格基线 + 样式工程编码模式」调研报告，供 web-ui 侧边栏 / session 会话界面统一风格。调研风格与模式，不抄组件。

## 进展

| 步骤 | 状态 |
| --- | --- |
| README 存活信号 | ✅ |
| 1. 设计 token 体系 | ✅ |
| 2. 视觉风格基线（侧边栏+会话流） | ✅ |
| 3. 样式工程编码模式 | ✅ |
| 4. 暗色主题实现 | ✅ |
| 5. 可移植资产清单 + 阶段二建议 | ✅ |

## 产出

- [style-research.md](style-research.md) — 调研报告（完稿，五节 + 阶段二建议）
- [docs/web-styling.md](../../../docs/web-styling.md) — 阶段二首件：长期样式规范（token 表权威定义 + 视觉基线 + 编码规范 12 条 + 演进规则），取值证据回链本报告

## 阶段二改造记录（RpcLog 面板照规范落地，2026-07-20）

- `style/global.css` 重写为规范三分区（token 表 + 基础 + `.scrollable` 工具类）；规范 §1.1 增补 `--scroll-color*`、`--text-on-solid` 两组 token。
- `RpcLog.module.css` / `App.module.css` 全量换 token 引用（零裸色值；`#fff` → `--text-on-solid`），圆角对齐语义档（浮层 16 / 按钮 8），hover 换透明度制，交互过渡统一 `--dur-fast` + `--ease`；payload 底色改 `--bg-sidebar` 与面板分层。
- TSX 仅动 className：`.list` / `.payload` 挂 `.scrollable`（RpcLogBody.tsx、PayloadJson.tsx），组件逻辑零变。
- 验收：vite build 绿；`scripts/verify-rpclog-panel.mjs` 10/10 PASS；对比图 [rpclog-before.png](rpclog-before.png) → [rpclog-after.png](rpclog-after.png)（截图脚本 [shot-rpclog.mjs](shot-rpclog.mjs)）。
- 视觉基线零偏离（规范 §5 偏离表保持空）。附带修复：worktree 首次 `pnpm install` 缺失导致 web-runtime 的 zustand 未链接、build 红——install 后绿，与样式改造无关。

## 核心结论速览

- token 三层（static→alias→specific）+ `body[data-ds-dark-theme]` 整表覆盖，组件零主题感知；我们按体量压成两层。
- 视觉基线：侧边栏 261px、条目 40px/圆角 12px/选中 deepseek-100 淡蓝底；会话流 840px 列宽，仅用户侧有气泡（22px 圆角、deepseek-50 底），助手侧纯文档流。
- 边框与 hover 用黑/白透明度制（叠任何底色都成立），文字五级灰阶，动效三档时长+三条贝塞尔。
- 工程模式：camelCase + clsx、composes 零使用、:global 只穿透第三方前缀、动态样式走 CSS 变量桥、tcm 生成 .css.d.ts 提交进仓。
- §5.2 给出我们的 token 表草案（亮色实值+暗色占位）、§5.3 十条编码规范、§5.4 现有三 css 改造要点。
