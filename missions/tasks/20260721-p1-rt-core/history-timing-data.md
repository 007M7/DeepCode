# 首开 history 相位打点数据（rt-core 采集 2026-07-22 上午；只有数据与复现说明，无实现改动）

> 采集环境：本 worktree 现行代码（host 侧 lib 重建后）；店面=.sessions 实盘五文件（1320/2819/169/1240/1832 行）；机器同 ui-shell 原测。探针=.artifacts/history-phase-timing.mjs（node 直调）+ 复用 ui-shell 的 cold-start-timing-real.mjs / cold-history-per-session.mjs（playwright 全链）。均从 apps/cli 目录跑（依赖语境）。

## 1. 相位表（node 直调 host.api.sessions.history，首开冷路径）

| 环节 | 耗时 | 说明 |
|---|---|---|
| persistence.list（assertServable 门） | 1.2–2.7ms | 逐文件读首行 |
| persistence.load（整 log 读+parse） | 10.2–12.8ms | 251–281KB jsonl |
| sessions.prepare（种子重放入 SessionStore） | 10.3–11.9ms | 1319–1398 事件 |
| agent 事务其余（prepare/scope/driver/publish） | ~8–10ms | agents.resume TOTAL 28.7–31.6ms 减去上两项 |
| **首开全链（history RPC 含 paginate+viewFor）** | **32–45ms** | |
| 再开（agent 已 live） | 1–14ms | |

## 2. 交叉复现（同店面同机）

| 路径 | 首开 | 备注 |
|---|---|---|
| node 直调（上表） | 32–45ms | |
| HTTP+双 SSE 流开着（浏览器同构） | 45–48ms | GET /api/events.mux+host 200 |
| ui-shell 原探针 cold-start-timing-real.mjs 重放 | run1 35ms（settled 170/history 88） | run2/3 history 4/3ms |
| ui-shell 原探针 cold-history-per-session.mjs 重放 | 39/27/13ms（逐会话首开） | 原测同探针出 1777/1764/1742ms |
| 页缓存 fadvise DONTNEED 清空后重测 | 34ms | 无变化 |
| weka 冷读基准（idle 22h 文件 512KB） | cold 1ms / warm 0ms | I/O 排除 |

## 3. agentOptions 差异对照（main 的 22ms vs 1.75s 线索）

| resume 形态 | 耗时 |
|---|---|
| agentOptions={provider,model}（api-proxy 真形态） | 28–31ms |
| agentOptions={}（空） | 10ms |

## 4. 一句话结论

现行代码全链首开 32–48ms，1.75s 不可复现；且原测打开的 673c2212/b7958055 两会话 header 无 delegationDepth，105793665（07-20 17:51）后的 isHeaderLine 拒收、list() 静默跳过、history 只能 session-not-found——原测能打开它们，证明测量进程加载的是 07-20 17:51 之前的 persistence/host lib（lib 陈旧），1777/1764/1742ms 属旧代码环境，对现链无定位意义。

## 5. 排查中顺看到的事实（仅记录，未做任何改动）

- delegationDepth 拒收在 list() 层静默（无日志）——两旧会话「从侧栏消失」的直接原因。
- assertServable 每冷开全量 persistence.list()（逐文件首行）；session.list 的 summarizeCold 逐文件 stat——均 O(会话数)。
- 纯持久化读（load+paginate）≈12ms vs 隐式 resume 全链 ≈32ms，供 §3.1 可议项参考。
