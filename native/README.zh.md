# native/

[English](README.md) | 中文

`node-addon-landlock-run` 的权威源码位于此处：这是 harness 从 npm 引入并使用的 Landlock「先限制自身、再执行」启动器（`packages/sandbox/sandbox-local`、`packages/bash/bash-sandbox`）。启动器在此处开发，与消费方相邻；独立仓库是打包并发布 npm 包（package）系列的发布镜像。

## 发布镜像

| 目录 | 镜像仓库 | 上次导出的发布版 | Commit |
|---|---|---|---|
| `landlock-run/` | https://github.com/deepseek-harness/node-addon-landlock-run | `v0.0.1` | `614f7fd7dc11e6eaceefba9e7ff1fbe28b51ba22` |

该子树是一个自包含的 pnpm workspace，拥有自己的 `AGENTS.md`、文档、门禁和锁文件；它不属于 harness workspace（`pnpm-workspace.yaml` 不包含它），因此 harness 的安装、构建和 CI 门禁绝不会触及它。镜像的 `.github/` 不进入该子树；[.github/workflows/landlock-run.yml](../.github/workflows/landlock-run.yml)（手动触发）在此处运行子树的 CI 任务，对这些任务的更改会在下次导出时镜像到镜像仓库的 `ci.yml`。

## 导出流程（发布新版本）

1. 先通过常规 harness PR 将启动器更改落地于此；触发 `Landlock Run` 工作流，并确保其所有任务通过。
2. 在镜像 checkout 中替换 `.github/` 以外的所有内容：`git -C <mirror> rm -rq -- . ':!.github'`，然后执行 `git -C <harness> archive HEAD:native/landlock-run | tar -x -C <mirror>`，最后执行 `git -C <mirror> add -A` 并提交。
3. 在镜像中按照其发布清单（`docs/release.md`）操作：`pnpm release:commit <version>` → 合并 → 标记 `vX.Y.Z` → 两阶段 `Release` 工作流（先以 `publish=false` 预演，再从标签以 `publish=true` 发布）。
4. 使用已发布的标签／commit 更新上方 manifest（元数据清单）表，并在同一更改中上调 harness 消费方的依赖版本范围。

发布镜像不得与此处的权威源码产生分歧：如果更改直接提交到镜像中（例如发布期间的热修复），必须在下次导出前将其移植回此处。
