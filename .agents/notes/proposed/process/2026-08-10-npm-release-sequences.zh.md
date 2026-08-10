# Agent Note: 三条独立序列的私有 NPM 发布

Status: proposed

[English](2026-08-10-npm-release-sequences.md) | 中文

## 问题

这个仓库有三组互不相干的可发布包，但没有任何发布通道把它们送上 registry。

`packages/*/*` 与 `apps/*` 组成 `@deepseek-ai/dsh` 的运行时闭包；`vendor/*` 是九个 rescope 过的 Cordis 框架包，各自带着上游的版本号；`native/landlock-run/packages/*` 是 Linux 平台包，已有自己的 `landlock-run-release.yml`。三组的版本基线、变更节奏和构建要求都不同：dsh 随产品迭代，vendor 只在同步上游或改动本地修改时才动，native 需要 musl 工具链和逐架构构建。把它们塞进一条发布流水线，等于每次产品发版都要重发框架和原生二进制。

当前状态还有两处硬门。全部 217 个 workspace manifest 都是 `private: true`，直接 `npm publish` 发不出去。更隐蔽的是 933 条 dsh 兄弟包之间硬写的 `peerDependencies: "^0.0.1"`：`pnpm pack` 只替换 `workspace:` 协议，不动语义范围，而 `^0.0.1` 等于 `>=0.0.1 <0.0.2`——发 `0.0.2` 落不进去，发 `0.0.1-rc.1` 也落不进去（semver 规定不带预发布段的范围排除预发布版本）。这 933 条至今没出事，只因为版本一直停在 `0.0.1`。

本仓已有的 `scripts/publish-npm-baseline.ts` 是本机发布脚本：它把 pack 与 publish 放进同一个进程，需要人工在本机完成认证与重试，且把 vendor 排除在发布集之外。它不能作为 CI 发布的基础，但其中的 tarball payload 校验与已安装产物探针是验证过的零件。

## 提案

### 三条独立序列

`packages/`、`vendor/`、`native/` 各自一条 bump 序列、各自一次发布，不共享版本号、不共享触发、不互相等待。发 dsh 不重发 vendor，发 vendor 不重发 native。

| 序列 | 成员 | 版本基线 | tag | workflow |
|---|---|---|---|---|
| dsh | `packages/*/*` + `apps/*`（`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-frontend`） | 全族一个 `0.0.x` | `dsh-v<版本>` | `release.yml`（新增） |
| vendored framework | `vendor/*` 九个包 | 每包各自的上游版本线 | `vendor-<包名>-v<版本>`（每包一个） | `release-vendor.yml`（新增） |
| native | `native/landlock-run/packages/*` | 自己的 `0.0.x` | `landlock-run-v<版本>` | `landlock-run-release.yml`（现状不动） |

三组一律发到 npmjs.com 的 `@deepseek-ai` scope 下的**私有包**（`npm publish --access restricted`）。native 三个包现在写的是 `access: public`，要改成 `restricted`。

### 版本由本地命令写进仓库，CI 只核对与上传

每条序列有一条 `bump and commit` 命令：算出目标版本 → 写进相关 manifest → `pnpm install --lockfile-only` → 立刻自检 → `git add` manifest 与 lockfile → commit。发布版本因此在仓库里查得到，不存在「发出去的是哪个版本说不清楚」。tag 由人工在合入 master 后打，CI 不写仓库、不需要写权限。

dsh 序列全族共用一个版本，接受 `major | minor | patch | x.y.z` 三种入参与显式版本号。先用 `0.0.1-rc.1` 这类预发布号把 pack、仓外安装探针、真实私有发布跑通一遍，验证通过后再发 `0.0.1`、`0.0.2` 这样的数字版本。dist-tag 沿用本仓 `landlock-run-release.yml` 已有的判定：版本带预发布段就 `--tag next`，否则进 `latest`。

### vendor：谁改了谁发版，tag 就是账本

vendor 九包加了 scope 之后与上游脱钩，但保留各自的版本线。发布版本 = 去掉预发布段后 patch+1，首发目标：

