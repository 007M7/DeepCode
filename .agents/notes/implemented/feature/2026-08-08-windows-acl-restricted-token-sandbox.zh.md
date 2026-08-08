# Agent Note: Windows sandbox rung: raw ACL restricted tokens over mxc and AppContainer

Status: implemented

[English](2026-08-08-windows-acl-restricted-token-sandbox.md) | 中文

## Problem

[沙盒决策](2026-07-06-sandbox.md)把 `PLATFORM_CHAINS.win32` 留空，交付的 Windows profile 因为没有可用的隔离执行器而退化为 danger-full-access。win32 档必须实现沙盒词汇表承诺的两个文件效果模式——`read-only`（零写入）与 `workspace-write`（仅工作区根目录加后端定义的临时区域可写）——同时保持读、网络与进程可见性不受影响，因为所有模式都允许读取。

## Decision

直接基于原始 ACL 机制实现该档：把调用者令牌复制为 `WRITE_RESTRICTED` 受限令牌（`CreateRestrictedToken`，`WRITE_RESTRICTED` + `DISABLE_MAX_PRIVILEGE` + `LUA_TOKEN`），其 restricting SIDs 中包含孤儿 SID（`S-1-4-x-y`）；工作区与临时目录上孤儿 SID 的 Write ACE 就是全部写入白名单，因为 `WRITE_RESTRICTED` 只对写访问做交集检查，读保持调用者的完整环境访问。该机制来自 huoyaoyuan/windows-acl-restrict-poc（`10e4dfb`）的演示；本移植检查每一个 API 调用并 fail-closed（POC 因忽略返回值而 fail-open）。孤儿 SID 按会话而非按 spawn：seam 每会话供给一个 SID，作为 log-only 的 `sandbox/acl-session` 事件记录在会话日志中（fork 铸出新 SID；恢复回放同一个），其 ACE 在该会话首次受限执行时惰性物化，并在服务器进程生命周期内持有（提供方 dispose（资源释放）时回收；幂等重授权在该 ACE 跨重启原样存续时跳过急切的全树重传播——不做垃圾回收）。令牌的 restricting list 为双模式：list I（`read-only` = 登录 SID、Everyone、孤儿——不含 Authenticated Users，因此 CIM 不可用，但环境 AU 可写面（尤其是 C:\-root 建树逃逸）被关闭）与 list J（`workspace-write` = + Authenticated Users，以保留该残余面为代价维持 CIM 通路存活）；经验证的保活不变式是登录 SID + Everyone 支撑早期 DLL init 与 CNG，Authenticated Users 仅支撑 WMI namespace 安全校验。Workspace-write 子进程看到的是私有的每会话临时子目录（`<temp>\dsh-<hash>`，TMP/TEMP 由 runner 重写——bwrap `--tmpfs /tmp` 语义）。它以 [`@deepseek-ai/dsh-sandbox-windows-acl`](../../../../packages/sandbox/sandbox-windows-acl/README.md)（后端加 `./runner` argv 前缀入口）、[`dsh-sandbox-local`](../../../../packages/sandbox/sandbox-local/README.md) 的 `win32` 链档、以及作为隔离执行器的 [`@deepseek-ai/dsh-pwsh-sandbox`](../../../../packages/bash/pwsh-sandbox/README.md) 交付；Windows 平台层在受限 pwsh 栈之上重新启用完整权限面（sandbox/sandbox-policy/permission/approval/fs-sandbox）。

## How the restriction works (why no new identity)

身份路线靠"**谁**在跑子进程"来限制，本档靠"令牌派生"来限制。身份路线（landstrip 的 restricted-user、AppContainer）用全新账户或容器 SID 运行子进程，该身份在宿主的文件上从零条 ACE 开始——一切访问（包括读）默认拒绝，子进程要碰的每条路径都必须事后为那个身份补写 ACE 才能放行：这正是让两个备选方案出局的全盘 DACL 改造。受限令牌保留调用者自己的 SID 与 logon session：[`CreateRestrictedToken`](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken) 派生一个加入 restricting SIDs 与 `WRITE_RESTRICTED` 标志的令牌，于是 Windows 做两次访问检查——一次按正常 SID，一次按 restricting SIDs——只有两次都放行，写类访问才被授予。读只凭正常检查即可通过（调用者的 SID 在其可读范围内本来就携带读权限），所以本档不需要任何读授权、也不需要新账户；写还必须额外通过孤儿 SID 检查，而只有工作区与临时目录的 ACE 能满足它。`DISABLE_MAX_PRIVILEGE | LUA_TOKEN` 在令牌侧合成了新账户的受限用户效果，即使提升过的调用者派生的也是过滤令牌。同一原语其实也能限制读（`SidsToDisable` 把 SID 变为 deny-only），但受限读的令牌需要逐路径的读授权——恰好重新引入身份路线付出的代价——而沙盒词汇表从不要求读隔离。

