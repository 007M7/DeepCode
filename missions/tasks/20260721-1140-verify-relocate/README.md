# verify 脚本迁移：scripts/verify-*.mjs → missions/scripts/

## 口径演变（都是用户拍板）

1. 初始任务：判定六个 verify 脚本能否进各自包的 tests/ 车道。
2. 11:55 拍板：「能转 e2e.ts/spec.ts 的直接转，其他的删掉」。
3. **12:0x 终板：「算了，全迁移到 missions（commit 按照一个删除、一个新增来搞）」+「missions 目录不提交的（指不进最终历史），引用里不要说明这个脚本」**——不再转测试，六个脚本原样迁 missions/scripts/，代码注释里不得引用 missions 路径。

## 第一步判定结论（已作废，留档）

六个全部可转、零删除：carrier-errors→apiproxy 单测；webserver 两探针→webserver e2e（keyless 自包含）；rpclog-panel/session/session-real→apps/web test:web 车道（自起 server 基建 support.ts 现成；session-real skipIf 无 key）。v8-ignore 全量 grep：**无一条以 verify 脚本名作理由**（fixture.ts:291 等均为独立理由，风险不存在）。若将来要重启「转测试」，此判定表直接可用。

注：hardening 探针针对的 R1 加固（畸形 %-URL → 400 而非进程崩）在本树 webserver src **未落地**（audit must-fix；修复只存在于 worktree-cordis-web c678cb032 的 catch 兜底）。该脚本现跑对本树是红的——迁移后此事实不变，记在这里防丢。

## 实施（终板口径）

- `git mv` 六个脚本 → missions/scripts/（保历史）；六文件头部 Run 注释与相对 import（carrier-errors、backpressure 两个 ../packages → ../../packages）同步改。
- 代码注释引用清理（3 处，均不再提脚本路径）：
  - packages/client/web-ui/tests/rpclog-panel.spec.tsx — 改为「browser black-box coverage belongs to the browser acceptance lane」
  - packages/client/web-runtime/src/fixture.ts timing hooks — 改为「browser acceptance runs」
  - apps/web/tests/smoke-real.e2e.ts — 去掉「verify-session-real lesson」措辞，保留约束本身（短回复会在轮询窗内完成导致 pulse 断言竞态）
- knip/run-gates/package.json：六脚本本就不在任何 gate（「not part of any gate system」），scripts/**/*.mjs 通配少了文件 knip 不报错，零牵连。
- commit 形态：刀 1 = 删除侧（scripts/ 六文件消失 + 3 注释清理）；刀 2 = 新增侧（missions/scripts/ 六文件）。
- 残留引用：仓库内仅 missions/ 历史工作记录还写着旧路径 scripts/verify-*（历史档案不改）；packages/client/web-runtime/lib/types/fixture.js 是构建产物不入库。

## 验证与落库

- 迁移后全仓 grep：missions/ 之外无任何 scripts/verify-{carrier,rpclog,session,webserver}* 引用（missions/ 历史档案里的旧路径不改）。
- 六脚本 node --check 全过（迁移只动头注释与相对 import 深度）。
- 三个注释文件 eslint 无 error；两刀 pre-commit（vendor guard/lint/typecheck）全绿。
- 刀 1 **a1c073b72** chore(gui): remove browser/probe verify scripts from scripts/（6 删 + 3 注释清理）
- 刀 2 **eb86ae7ab** chore(gui): mission-local browser/probe verify scripts under missions/scripts/（6 增）
- 基线 cec15bcbf，pathspec 只含本任务文件，未 push。

## 追加：R1 加固落地（team-lead 派发，2026-07-21 12:1x）

前提修正：此前记「R1 修复在 worktree-cordis-web c678cb032」是**误判**——那刀的 catch 是 /plugins/<id>/client.js 分发端点的 readFile 404 兜底，两棵树的请求回调都无顶层守卫，R1 全仓从未修过、无可移植物。

处置：按 audit 配方自研落地，刀 3 **46a259098** fix(webserver): guard the request callback。
- src/index.ts：createServer 回调改 `handle().catch(...)`——headers 未出 writeHead(400)、已出 destroy socket；非 Error 包成 Error 报 onError（包契约 never prints，不走 console）。
- webserver.spec.ts 新 describe 三条：%-escape 连番 → 400×3 + onError 收到 URIError + 服务存活；字符串 throw 包装为 Error；SSE 中途 stream error（延时一拍保证 200+首 chunk 先落地）→ socket 撕毁 + 服务存活。
- README 同步契约段。
- 验证：14/14 绿；webserver src coverage 100%（branch 24/24）；lint/typecheck 绿（pre-commit）；backpressure 探针回归 ALL PASS；**hardening 探针从 missions/scripts/ 对修后 server 实跑 7/7 ALL PASS**（自起 3184 + DSH_WEB_URL 指向）。
- hardening e2e 转换不做：被用户「全迁 missions 不转测试」终板覆盖；探针留 missions/scripts/ 作验收工具。