| 包 | 上游版本 | 首发版本 |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.0-rc.7 | 4.0.1 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.0-rc.5 | 1.0.1 |
| `@deepseek-ai/cosmokit` | 1.8.1 | 1.8.2 |
| `@deepseek-ai/schemastery` | 3.18.0 | 3.18.1 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | 1.0.16 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.4 | 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | 1.1.3 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.0 | 1.0.1 |
| `@deepseek-ai/cordis-plugin-logger-console` | 1.0.0 | 1.0.1 |

只发改动过的包。变更判据不引入新的状态文件：**每包一个 tag，tag 就是「上次发布到哪个 commit」的记录**。bump 对每个包取最新的 `vendor-<包名>-v*` tag，`git diff <该 tag>..HEAD -- vendor/<目录>` 有差异就 patch+1，没差异就跳过；查不到 tag 就按上表首发。差异只看会进 tarball 的路径（复用 `scripts/publication-payload.ts` 的 `files` 规则），改动 vendor 内的注释不触发发版。

tag 只是 commit 指针，不是「已发布」的证明——打了 tag 而 publish 失败的情况必须能识别。所以 bump 还要向 registry 核对「tag 所指版本确实存在」，不一致时明确失败交人处理，不让脚本猜。私有包查询需要鉴权，本机未登录时跳过这条核对，CI 里强制执行。

vendor 九包**内部**的依赖范围不用改：`^1.8.1` 容纳 `1.8.2`、`^1.0.0-rc.5` 容纳 `1.0.1`，patch+1 永远落在范围内。

### publish 只在 GitHub 执行，用 registry 状态决定发什么

发布只从 GitHub Actions 执行，没有本机发布路径。这让「向 registry 核对」成为 CI 里的强制步骤，不需要为本机未鉴权的情况留旁路。

publish 不读 tag、不读任何清单，对发布集里每个包比较 manifest 版本与 registry 上的已发布状态，按三态处置：

| 状态 | 处置 |
|---|---|
| registry 上没有该版本 | 发布 |
| 已有该版本，且 tarball 的 sha512 与 registry 记录的 `dist.integrity` 相同 | 跳过，属于同一批产物的重跑 |
| 已有该版本，但 integrity 不同 | 失败退出，报「内容已变但版本未 bump」 |

第三态是这条规则的目的：它拦住「改了代码却没 bump 版本」。前两态给出的是幂等——同一个 artifact 重跑 publish 不会重复发布，也不需要人工挑拣包。

这条规则同时解决了一次发布事件产生多个 vendor tag、而 workflow 只能从一个 ref 触发的矛盾：workflow 不需要从 tag 推断本次该发哪些包。dsh 序列同构处理，它只有一个版本，差集要么全发要么全跳。

第三态依赖同输入构建可复现（同一 commit 两次 pack 得到相同字节）。这一点必须实测确认，不能假定：`pnpm run build` 的产物若嵌入绝对路径或时间，integrity 就会在内容未变时漂移，第三态会误报。落地前先在 CI 上对同一 commit 连跑两次 pack 比对 integrity；若不可复现，则把比较下沉到 tarball 内的逐文件内容哈希，并明确排除导致漂移的字段。


### 一次性把 workspace 内部引用改成 `workspace:^`

仓库里所有指向 workspace 成员的引用统一成 `workspace:^`，由 `pnpm pack` 在发布时替换成匹配目标版本的范围。

| 面 | 数量 | 效果 |
|---|---|---|
| dsh 兄弟包 `peerDependencies` | 933 | 发 `0.0.2` 或 `0.0.1-rc.1` 都自动得到匹配的范围 |
| 指向 vendor 的 dep / peer / devDep | 105 + 221 + 218 | vendor patch+1 后不需要改写 dsh 侧引用，范围也不会随 vendor 递增而过期 |

`scripts/check-workspace-constraints.ts` 现在断言 vendor peer 与 dev 的范围相等，改后两边都是 `workspace:^`，断言仍成立但语义要随之更新。

