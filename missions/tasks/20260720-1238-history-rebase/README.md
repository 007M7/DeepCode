# 历史回刷：5baffffee..HEAD 24 → 14 commit

分支 worktree-web2；备份 `backup/pre-rebase-web2-0720`（= 89e783926）。铁律：每 Phase 后 `git diff backup/pre-rebase-web2-0720` 为空——全程满足，最终树与回刷前完全一致。

## 最终序列（旧→新，14 个）

| # | commit | subject | 构成（原 hash） |
|---|---|---|---|
| 1 | 9eb1fbd5d | docs: gui initial | 原样 |
| 2 | 5d8ece639 | feat(gui): step1 skeleton — dsc web serves built web UI over booted harness host | 35c585a70 + 04da89ee5；body 注明含设计/实施归档 |
| 3 | 139a31fbf | feat(gui): apiproxy — four-quadrant RPC contract + fetch carriers, live end to end | 0206e121b + e6be080d5 + 962b1e684（后两个上移越过 3fe，文件不相交） |
| 4 | 9fafe90fb | feat(gui): RpcLog debug panel — fixture-driven milestone, playwright-verified 10/10 | 3fec46a00 原样 |
| 5 | ff5d3c221 | feat(gui): session milestone — list + conversation over Session OOP, styled RpcLog v2.1 | 9a710da7e 原样（partial 修复并入失败，见 fallback） |
| 6 | df2626f4c | docs(gui): design archives — session milestone, style research, web cordis, hostruntime split | 4c65a9dce 原样 |
| 7 | 8845c5ec3 | feat(gui): hostruntime split + repo-wide package prefix rename | 3a8b25f7a 原样 |
| 8 | e4336309c | refactor(gui): AbstractApiClient class hierarchy — OO client with inheritable seams | 068da6047 原样 |
| 9 | 9d9b934aa | feat(gui): InputBar final form — bug batch, deepseekchat layout, single primary button, running locks input | 35428c344 + d03203717 + a68af13b1 + 4a272ac34 + 697140447 + 3dd48163a；body 注明同批含 comment sweep |
| 10 | 3c970c68f | docs(gui): purge work-log references from code comments | 96b8ff8ea + 82ee64595（82e 上移越过 InputBar 组）；body 合并两刀内容（69+7=76 处），删掉 squash 后过时的「remaining references in-flight」句 |
| 11 | b3a2e40e9 | fix(gui): session streaming — freeze interrupted partials, sweep stale running calls, send force-scrolls | a8aa0703b + b41b653ef（**fallback 独立成刀**，见下） |
| 12 | 58c5f82d9 | feat(gui): dark-mode toggle pinned to the sidebar bottom | a0370f793 原样 |
| 13 | 3b6bfb634 | chore: progress | bec3fc0f1 原样 |
| 14 | 7d5b27b72 | docs: rfc | 89e783926 原样（RFC 独立成刀） |

## 各 Phase 回执

- **Phase 1**：组 2（35c+04d）、组 3（020+e6b+962）、组 10（96b+82e）三处 squash，一次 rebase 零冲突。24 → 20。
- **Phase 2**：InputBar 六连 squash（fixup 链 + `--amend -F` 定制 message）。冲突 5 轮，全部迭代覆盖型。20 → 15。
- **Phase 3**：**走 fallback**。先试 a8a+b41 fixup 进 9a7：a8a 干净并入，b41 重放 4 文件 8 hunk 冲突——其代码写在 d03 的 sendDraft/PromptError 与 3a8 的注释英化之上，把它拉回 9a7 时代需要手工反构中间态（英文注释拉回中文时代、PromptError 类型未生），且后续 rename/AbstractApiClient/InputBar 重放必然继续级联。判定超过约定阈值，`git rebase --abort`，改走 fallback：a8a+b41 原位 squash 成独立 commit `fix(gui): session streaming — …`。零冲突。15 → 14。
  - 位置说明：落在引用清扫之后（第 11 位）而非派单的 9.5 位——原历史中 a8a/b41 本就在 82e 之后，此位零冲突且树不变。
- **Phase 4**：`exec git commit --amend --no-verify -F` 润色三处 message（step1 补归档句、apiproxy 换建议 subject 并合并三刀 body、purge 合并两刀 body 并删过时句）。已验证 purge commit 树上 `git grep missions/tasks -- packages apps scripts` 为空，与新 body 的「clean across the GUI packages」相符。

## 冲突点及解法

全部冲突都是「同一文件的迭代覆盖」型，解法统一为**取该组内最后一个 commit 的文件终态**（`git checkout <组末原 hash> -- <file>` 或 `--ours`/`--theirs`），每轮以铁律兜底验证：

| 文件 | 冲突场景 | 解法 |
|---|---|---|
| scripts/verify-session.mjs | 注释头一行在 96b（purge）与 a68/354 两侧各改一版 | 取组末终态；purge 重放时取 HEAD 侧（backup 终态首行为准） |
| missions/tasks/20260720-0246-inputbar-fix/README.md | 迭代表格逐 commit 追加行，squash 后重放两侧行集不同 | 取含更多行的一侧（组末终态） |

## 其他事项

- 工作区在 Phase 2 前发现一处**他人在途编辑**（docs/rfc/implemented/architecture/2026-07-19-gui-host-client-layering.zh.md 的 Problem 节增补），先 stash 保护，终验（diff-vs-backup 为空）通过后 `git stash pop` 原样恢复，未 commit。恢复出的增补为 5 行（比最初快照的 1 行多——stash 时编辑仍在进行，stash 捕获的即当时最新盘上版本，pop 干净无冲突）。
- 全程未 push、未碰 origin。
- 注：本 README 曾在 2026-07-20 12:58 前后被盘上误删（目录清空），由 owner 凭上下文全文重建；如与他处备份不一致以时间较新者为准。
