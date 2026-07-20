# 历史二次手术：GUI 文档上浮，底部纯实现

分支 worktree-web2；备份 `backup/pre-docs-float`（= b9df0951f，含 0a/0b 两刀存档后的 HEAD）。铁律：`git diff backup/pre-docs-float HEAD` 为空——满足（0 行）。

## 口径（用户拍板）

- 上浮路径：`missions/` + `docs/rfc/` + `docs/ui-product.md` + `docs/ui-tech.md` + `docs/web-styling.md`。
- 顶部形态：一刀全并（单个 docs commit 收全部文档终态）。
- 工作区在途 RFC 重组四文件先存档 commit。

## 执行记录

- **0a** 8ac722dcc `docs: rfc reorg — three GUI RFCs merged into two`：合并版新文件 + web-client-architecture 改 + 两旧篇删（git 识别 rename 68%）。
- **0b** b9df0951f `chore: mission archives`：上一单 history-rebase 归档 README（曾被盘上误删，凭上下文重建）。此后工作区全净。
- **1** 建 `backup/pre-docs-float`。
- **2** `git filter-branch --prune-empty --index-filter` 重写 5baffffee..HEAD。**坑**：底基 5baffffee 本身含 `docs/rfc/`（约 220 篇既有 RFC），直接 `git rm docs/rfc` 会把它们从每个 commit 删掉（第一版重写后 `docs: gui initial` 没变空反而带出 12317 行删除）。回滚后 index-filter 改为「rm 五路径 + `git read-tree --prefix=docs/rfc/ 5baffffee:docs/rfc` 回植底基树」——即只剥 GUI 增量、保留既有 RFC。预计消失的 commit 全部按预期被 prune：gui initial、design archives、docs: rfc、0a、0b。
- **2b** rebase exec 把剥空只剩 verify 脚本的 `chore: progress` subject 改为 `feat(gui): webserver hardening verify script`。
- **3** 顶刀 c29169fa5 `docs(gui): work log, RFCs, and product/tech/styling docs`：`git checkout backup/pre-docs-float -- <五路径>` 后 commit，58 文件 7099 行。
- **4** 终验三件全过：①diff-vs-backup 0 行；②底部纯度 `git log --name-only 5baffffee..HEAD~1` grep 五路径零命中，且 `HEAD~1:docs/rfc` 树 hash == `5baffffee:docs/rfc`、底部无 missions/；③13 个 commit（12 实现 + 1 顶刀）。refs/original 已清。未 push。

## 最终序列（旧→新，13 个）

| # | commit | subject |
|---|---|---|
| 1 | 60726222e | feat(gui): step1 skeleton — dsc web serves built web UI over booted harness host |
| 2 | c240459ee | feat(gui): apiproxy — four-quadrant RPC contract + fetch carriers, live end to end |
| 3 | 76e838bcd | feat(gui): RpcLog debug panel — fixture-driven milestone, playwright-verified 10/10 |
| 4 | 56ce3ace8 | feat(gui): session milestone — list + conversation over Session OOP, styled RpcLog v2.1 |
| 5 | 6cc9809a7 | feat(gui): hostruntime split + repo-wide package prefix rename |
| 6 | 6faad538d | refactor(gui): AbstractApiClient class hierarchy — OO client with inheritable seams |
| 7 | 8c212fca6 | feat(gui): InputBar final form — bug batch, deepseekchat layout, single primary button, running locks input |
| 8 | 57a46d3ab | docs(gui): purge work-log references from code comments |
| 9 | 798e16de1 | fix(gui): session streaming — freeze interrupted partials, sweep stale running calls, send force-scrolls |
| 10 | c52514c76 | feat(gui): dark-mode toggle pinned to the sidebar bottom |
| 11 | 885aa4182 | feat(gui): webserver hardening verify script（原 chore: progress 剥空改名） |
| 12 | 269040567 | docs(gui): file-header comments self-contained — drop RFC filename references |
| 13 | c29169fa5 | docs(gui): work log, RFCs, and product/tech/styling docs（顶刀） |

注：#8/#12 是碰代码注释的 docs(gui) 刀（改的是 packages/ 源文件），不属上浮路径，留在底部符合「底部纯实现代码」口径。