这条是「发布期不做任何依赖改写」的前提：发布期只做一件事——pack 出字节。

### 发布族对象

领域里的实体是**发布族**：一组共享版本基线与 tag 前缀、可整体发布的包。新增一族等于新增一份族描述加一条 workflow lane，不改核心。

| 对象 | 职责 |
|---|---|
| `ReleaseFamily` | 一族的身份：成员发现规则、版本策略、tag 命名、publish 目标。新增发布族在此落地 |
| `ReleaseMember` | 一个可发布包：目录、manifest、族归属、发布顺序位次 |
| `VersionPolicy` | 版本从哪来。`SharedSemver`（dsh：全族一个版本）与 `PerPackageChanged`（vendor：按 tag 判变更、去预发布段后 patch+1） |
| `ReleaseSet` | 一族成员的拓扑序，按 `dependencies` 排、同层按包名排，保证确定性 |
| `PackedBundle` | tarball 集合 + `publish-order.txt` + 元数据清单，是 pack 与 publish 之间唯一的交接物 |
| `PublishTarget` | registry、access、dist-tag、凭据来源。dist-tag 由版本形态派生 |
| `VersionInvariant` | 族内版本自洽；publish 必须从对应 tag 跑；tag 版本等于包版本；待发版本不得已存在于 registry |
| `PayloadInvariant` | tarball 内容校验，复用 `scripts/publication-payload.ts` |
| `InstalledProbe` | 仓外临时 consumer 从 tarball 安装后，用普通 Node 驱动已安装入口：`dsh --version`、`dsh --dump-default-config`、起一次 TUI 到就绪后退出。实现从 `scripts/publish-npm-baseline.ts` 搬运复用 |

### workflow 形状：一次性 pack 全部，再统一 publish

照参照流程（node-addon-require-builtin 的 `release.yml` 与 `scripts/pack-release.mjs`）的形状：`pack` job 一趟遍历整个发布集，逐包 `pnpm --dir <目录> pack --pack-destination <同一个目录>`，写出 `publish-order.txt`，整个目录作为**一份** artifact 上传；`publish` job 下载那一份 artifact，按 `publish-order.txt` 逐个 `npm publish`。发布集是一个整体，不存在「一半的包发出去了、另一半还在构建」。

`pack` job 无凭据：install → verify → build → pack → 打包后安装验证 → upload-artifact。`publish` job 挂 `environment: npm-publish` 人工审批，只 `setup-node` 加 `download-artifact`，**不 checkout、不 build**，上传的就是 pack 出来的同一份字节。checkout 用 `fetch-depth: 0`，vendor 的变更判据需要历史与 tag。

`environment` 是整条流程唯一的刹车：pack 无凭据、可随意排练；只有 publish 会停在审批上。GitHub 侧需要 `NPM_TOKEN` secret（对该 scope 有发布权限的 automation token）与 `npm-publish` environment（required reviewers，允许的 tag 限制为 `dsh-v*`、`vendor-*`、`landlock-run-v*`）。

### PR 阶段跑到 pack 为止

参照流程只有 `workflow_dispatch`，PR 上什么都验证不了。本仓在 `pull_request` 上跑完整的 pack：install → verify → build → 逐包 pack → 上传 tarball artifact。它证明的是「这个发布集现在能完整打出来」，无凭据、不碰任何 registry，fork 发来的 PR 也能跑。产物本身的正确性由既有测试覆盖，不在 PR 这一层重复。

发布路径的测试走 master：`push: master` 跑同一套 pack 排练作为合入后回归，`workflow_dispatch` 带 `publish: true` 从 tag 走真实发布。



### 仓库改造项