## Alternatives considered

### 为什么不选 mxc（Microsoft xContainer）？

两个否决理由。其一，OS 版本要求太新：[mxc 的 OS 版本支持文档](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md)把产品下限设在 Windows 11 24H2（build 26100），而 BaseContainer 档（T1，`Experimental_CreateProcessInSandbox`）只在 25H2+（build 26600+）且启用 OS feature 时存在——在 25H2 及以下的所有受支持版本上，文件系统策略都会回退到 T3，即 AppContainer 加宿主侧 DACL ACE 改造。其二，在任一档下支持任意路径读都意味着要为子进程可读的每个路径写 ACL 授予读权限：模型要读整个工作区和任意文件，就需要全盘改写宿主 DACL——对只做写限制的需求而言，这是不必要的驻留副作用与代价。

### 为什么不选 AppContainer？

AppContainer 令牌没有环境读访问：每个可读路径都必须预先通过 capability 或显式 ACE 授予，因此任意路径读——harness 的读模型——在不做同样的全盘授予时无法支持。受限令牌完全不需要读授予：它只对写访问做交集。

### 为什么不选 landstrip？

[landstrip 评估](../../rejected/feature/2026-07-26-evaluate-landstrip-for-windows-sandbox-rung.md)在实现前已被否决（未经实战检验；自建 launcher 方案胜出），且其 Windows 后端是 AppContainer 形态，继承同样的任意路径读问题。

## Consequences

所得：仅写隔离、不引入新的 OS 版本下限（`CreateRestrictedToken` 比 mxc 的版本早二十年）、读/网络/进程可见性完全不受影响（与模式词汇表一致）、fail-closed 错误携带 API 名与精确 Win32 错误码。所失：无读侧或网络隔离；控制台隔离不可用（隐藏控制台子进程以 `STATUS_DLL_INIT_FAILED` 死亡；子进程共享宿主控制台）；被授权根目录上有驻留 ACE 改动（目录须为调用者所有，由提供方 dispose 回收，借助持久化的每会话记录跨重启自愈）；授权物化是急切的全树传播（`SetNamedSecurityInfoW` 立即遍历每个后代——在大型工作区上耗时数十秒），因每会话复用，每个服务器生命周期每会话只付一次；`read-only` 失去 CIM（AuthUsers 被移除——WMI namespace 安全校验失败，`Get-ComputerInfo` 静默返回不完整结果），而 `workspace-write` 保留 Authenticated-Users 残余面（C:\-root 建树逃逸）作为 CIM 通路可用的代价；`whoami` 与令牌检查 cmdlet 在受限令牌下失败（诊断噪音，已记录）。

## Testing

产品可见的 Windows 阵容切换仅存在于 win32，而 keyless 快照夹具必须在 macOS/Linux 上可重放，因此无法覆盖它；替代证据是 bundle 组合 spec（[`base.spec.ts`](../../../../packages/bundle/base/tests/base.spec.ts)、[`windows-shell.spec.ts`](../../../../apps/cli/tests/windows-shell.spec.ts)）加上 win32 真实 runner 套件（`packages/sandbox/sandbox-windows-acl/tests/`、`packages/bash/pwsh-sandbox/tests/`），组装态信号由 CI 的 Windows lane 负责。每会话授权机制在跨平台侧由 `packages/sandbox/sandbox-local/tests/acl-session.spec.ts` 钉住（记录 fold/供给、一次性物化、fork/恢复 SID 复用、dispose 回收——mock 掉 Win32 表面），win32 侧由 `grant.spec.ts`（真实 DACL 物化）、`acl.spec.ts` 的幂等授权快速路径与 `runner.spec.ts` 的 `--write-sid` 契约（调用者所有目录的授权、经 TMP/TEMP 的私有临时子目录、双模式 CIM 探针）钉住。

## Related

[pwsh 执行器决策](2026-08-01-pwsh-tool-and-executor.md)拥有本档所消费的 pwsh-sandbox/tool-pwsh 方言划分。
