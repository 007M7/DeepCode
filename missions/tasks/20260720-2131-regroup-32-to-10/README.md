# 大重排 32→10（20260720-2131，第五次手术）

owner：history-rebase。范围 ab604c271..7be03e985（32 刀）→ 10 刀，用户已批映射表。

## 终序（下→上，新 hash）

| # | hash | 组成 |
|---|---|---|
| 1 | 28af3861a | 组① client 修复 6→1（d28181440/620099bc5/91e2d2914/320aa4602/d05869f52/84d110f03，按原相对序 pick） |
| 2 | 24d92bde9 | 组② host 修复 2→1（b465e51c4/0a058ecad） |
| 3 | 882c73c70 | 组③ session 功能 6→1（f60be3b53/d167e70e3/a20678aeb/c068acab0/4d7d8e321/c057b1730） |
| 4 | f69f90ee7 | 组④ 改名 2→1（de1a1f05e 并入 49d5ce304，body 注明 references 修复） |
| 5 | 809d4c173 | 组⑤ vitest 三层 7→1（c42d9e72f…2b15d6c71；树 = 2b15d6c71 原树 read-tree 落定） |
| 6 | 0563f163b | 组⑥ jsdom 2→1（f7014e1e6/fbd698a8b） |
| 7 | 99eb3738f | 测试 RFC（509db0cb3 原样 pick） |
| 8 | 6c3da7dae | tool 卡 4→1（d5c958e63/568977be8/e05653d8a/1f1716768） |
| 9 | 12e491db4 | ac22a98fe 原样（用户裁决不拆不改 message） |
| 10 | 08a4dea7b | missions 顶刀（7be03e985 原样） |

## 验证

- 铁律：`git diff 7be03e985 HEAD` 零输出；每组落定即对原历史同位树 hash 核等（组⑤⑥/RFC/tool 卡/ac22a98fe/顶刀全部 tree-hash 相等）。
- backup/pre-regroup @ 7be03e985 留底。
- 冲突 2 处，均按组内终态解决：组② client-handler.spec modify/delete（该文件终态由后续测试组引入）；组④ package.json test:web/test:gui 行 + smoke 测试 DU（改名刀与先行 pick 的测试文件重叠，组⑤ read-tree 终态兜底）。

## ⚠️ 发现：主线 test:gui 3 例红（先于本手术存在）

host-runtime.spec.ts 3 败（rpcId rides / cold resume / paginates）。根因：ac22a98fe（pr-gates 12 刀 squash）带入的 host-runtime 组合套件写于 dscweb 分支——那边 api-proxy 无 tool 卡 HistoryEntry 改型，spec 按旧线型 `events: SessionEvent[]` 断言；主线 tool 卡刀已把 sessions.history 改为 `events: HistoryEntry[]`（`{event, view?}` 包壳），三处 `event.type` 直读全部落空。树同败同（backup 同树必同败），非手术引入。修法（3 断言解包 `.event`）待 team-lead 裁决归刀。

## 收官补刀（team-lead 裁决）

3 例红修刀 **fixup 进 12e491db4**（它引入的 spec，归它符合「review 修复上引入 PR」家规）：host-runtime.spec 三处断言解包 HistoryEntry（`entry.event.type` / `entry.event.seq`），missions 顶刀重放。终序 hash 更新：…→ 6c3da7dae tool 卡 → **239857d8a** lint+spec 调和 → **e1226eebf** missions 顶。终验：test:gui 229/229 全绿；对旧终态 diff 仅 host-runtime.spec.ts 一文件 10+/9-（三处解包）。手术收官。