| 项 | 内容 |
|---|---|
| 发布集 manifest | 去掉 `private: true`，补 `publishConfig.access: restricted` 与 `repository`（`git+https://github.com/deepseek-ai/deepseek-harness.git` + 各自 `directory`） |
| 发布集边界 | `packages/*/*` + `apps/*` + `vendor/*` 全部成员，不另挑子集 |
| 依赖协议 | workspace 内部引用统一 `workspace:^`，并更新 `check-workspace-constraints.ts` |
| 根 `AGENTS.md` | 现在写着 vendored 包是 rescope 过且 `private: true`，vendor 要发布，这条约定要改 |
| `vendor/README.md` | manifest 表补记上游版本，与我们发布的版本区分开 |
| native 三包 | `publishConfig.access` 从 `public` 改 `restricted`；它们尚未发布过，所以没有匿名安装路径要保 |

### 与既有提案的关系

本 Note 取代 [以产物为先的 NPM 基线发布](2026-08-04-artifact-first-npm-baseline-publication.md) 中的版本方案与发布集边界两部分：那篇的 `<base>-<时间戳>-<短 SHA>` 预发布版本与 `dev-<base>` dist-tag 不再采用，vendor 也不再排除在发布集之外。两篇一致的部分保留：pack 与 publish 分离、publish 只消费已验证的 tarball、payload 与安装后探针作为发布门。

## 考虑过的替代方案

**`<base>-<时间戳>-<短 SHA>` 版本号。** 曾计划用它做持续 dev 发布。它与「版本必须落进代码库」冲突：版本内嵌 commit SHA，而把版本写回 manifest 会产生新的 commit，SHA 只能指向被发布的父 commit，链条要靠约定解释。改用数字版本递增后，`0.0.1-rc.1` 这类预发布号已经足够覆盖「先验证再正式发」的需求。

**用 `vendor/published.json` 账本记录每包的已发版本与 commit。** 这是 tag 方案之前的设计，需要新增一份状态文件并保证它与 registry 不漂移。per-package tag 提供同样的 commit 指针，且 tag 本来就要打，不引入第二处状态。

**事件级 tag（`vendor-r1`、`vendor-r2`）。** 为「一次发布事件多个包版本」准备的。改用 registry 差集决定发布集之后，workflow 不再需要从 tag 推断本次发布哪些包，per-package tag 就够用，而且每个 tag 携带的是它自己那个包的真实版本。

**vendor 九包统一到 `4.0.x` 一条线。** 省掉变更检测，但 cosmokit 会从 `1.8.1` 跳到 `4.0.1`，上游血缘全部丢失；且九包内部的上游依赖范围（`^1.8.1` 之类）会立刻失配，必须改写 vendored manifest。

**vendor 每次全部 patch+1，不做变更检测。** 最省事，代价是没有改动的包也拿到新版本号、内容与上一版逐字节相同。tag 方案让变更检测的成本降到「取一个 tag 加一次 diff」，不值得为省这点而让版本号虚涨。

**只按版本号判断是否已发布，不比对内容。** 参照流程根本不查 registry，publish 直接逐个上传，重复版本由 npm 报错拦下。只按版本号跳过则会漏掉「改了代码没 bump」这一类，而这是唯一会安静地把旧字节留在 registry 上的错误。代价是引入对 registry 的查询与对构建可复现性的依赖。

**只做打包后安装验证，不起本地 registry。** 参照流程就是这样：解包 tarball 组树、普通 Node 驱动。它绕过版本范围解析，理论上验证不了「200 多个互相依赖的包能不能从 registry 装起来」。曾提议在 CI 里起本地 registry 补这一层，被否：产物验证已由既有测试覆盖，发布路径的验证放在 master workflow 的排练里，PR 只需证明发布集能完整打出来。

**以 `scripts/publish-npm-baseline.ts` 为基础扩展。** 它是本机发布脚本，把 pack 与 publish 放在同一进程，与「无凭据 pack、受保护 publish」的分离相反。它验证过的零件（payload 校验、已安装产物探针）搬运复用，避免 `pnpm run duplication` 判重复。

