# Agent Note: 经由 pnpm/action-setup 提供 CI 的 pnpm

Status: implemented

[English](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md) | 中文

## 问题

每个工作流都曾用 `corepack enable` 手工提供 pnpm，其中五个还各自重复着一套手写（hand-rolled）的缓存设置——`pnpm store path --silent >> $GITHUB_OUTPUT`、再加以 `pnpm-lock.yaml` 为缓存键的 `actions/cache@v4`：`e2e.yml`、`docs-pages.yml`、`pi-ai-provider-e2e.yml`、`build-exe-for-python-sdk.yml`，以及 `ci.yml` 的 node-compat、serial-linux 与 benchmark 作业（约 40–60 行各自漂移的 YAML 副本）。与之等价、由官方维护的做法——`pnpm/action-setup@v4`（从 package.json 读取 `packageManager`）加带 `cache: pnpm` 的 `actions/setup-node`——当时已在仓库内的 `landlock-run.yml` 中得到验证，而 corepack 被从较新 Node 发行版中移除，使每一处 `corepack enable` 都成了已知的未来失效点。

## 决策

`pnpm/action-setup@v4` 是 CI 中提供 pnpm 的唯一机制：没有任何工作流运行 `corepack enable`。缓存仍是叠加其上的按作业政策，保持三种刻意的形态：

- **对称缓存**（既恢复也保存）：带 `cache: pnpm` 的 `actions/setup-node`——`e2e.yml`、`docs-pages.yml`、`pi-ai-provider-e2e.yml`、`build-exe-for-python-sdk.yml`，以及 `ci.yml` 的 node-compat 与两个 benchmark 作业。larger-runner benchmark 通过条件化的 `cache:` 输入让 store 缓存仅限 Linux；consolidated benchmark 在两个平台上都启用缓存。
- **只恢复不上传／生产者配对**（手写的 `actions/cache` 步骤，保持不变）：企业 runner 上的三个 PR（Pull Request）作业只恢复不保存，把缓存压缩/上传挡在付费且延迟敏感的关键路径之外——这种不对称是 `setup-node` 的缓存无法表达的；master 推送触发的 serial-linux 作业保留其 `pnpm store path` + `actions/cache@v4` 写入侧，因为它负责填充那些只恢复不上传（restore-only）作业所消费的精确缓存键与路径；把生产者改成 `setup-node` 的键格式，会悄然断供它们的恢复。
- **无缓存**（完全不设 store 缓存）：必需的 Windows 作业与 serial-windows（在那里解压海量小文件的 store 缓存比干净安装更慢）、serial-macos、sandbox.yml，以及本就经共享企业键恢复的 coverage/consumers 企业作业。

## 曾考虑的替代方案

- **保留手写步骤。** 它们能用，但那是会各自漂移的设置样板副本，而且对 corepack 的依赖是已知的未来失效点。
- **把企业作业的缓存也转换成 `cache: pnpm`。** 否决：只恢复不上传的不对称是 `ci.yml` 注释中有记录的延迟决策；为统一工具而抹掉它，属于颠倒优先级。
- **转换 serial-linux 的 store 缓存。** 实现期间否决：原提案曾把 serial-linux 计入对称设置，但其缓存步骤是企业作业只恢复不上传配对中的生产者一半——把它改成 `setup-node` 的键格式，等于换条路径做了企业作业的转换。
- **只转换带缓存的工作流，留下其余 `corepack enable` 站点。** 评审跟进时否决：提供 pnpm 与缓存是可分离的关注点，在无缓存作业里留下 corepack 只会保留未来失效点和两套并存的提供方式，毫无收益。
- **用一个组合 action 包装 action-setup + setup-node。** 暂不采纳：剩余的按作业差异（node 版本矩阵、按平台的条件缓存、只恢复不上传配对）是刻意的政策而非样板——包装层要么长出镜像这些差异的输入，要么抹平一处真实的不对称，而两行的组合已接近下限。

## 后果

- corepack 依赖已从 CI 中彻底消失；pnpm 在所有工作流中都经由 pnpm 团队的官方 action 提供，版本锁定继续单一来源于 `package.json` 的 `packageManager` 字段。
- 已转换泳道的缓存键格式变更了一次；各跑一次冷运行重建缓存后，命中率与旧步骤持平。内建缓存键涵盖平台、架构与锁文件哈希，但不含 Node 版本，因此 node-compat 矩阵的各条腿共享同一条 store 缓存记录——这是安全的，因为 pnpm store 与 Node 版本无关。
- `setup-node` 内建的 pnpm 缓存只按精确键恢复，没有 `restore-keys` 前缀回退：`pnpm-lock.yaml` 一旦变更，已转换泳道会从冷 store 起步，而不是从上一条缓存记录播种。
- 净删除约 75 行工作流 YAML。企业 runner 上的 PR 作业与 Windows 作业的缓存行为未变（只有提供 pnpm 的那一行改用了 action），serial-linux 继续生产只恢复不上传作业所消费的缓存键。
