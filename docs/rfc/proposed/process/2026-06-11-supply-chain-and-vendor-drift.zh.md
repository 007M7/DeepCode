# RFC：供应链检查与 vendor 漂移校验

[English](2026-06-11-supply-chain-and-vendor-drift.md) | 中文

Status: proposed

## 问题

vendor manifest（[vendor 化决策](../../implemented/process/2026-06-11-vendor-cordis-as-source.md)）在提交时只做*正向*强制（vendor 代码变更 ⇒ manifest 更新），但没有任何机制校验 manifest 的*声明*：即 vendor/ 确实等于「上游指定 SHA 的代码 + 日志中记录的修改」。此外，少量真正的 npm 依赖也没有安全公告监控或更新节奏。

## 提案

1. **Vendor 漂移检查**（夜间 CI）：以 manifest 中的 SHA 浅克隆上游仓库，复制对应 package 的源码，与 `vendor/*/src` 做 diff。除非 diff 与日志中的本地修改一致（每项修改保存为一个入库的 patch 文件，使日志条目成为可校验的产物而非纯文字），否则 job 失败。
2. **依赖安全公告**：对 lockfile 运行 osv-scanner（或 `pnpm audit`），按计划调度 + 在涉及 lockfile 的 PR 上触发。
3. **许可证清单**：一个脚本断言每个 vendor 化的 package 都携带 LICENSE 文件，且 package.json 的 `license` 字段与 vendor/README.md 中的清单一致（我们混合了 vendor 化的 MIT 与自有的 BSD-3）。作为 CI 步骤运行。
4. **Renovate**（或一个定时 agent 任务）以小 PR 提议 npm 依赖更新，这些 PR 走完整门禁套件；vendor 化的 package 排除在外（它们的更新遵循 manifest 同步流程，理想情况下作为半自动化的 agent 工作流：拉取上游、重新应用 patch、运行门禁、打开 PR 并更新 manifest 表格）。

## 计划

3 最简单，先做。1 需要 CI 能通过网络访问上游仓库（私有镜像，需要 token），并将现有两项已记录的修改转为 patch 文件。2 和 4 属于配置工作。

## 曾考虑的替代方案

- **用 `pnpm audit` 代替 osv-scanner**：两者都满足安全公告扫描的需求；具体选择推迟到实现阶段决定。
- **用定时 agent 任务代替 Renovate**：在「以小 PR 提议更新并走完整门禁」这件事上效果等价；vendor 化的 package 无论哪种方案都排除在外（它们的更新遵循 manifest 同步流程）。

## 验收标准

- 许可证清单脚本在 CI 中运行，缺少 LICENSE 或 `license` 字段与 `vendor/README.md` 清单矛盾时失败。
- 夜间漂移 job 从 manifest SHA 加入库 patch 文件重建 `vendor/`，出现任何无法解释的 diff 时失败。
- 安全公告扫描按计划对 lockfile 运行，并在涉及 lockfile 的 PR 上运行。

## 风险

上游仓库是私有镜像；CI 凭证与可用性是漂移检查的主要阻力。如果受阻，改为本地定时 agent 任务而非 CI 运行。