**按入口闭包挑一部分包发。** 从 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-frontend` 沿 `dependencies` 爬得到 156 个包，比全量少 61 个。但本仓的插件是 cordis.yml 按名字挂载的，不是被 import 的：`vendor/cordis-plugin-group` 与 `vendor/cordis-plugin-logger-console` 就落在依赖闭包之外，而它们是运行时必需。照代码依赖挑，漏掉的表现是消费方装完起不来，且要额外证明「没漏任何挂载项」。发布集因此取 `packages/*/*` + `apps/*` + `vendor/*` 全部；私有 scope 下多几个包不对外可见。`python/`、根 `examples/`、`docs/` 与 `website/` 不是发布集成员。

**一个 workflow 用 `family` 输入选择序列。** 两套版本模型塞进一个文件会让 concurrency group、tag 前缀、排练触发条件全部分叉成条件表达式。一族一个文件更短也更好读。

**在发布期改写依赖范围。** 与一次性改成 `workspace:^` 相比，改写逻辑只在 CI 执行过，本机 `pnpm install` 看不见它是否正确，且每次发布都要重跑一遍。

**CI 里执行 bump 并把版本推回仓库。** 需要给 workflow 仓库写权限，且发布分支上的版本提交会与人的提交竞争。参照流程把 bump 与 commit 留在本地命令，CI 只核对与上传。

## 验收标准

1. 三条序列各自可独立发布：发 dsh 不改动 vendor 与 native 的任何 manifest，反之亦然。
2. `pnpm release:dsh <版本>` 一条命令完成 bump 与 commit，产出的 commit 含全族 manifest 与 lockfile，且立刻自检通过。
3. `pnpm release:vendor` 只对「自其 `vendor-<包名>-v*` tag 以来 tarball 内容有变化」的包 patch+1，无变化的包 manifest 不被改动。
4. `pull_request` 上跑完整 pack 并产出 tarball artifact，无凭据、不访问真实 registry，fork 的 PR 也能跑。
5. `push: master` 跑同一套 pack 排练；真实发布只能由 `workflow_dispatch` 带 `publish: true` 从对应 tag 触发。
6. publish 重跑同一 artifact 不重复发布已存在的版本；当某个版本已存在而 tarball integrity 不同时，publish 失败并指明是哪个包。
7. 仓外临时 consumer 安装 `@deepseek-ai/dsh@0.0.1-rc.1` 后，用普通 Node 能跑通 `--version`、`--dump-default-config` 与一次 TUI 启动。
8. 所有 workspace 内部引用为 `workspace:^`，且 pack 出的 tarball 里没有任何 `workspace:` 残留、没有指向不存在版本的范围。
9. 发布集内没有 `private: true`，每个成员都有 `publishConfig.access: restricted`。

## 风险

**tag 与 registry 漂移。** 打了 tag 但 publish 失败，会让下一次 bump 误判该包已发布。缓解手段是 bump 向 registry 核对 tag 所指版本，不一致就失败退出；但本机未登录私有 registry 时这条核对被跳过，此时误判只能由 CI 的同一条核对拦下。

**变更判据依赖 tag 可见。** shallow clone 或未拉取 tag 会让 vendor 的判据失效并退化成「全部首发」。`fetch-depth: 0` 是这条判据的前提，不是优化。

**`workspace:^` 改动面大。** 一次触及 1477 处依赖声明。它不改变本机解析行为（pnpm 本来就从 workspace 解析），但会改变发布出去的范围写法，且要同步更新 workspace 约束门。

**私有包的可见性代价。** `--access restricted` 之后，任何消费方（含 CI、沙箱 e2e、外部使用者）都必须持有 scope 凭据才能安装。native 三包一并转 `restricted`；它们尚未发布过，因此没有既有的匿名安装路径被切断。

**`repository` 指向的组织与运行 workflow 的组织不一致。** 发布集让消费方指向 `github.com/deepseek-ai/deepseek-harness`，而这些 workflow 并不跑在那里。用 token 发布不受影响；一旦改用 npm provenance（OIDC），npm 会要求二者一致，届时要么把 `repository` 改指过去，要么从它指向的组织发布。

**首发一次性放大。** vendor 首发九包、dsh 首发全闭包，任何 payload 缺陷都会在同一次发布里暴露。用 `0.0.1-rc.1` 先跑一遍完整链路是唯一的缓解手段，正式版本号留给验证通过之后。
