# Agent Note: 用 pnpm/action-setup 实现对称的 CI pnpm 缓存

Status: implemented

[English](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md) | 中文

## 问题

五个工作流曾重复着同一套手写（hand-rolled）的三步 pnpm 设置——`corepack enable`、`pnpm store path --silent >> $GITHUB_OUTPUT`、再加以 `pnpm-lock.yaml` 为缓存键的 `actions/cache@v4`：`e2e.yml`、`docs-pages.yml`、`pi-ai-provider-e2e.yml`、`build-exe-for-python-sdk.yml`，以及 `ci.yml` 的 node-compat、serial-linux 与 benchmark 作业（合计约 40–60 行 YAML）。与之等价、由官方维护的做法——`pnpm/action-setup@v4`（从 package.json 读取 `packageManager`）加带 `cache: pnpm` 的 `actions/setup-node`——当时已在仓库内的 `landlock-run.yml` 中得到验证，同时还能隔绝 corepack 被从较新 Node 发行版中移除的影响。

## 决策

各对称缓存设置现采用 `pnpm/action-setup@v4` 后接带 `cache: pnpm` 的 `actions/setup-node`，即 `landlock-run.yml` 的模式：`e2e.yml`、`docs-pages.yml`、`pi-ai-provider-e2e.yml`、`build-exe-for-python-sdk.yml`，以及 `ci.yml` 的 node-compat 与两个 benchmark 作业。larger-runner benchmark 通过条件化的 `cache:` 输入让 store 缓存仅限 Linux，与必需 Windows 作业刻意跳过缓存的做法保持一致；consolidated benchmark 与之前一样在两个平台上都启用缓存。

以下明确未做转换：

- `ci.yml` 中运行在企业 runner 上的三个 PR（Pull Request）作业——它们刻意只用 `actions/cache/restore`，把缓存压缩/上传挡在付费且延迟敏感的关键路径之外，这种不对称是 `setup-node` 的缓存无法表达的；
- Windows 作业，它刻意跳过 store 缓存；
- `ci.yml` 中 serial-linux 作业的 store 缓存步骤——该作业把 `corepack enable` 换成了 `pnpm/action-setup@v4`，但其 `pnpm store path` + `actions/cache@v4` 步骤仍保持手写，因为 master 推送触发的 serial-linux 运行正是写入侧，负责填充企业只恢复不上传（restore-only）作业所消费的那个精确缓存键与路径；把生产者改成 `setup-node` 自有的键格式，会悄然断供它们的恢复。

## 曾考虑的替代方案

- **保留手写步骤。** 它们能用，但那是五份会各自漂移的设置样板副本，而且对 corepack 的依赖是已知的未来失效点。
- **连企业作业在内全部转换。** 否决：只恢复不上传的不对称是 `ci.yml` 注释中有记录的延迟决策；为统一工具而抹掉它，属于颠倒优先级。
- **连 serial-linux 的 store 缓存也转换。** 实现期间否决：提案曾把 serial-linux 计入对称设置，但其缓存步骤是企业作业只恢复不上传配对中的生产者一半——把它改成 `setup-node` 的键格式，等于换条路径做了企业作业的转换。

## 后果

- 每个已转换的工作流都不再依赖 corepack；pnpm 经由 pnpm 团队的官方 action 提供，该 action 已在仓库内获得信任（`landlock-run.yml`）。
- 缓存键格式变更了一次；每条已转换泳道各跑一次冷运行以重建缓存，此后命中率与旧步骤持平。内建缓存键涵盖平台、架构与锁文件哈希，但不含 Node 版本，因此 node-compat 矩阵的各条腿共享同一条 store 缓存记录——这是安全的，因为 pnpm store 与 Node 版本无关。
- `setup-node` 内建的 pnpm 缓存只按精确键恢复，没有 `restore-keys` 前缀回退：`pnpm-lock.yaml` 一旦变更，已转换泳道会从冷 store 起步，而不是从上一条缓存记录播种。
- 净删除约 75 行工作流 YAML；企业 runner 上的 PR 作业与 Windows 作业逐字节未动，serial-linux 继续生产它们所恢复的缓存键。
