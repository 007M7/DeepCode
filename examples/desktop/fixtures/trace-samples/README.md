# trace-samples — 战略清单 v2 的样例事件流

demo 阶段的前端 mock 兜底数据。文件按战略清单 §1.x 分类，形状仿真真机 wire（`session.event` notification 里的 `SessionEvent`，参见 `packages/core/session/src/types.ts:210` 的 `SessionEventMap`）——**从 wire 返回体形状一路仿真到最终渲染结果**（`memory/multi-agent-shared-repo-rules.md` 第 4 条）。

## 命名约定

```
{clauseId}-{scenario}.json
```

例：`1.3-B-inject-mid-plugin.json` = 战略清单 §1.3 族 B（中途插件提醒）的样例。

每个文件是一个 JSON 数组，元素为完整 `SessionEvent`（含 `type / seq / time / data` 顶层字段，surface 类型可能附 `sourceEventSeqs / surfaceOp`）。**seq 严格递增，时间戳单调**——`renderer.js` 消费时不做去重/排序，样例直接可喂。

## 文件清单（对应 v2 §1）

| 子项 | 文件 | 说明 |
|------|------|------|
| §1.1 Trace | `1.1-trace-one-turn.json` | 一个完整 turn 的 step 三条（step_start/assistant_message/tool_call/tool_result/step_end），用于 trace 卡三段渲染 |
| §1.1 Trace 密流 | `1.1-trace-chunk-heavy.json` | 一 turn 一 step 携 115 条 `assistant/chunk` + `request/header` + `tool/call/result`，用于验证 chunk-run 折叠与逐行 JSON 展开（task #157） |
| §1.3 A | `1.3-A-inject-session-start.json` | hooks-claude 首 turn 塞 CLAUDE.md |
| §1.3 B | `1.3-B-inject-mid-plugin.json` | tool-bash 中途路径提示 |
| §1.3 C | `1.3-C-inject-time-tick.json` | time-context 定时 tick |
| §1.3 D | `1.3-D-inject-guard.json` | repeat-tool-guard 循环提示 |
| §1.3 E | `1.3-E-inject-compact-shadow.json` | compact-basic 影子 user_message（与 §1.7 合渲） |
| §1.3 F | `1.3-F-inject-approval-policy.json` | user-approval 策略切换 |
| §1.3 G | `1.3-G-inject-unknown-plugin.json` | 未知插件（兜底族） |
| §1.3 H | `1.3-H-inject-user.json` | user-injected skill include |
| §1.4 Subagent | `1.4-subagent-structured-return.json` | subagent.started/finished 一对 + 子 session 事件 + 结构化 JSON return（wire 侧空档：`lastAssistantMessage` 里第一个 code_block=json 时视为结构化 return） |
| §1.6 seq | `1.6-workflow-seq.json` | 顺序流 5 步（wire 空档，走前端 mock；带 `_mock: true` 标） |
| §1.6 fan-out | `1.6-workflow-fanout.json` | 一步派 3 分支并跑 |
| §1.6 DAG | `1.6-workflow-dag.json` | 6 节点 DAG（多入度多出度） |
| §1.6 iter | `1.6-workflow-iter.json` | while 循环 3 轮 |
| §1.6 branch | `1.6-workflow-branch.json` | 决策分叉 A/B 选一 |
| §1.7 Compact | `1.7-compact-three-events.json` | compact/start + compact/summary + compact/end + 影子 user_message（合渲 §1.3-E） |
| §4 Growth | `growth-three-stage.json` | 三段式演进：粗糙 prompt → 接入 rubric → +42% 通过率 |
| §2.1 turn (#162) | `2.1-turn-trajectory-mixed.json` | 一 turn 内 reasoning → text → tool-row → tool-result → reasoning → text（sealed，无 delta，走 replay 路径），用于 rec 22-bis 容器渲染验收 |
| §2.2 reasoning (#162) | `2.2-reasoning-interleaved.json` | 一 turn 两块 reasoning（tool call 前后各一），reasoning-delta 流式，用于 rec 21 折叠块 + 位置保真 |
| §2.3 toolcall stream (#162) | `2.3-toolcall-delta-stream.json` | write_file 7 片 + run_bash 3 片 `tool-call-delta`（`argumentsDelta` 拼接=最终 sealed args JSON），用于 rec 22 partial-JSON 行式渲染 |
| §2.5 compact diff (#162) | `2.5-compact-before-after.json` | 12 条 shadowedSeqs + 一块 summary（~10x 压缩比）+ 每 seq 的 `_shadowedPreview` demo 兜底文本，用于 rec 32 "前后对照"（tab） |
| §2.6 subagent inline (#162) | `2.6-subagent-inline-trace.json` | 父 turn `spawn_agent` + 子 session 3 turn 完整轨迹 + `subagent.started/finished` 通知 + 父侧 `tool/result` 携 `childSessionId` meta，用于 rec 31 子轨迹下钻 |

## 关于 mock 标记

真 wire 上没有的字段/事件（§1.6 workflow/*、§1.4 subagent 结构化 return 的 JSON discriminator）在样例里带 `_mock: true` 顶层字段 + 一条 `_mockReason: '...'` 说明。渲染插件应**忽略** `_mock` 字段（不影响真机路径），fixtures 加载器可用它区分"这条数据 wire 上是否已到齐"。

## 加载入口

demo 附带调试菜单里加一族 `mock: trace-sample …` 按钮，点击后从对应 fixture 文件读事件流并按 seq 逐条 dispatch，跟真事件走同一 renderer 路径。挂接位置：`src/renderer/renderer.js` 的 debug 菜单区（沿用 widget mock 的模式，见 `docs/widget-channel-design.md` §9）。
