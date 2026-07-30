# Agent Note: Web 浏览器预期输出的必需 CI 门禁

Status: implemented

[English](2026-07-30-web-browser-snapshot-ci-gate.md) | 中文

## 问题

[无密钥 Web 浏览器 e2e 车道](2026-07-24-web-gui-browser-e2e-lane.md)只由本地 `pnpm run test:web` 运行，PR CI 不比较 `apps/web/tests/snapshots/**/*.expected.md`。因此，改变用户可见 Web 输出的 PR 可以在漏刷预期输出时保持绿色；后来任意分支显式运行 `DSH_SNAPSHOT=refresh`，都会替前序变更补账并产生与本分支无关的 diff。普通本地运行已经默认使用只读 replay，缺口是 PR 级的强制执行，而不是禁止 refresh 写入。

## 决策

Linux PR 的 `node 24 / snapshots and artifacts` 必须运行完整 Web 浏览器 replay/compare。`scripts/run-gates.ts` 把 `test:web:built` 作为 `ci-consumers` 的一个 gate，并显式注入 `DSH_SNAPSHOT=replay`；CI 永不以 `record` 或 `refresh` 模式运行，因此提交的 golden 与当前组装应用不一致时测试直接失败，不会在 runner 内静默改写后通过。

静态 CI job 已经构建全部发布产物；它把 `apps/web/dist` 连同 package `lib/` 放进 built-tree artifact，consumer job 复用该 artifact 而不重复全仓构建。consumer job 按 lockfile 中的 Playwright 版本安装 Chromium 及系统依赖，并以操作系统和 `pnpm-lock.yaml` 哈希缓存浏览器。默认分支的 Linux 串行 job 运行同一 compare 命令并产出默认分支缓存，后续 PR 可直接恢复。

本地 `pnpm run test:web` 仍先构建再运行浏览器全集；`test:web:built` 是已有构建产物的执行入口。开发者只在确认用户可见输出有意变化后显式运行 `DSH_SNAPSHOT=refresh pnpm run test:web`，评审每一处 expected diff，再以 replay 模式复验不再写文件。

门禁保持 Linux-only：这些场景面向 POSIX，Windows 与 macOS 的串行参考 job 不重复运行。PR 的 `all checks passed` 已依赖 consumer job，因此浏览器 compare 失败会阻止合并，无需新增 branch-protection check 名称。

## 曾考虑的替代方案

**继续只要求本地运行。** 已否决：执行依赖开发者记忆，正是旧 golden 跨 PR 漂移的原因，不能保证产生行为变化的 PR 自己携带 expected diff。

**让 CI 以 `refresh` 模式运行后检查工作树。** 已否决：写后比较把断言机制变成生成器，若工作树检查接线失效就会把回归更新成绿色；replay 直接比较已有 golden，失败面更小。

**新建独立 browser job 并重新构建全仓。** 已否决：它会重复依赖安装和发布构建。现有 Linux consumer job 已消费同一 built-tree artifact，并已被统一的 required verdict 聚合。

**用 jsdom 快照代替真实 Chromium。** 已否决：jsdom 不覆盖浏览器、HTTP/SSE 承载及真实 client plugin bundle 组合；它保留为快速的下层反馈，不能替代 assembled browser chain。

## 后果

每个 PR 都在合并前证明当前 Web 组装与所有已提交的浏览器 expected 一致，漏刷从“后续 PR 的无关变化”变成引入 PR 自己的失败。成本是 Linux CI 增加 Chromium 供给和一轮串行浏览器场景；built artifact 复用与默认分支浏览器缓存避免重复构建和常态下载。门禁仍不声称跨平台浏览器一致性，Playwright/Chromium 升级若改变 aria 格式，升级 PR 必须显式 refresh 并评审 churn。
