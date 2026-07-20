# dsc→dsh 冻结改名（20260720-1709）

owner：history-rebase（冷启动重开，前身归档 20260720-1238-history-rebase / 20260720-1315-docs-float）。
用户已批计划；全员停手源码，本 owner 独占窗口。

## 裁决口径

- **只改当前代码 + docs/（RFC 等活文档）；missions/ 一律不动**（历史归档不刷新；本归档如实记录）。
- 不改：dsh-* 现有包名、.sessions 数据、历史 commit message、missions/。
- localStorage key `dsc.theme` → `dsh.theme`，不做迁移（用户已确认）。

## 改名清单

- A 结构：`git mv apps/dsc apps/cli`；包名 `@deepseek-ai/dsc`→`@deepseek-ai/dsh`；`@deepseek-ai/dsc-web`→`@deepseek-ai/dsh-web`。
- B bin：`"bin": {"dsh": "lib/bin.js"}`；CLI 帮助/报错文案 `dsc web`→`dsh web`、`dsc -p`→`dsh -p`。
- C 机械连带：root package.json demo:web/test:web（filter 名+路径）；apps/cli 内部引用与 description；apps/web/tests spawn 路径与 filter；verify 脚本（session/rpclog-panel/webserver-hardening/carrier-errors/backpressure 等，grep 为准）；各 packages 的 description 与源码注释「dsc」措辞；`dsc.theme`→`dsh.theme`；tsconfig 路径引用；重跑 pnpm install 刷 lockfile。
- D docs/：三篇 RFC .zh.md 与 docs/web-styling.md 的 dsc / apps/dsc 措辞 → dsh / apps/cli。

## 执行步骤

1. `git branch backup/pre-rename HEAD`。
2. grep 全量盘点 dsc 出现点（排除 missions/lib/lockfile/node_modules）。
3. 按清单改，一刀 commit：`refactor: rename dsc CLI to dsh — apps/cli, bin name, package scope`（--no-verify，无 co-auth 尾注）。
4. 验收：typecheck 绿；test:gui 58 用例；test:web 4 用例；demo:echo 冒烟两行断言；全仓 grep 余量≈0 逐条解释。
5. 3080 端口用户常驻旧进程不碰；验证端口自选自清。
6. 回执：commit hash + 验收结果 + 余量清单 + 新常驻命令 `node --import tsx apps/cli/src/bin.ts web`。

## 过程记录

- [x] backup 分支 `backup/pre-rename` @ cb767aa1e
- [x] 盘点：21 文件 49 处（源码后缀，排除 missions/lib/lockfile）
- [x] 改名落盘 + pnpm install 刷 lockfile
- [x] commit：9536f1eae（tsconfig 前置修复）+ 7eaa429f6（改名主刀）
- [x] 验收：typecheck 绿；test:gui 87 用例绿；test:web 4 用例绿（含真机 spawn apps/cli 新路径）；demo:echo 两断言 OK；全仓 grep 余量 0
- [x] 回执

## 计划外偏差（如实记录）

1. **基线 typecheck 本就红**：根 tsconfig.json references 缺 host/apiproxy、host/runtime、host/webserver、client/web-runtime 四项（构型批只验了 build/hygiene），27 个 TS6307。stash 验证与改名无关，独立成刀 9536f1eae 先行修复。
2. **dsh-web 撞名**：计划里的 @deepseek-ai/dsh-web 已被 packages/web/web（web 能力 seam，不改清单内）占用，pnpm 静默链错包导致 test:web 真机挂。前端包改用 **@deepseek-ai/dsh-frontend**，已报 team-lead。
3. **摘除他人在途文件**：web-runtime 四个新 spec（fold-adapter/lineage/notifier/partial，coverage 批 #7 teammate 的）被 `git add -A` 误纳，已从主刀 amend 摘出、盘上保留未提交。
4. 旧 apps/dsc/ 下残留的未跟踪 lib/node_modules 构建产物已 rm（git mv 只挪跟踪文件）。
5. localStorage 旧键 `dsc.theme` 不迁移（用户已确认）：已存主题偏好的浏览器会退回跟随系统一次。

## 事后核对（team-lead 转来 web-test 的三处波及点）

三处全部已覆盖：①smoke-real spawn 路径 + 就绪行正则与 web.ts 打印同步（真机实跑验证过，非纸面）；②support.ts 已改，vitest.web.config.ts 本无 dsc-web 引用；③root test:web --filter 已改。
用例对账：62 基线（web-test 最后刀 cb767aa1e 已在我基线内）+ 盘上未提交 4 spec 的 25 条 = 87，与实跑吻合。

## 映射清单精简版（旧名 → 新名，供 pr-gates rebase/翻译备查）

| 旧 | 新 |
|---|---|
| `apps/dsc/`（目录，git mv） | `apps/cli/` |
| `@deepseek-ai/dsc`（CLI 包名） | `@deepseek-ai/dsh` |
| `@deepseek-ai/dsc-web`（前端包名） | `@deepseek-ai/dsh-frontend` ⚠️ 非计划的 dsh-web（被 packages/web/web 占用） |
| bin `"dsc": "lib/bin.js"` | bin `"dsh": "lib/bin.js"` |
| CLI 文案/用法 `dsc web` / `dsc -p` | `dsh web` / `dsh -p` |
| 就绪行 `dsc web: http://…`（smoke-real 正则依赖） | `dsh web: http://…` |
| `loadEnv('dsc')` | `loadEnv('dsh')` |
| localStorage `dsc.theme` | `dsh.theme`（不迁移旧值） |
| 环境变量 `DSC_WEB_URL`（3 个 verify 脚本） | `DSH_WEB_URL` |
| 注释/描述措辞 `dsc host`、`dsc web UI`、`apps/dsc` | `dsh host`、`dsh web UI`、`apps/cli` |
| root scripts `test:web`/`demo:web` 的 `--filter @deepseek-ai/dsc-web` 与 `apps/dsc/src/bin.ts` | `--filter @deepseek-ai/dsh-frontend` 与 `apps/cli/src/bin.ts` |

不变：dsh-* 既有包名、.sessions 数据、历史 commit message、missions/ 全目录。
改动落点全集见主刀 7eaa429f6（23 文件）+ 前置 9536f1eae（根 tsconfig references）。
