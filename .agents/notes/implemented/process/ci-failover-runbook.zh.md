# Agent Note: CI 故障切换手册 — 托管池 → 自有池

Status: implemented

[English](ci-failover-runbook.md) | 中文

## 这是什么

[CI](../../../../.github/workflows/ci.yml) 中三个必需的 Linux 作业（`node 24 / static`、`node 24 / coverage`、`node 24 / snapshots and artifacts`）通过仓库变量 `DSH_CI_FAILOVER` 解析运行器池。正常情况下该变量不存在，作业运行在托管的企业级 32 核池上。当托管池发生故障（作业无限排队、企业标签消失或 GitHub 侧容量故障）时，仓库管理员无需合并任何代码即可把三个作业整体切换到公司自有的自托管池——此时合并本身正被这些失败的检查阻塞，任何"先合 PR 再切换"的方案都是死锁。

自有池（`vm-backup`：一台 64 核虚拟机，4 个常驻 systemd 管理的运行器实例，另有 4 个已注册备用位）由 `serial / linux (self-hosted standby)` 通道持续验证——每次 master 推送都在其上运行完整的未分片聚合流程。切换前先看该通道最近一次运行：绿色 = 这套环境昨天刚被全量验证过。

## 切换步骤（仓库管理员，约 1 分钟，无需合并）

1. 仓库 **Settings → Secrets and variables → Actions → Variables → New repository variable**：名称 `DSH_CI_FAILOVER`，值 `selfhosted`。
2. 对受影响 PR 的失败/排队作业点 Re-run failed jobs（或等新推送自然触发）。
3. 切换到此完成。故障切换状态下工作流还会自动：把 `DSH_COVERAGE_MAX_WORKERS` 降为 12、`DSH_SNAPSHOT_MAX_CONCURRENCY` 降为 16（共享虚拟机的争抢上限），并跳过托管路径的 pnpm 缓存恢复（虚拟机的持久 store 直接提供热安装）。

## 切换期间的容量

4 个常驻实例可承接正常 PR 流量。若出现排队，在虚拟机上把 4 个已注册的备用位拉起（无需 token——它们已注册）：

```bash
for i in 7 8 9 10; do cd /data_local/actions-runner-$i && sudo ./svc.sh install ubuntu && sudo ./svc.sh start; done
```

## 切回

删除 `DSH_CI_FAILOVER` 变量（或改为 `selfhosted` 以外的任何值），新的运行即解析回托管企业池。若启动过备用实例，将其停止。

## 信任边界

该变量是仅限仓库管理员的状态：拉取请求既不能设置它，也不能让不同的值生效，且表达式存在于基线分支的工作流定义中。因此这条故障切换路径没有增加任何可由 PR 编辑的自托管池访问途径。（运行器侧的强制约束——通过组织级 runner group 把这批运行器限定到 master 引用的工作流——另行跟踪，与本机制互补。）
