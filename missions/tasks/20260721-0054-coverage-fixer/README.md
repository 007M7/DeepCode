# 20260721-0054 coverage-fixer

PR #443 CI coverage 门红：诊断 + 本地复现 + 最小修复 + commit（不 push）。

## fixer2 接手（2026-07-21 派单全文）

你是 coverage-fixer2（单点收口任务，前任已被 kill，诊断成果已烧进本单，你不用重新诊断）。工作树：/weka-hg/prod/deepseek/permanent/ys/private/workspace/github/deepseek-harness/.vscode/worktrees/worktree-web2（分支 worktree-web2）。读 missions/conventions.md（不读根 AGENTS.md/CLAUDE.md）。

【唯一任务】PR #443 的 CI coverage 门红（run 29756336246），修复+commit（--no-verify，**严禁 push**，用户睡觉中亲推）。

【前任已完成的诊断（可信，本地=CI 红点完全对齐）——6 个文件缺口清单】

- packages/client/web-runtime/src/fixture.ts L95/103/144/289
- packages/client/web-runtime/src/fold-adapter.ts L116
- packages/core/session 或 web-runtime 的 session.ts L515（以本地跑出的实际路径为准）
- packages/host/apiproxy/src/fetch/client.ts L283-285, 299-301
- packages/host/runtime/src/api-proxy.ts 约 10 处：summarizeCold 全函数、viewFor result 臂、backscan 臂、cold-list 臂、history viewFor、internal-error 臂、session/disposed 清理
- packages/host/webserver/src/index.ts L118-126（backpressure drain 臂）

【修法纪律】

1. web-runtime 的 fixture/fold-adapter/session 三处大概率是 rebase 弄丢了旧 v8-ignore——先翻 git 历史 de2180d76 一带找原注释（原 reason 都写好了），优先恢复原注而不是新写用例。
2. host 侧（apiproxy/runtime/webserver）缺口：能用小用例补的补用例；防御性不可达臂（internal-error/backpressure drain 这类）用 `/* v8 ignore -- <真实 reason> */`，一处一个真实理由，不许笼统 untestable。
3. **地盘边界**：web-test 正在同树并行搞 web-ui 的 jsdom 覆盖（它在改 packages/client/web-ui/src 注 ignore + tests/）——你**只动上面清单里的文件**，绝不碰 packages/client/web-ui；commit 前 `git status` 检查，**只 add 自己改的文件**，missions/tasks 里别人的目录和 vitest.webui-cov.config.ts（web-test 的探针）都不许混入。
4. 同树还有四线刚放行（壳骨架/AGENTS.md/respond 设计/OOP 清查），同样只 add 自己的文件。

【执行】

1. 先把本单全文（含清单）复制进 missions/tasks/20260721-0054-coverage-fixer/README.md（沿用前任目录，追加一节「fixer2 接手」）——先落盘再干活，防 API 瞬断丢上下文。今晚 API 瞬断频繁：每修完一个文件落盘一次，README 每文件勾一行进度。
2. 验证口径：修完跑 `pnpm run test:coverage`（全量），零 coverage 报错才算完。
3. 单独 commit（只含修复，不混别人文件），回执 hash+每文件一行的修法摘要。

## fixer2 进度

- [x] packages/client/web-runtime 三件（fixture.ts / session/fold-adapter.ts / session/session.ts）—— 已随 web-test 的 0770d23ba 落库，不归本单 commit。归因修正（team-lead 2026-07-21 核）：这批是 tool-card 批 ce639ffd5 新代码引入的新防御臂注释（web-test 当时未 commit 的在途改动），**不是**前任 fixer 遗留、也不是 de2180d76 旧 ignore 被 rebase 弄丢——旧 ignore 批完好。若后续在这三件再遇红点冲突，以本单版本为准（web-test 的 6 行可整体 revert 作基底，走 team-lead 协调）。
- [x] packages/host/apiproxy/src/fetch/client.ts —— 补 3 个用例进 client-handler.spec.ts（纯加测试不动 src）：已 abort 信号先拒且不碰 transport+string reason 映射、非 Error/string reason 走默认 AbortError 文案、无 signal 直通 handler。窄化跑 100%（108/108 stmts, 35/35 br）。
- [x] packages/host/runtime/src/api-proxy.ts —— 1 处 ignore + 6 个新用例，窄化跑 100%（229/229 stmts, 92/92 br）：
  - ignore 仅 1 处：summarizeCold 的 `meta.cwd === undefined` 空臂（list() 已滤掉无 cwd legacy meta，臂不可达，保留 summarize() 形状对称）。
  - 新文件 tests/api-proxy-cold.spec.ts（2 用例）：①cold list 合并——mtime 来源、locate undefined/文件消失双 fallback 到 createdAt、lineage 投影（structural fake persistence）；②无 persistence+无 factory 的退化组合——list 跳过 cold 合并、resume 失败映射 internal 错误码（吃掉 L263）。
  - api-proxy-view.spec.ts +2 用例：①history 带 view 全景——call/result 视图、meta 透传、孤儿 result/坏 args backscan/无 presenter 三路软落（吃掉 viewFor result 臂 + backscanArgs catch + history viewFor 回调）；②session/disposed 清理——子 fiber 建会话挂 open call 后 dispose，mux 流上验证（吃掉 L390-391）。history 用 structural stub Agent 直接 ctx.agents.register。
- [x] packages/host/webserver/src/index.ts L119-126（backpressure drain 臂）—— 纯补用例（webserver.spec.ts +2 用例 + /api/big 4MiB 双 chunk fixture）：①整读 8MiB 证明 drain 后续写恢复；②mid-chunk 断连走 'close' 腿释放 parked write。窄化跑 100%（59/59 stmts, 20/20 br）。
- [x] 全量 coverage 零 coverage 报错（2026-07-21 03:54 跑完：4712 passed，ERROR: Coverage 计数 0）。仅剩 2 个失败套件是 web-ui 的 branch-tails/rpclog-panel spec import 不到 `components/panels/RpcLog/*`——壳骨架线在途 rename（→ `leftmenu/rpclog/`）所致，web-ui 地盘不归本单，已报 team-lead。
- [x] 单独 commit（--no-verify，不 push）：文档刀 + 修复刀分提，hash 见回执。

注：全量跑要用 `--coverage.reportsDirectory=.artifacts/coverage-fixer2` 隔离，默认 coverage/ 目录和 web-test 的探针撞车（Vitest "Something removed the coverage directory" 报错）。
