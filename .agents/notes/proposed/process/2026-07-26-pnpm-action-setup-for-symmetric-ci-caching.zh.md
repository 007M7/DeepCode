# Agent Note: 用 pnpm/action-setup 实现对称的 CI pnpm 缓存

Status: proposed

[English](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md) | 中文

## 问题

五个工作流重复着同一套手写（hand-rolled）的三步 pnpm 设置——`corepack enable`、`pnpm store path --silent >> $GITHUB_OUTPUT`、再加以 `pnpm-lock.yaml` 为缓存键的 `actions/cache@v4`：`e2e.yml`、`docs-pages.yml`、`pi-ai-provider-e2e.yml`、`build-exe-for-python-sdk.yml`，以及 `ci.yml` 的 node-compat、serial-linux 与 benchmark 作业（合计约 40–60 行 YAML）。与之等价、由官方维护的做法——`pnpm/action-setup@v4`（从 package.json 读取 `packageManager`）加带 `cache: pnpm` 的 `actions/setup-node`——已在仓库内的 `landlock-run.yml` 中得到验证，同时还能隔绝 corepack 被从较新 Node 发行版中移除的影响。

## 提案

将各对称缓存工作流改为 `pnpm/action-setup@v4` + `setup-node` `cache: pnpm`。以下明确不做转换：

- `ci.yml` 中运行在企业 runner 上的三个 PR（Pull Request）作业——它们刻意只用 `actions/cache/restore`，把缓存压缩/上传挡在付费且延迟敏感的关键路径之外，这种不对称是 `setup-node` 的缓存无法表达的；
- Windows 作业，它刻意跳过 store 缓存。

## 曾考虑的替代方案

- **保留手写步骤。** 它们能用，但那是五份会各自漂移的设置样板副本，而且对 corepack 的依赖是已知的未来失效点。
- **连企业作业在内全部转换。** 否决：只恢复不上传（restore-only）的不对称是 `ci.yml` 注释中有记录的延迟决策；为统一工具而抹掉它，属于颠倒优先级。

## 验收标准

- 五个对称工作流经由上述 action 完成 pnpm 设置；每条泳道各跑一次冷运行以重建新的缓存键格式，此后缓存命中率与旧步骤持平。
- 企业 runner 上的 PR 作业与 Windows 作业保持原样不动。

## 风险

- 缓存键格式变更一次（每条泳道各一次冷运行）。
- 更多工作流引入一个第三方 action；它已在仓库内获得信任（`landlock-run.yml`），且是 pnpm 团队的官方 action。
