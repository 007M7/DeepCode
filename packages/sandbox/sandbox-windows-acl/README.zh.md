# @deepseek-ai/dsh-sandbox-windows-acl

[English](README.md) | 中文

面向 [harness 沙盒接口](../sandbox/) 的 Windows 写入限制沙盒后端：用 Node.js/[koffi](https://koffi.dev/) 移植了 [huoyaoyuan/windows-acl-restrict-poc](https://github.com/huoyaoyuan/windows-acl-restrict-poc)（`10e4dfb` 修复版）的机制，作为 [`@deepseek-ai/dsh-sandbox-local`](../sandbox-local/) 链的 win32 档（`workspace-write` / `read-only` 模式）挂载；同一包还携带 Linux/macOS 后端。

一句话机制：把调用者令牌复制为 `WRITE_RESTRICTED` 受限令牌，其 restricting SIDs 中加入一个孤儿 SID（`S-1-4-x-y`），该 SID 的 Write ACE 只存在于会话的工作区与私有临时目录上（seam 为每个会话只配置一个 SID，并为服务器的生命周期物化 ACE——见[隔离 runner](#the-confinement-runner)）。此后 Windows 只在「调用者正常权限」与「restricting SID 交集」同时允许时才放行写入——孤儿 SID 就是写入白名单，而它在系统其余位置不授予任何权限。

直接基于原始 ACL 机制实现是记录在案的设计选择：它能在不引入两个被否决容器方案所带问题的前提下实现两种限制模式——见[设计笔记](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md)（[mxc](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md) 要求 Windows 11 24H2 起步的 OS 版本，且任意路径读需要全盘写入宿主 DACL；AppContainer 则根本不支持任意路径读）。

## 用法

```ts
import { AclSandbox } from '@deepseek-ai/dsh-sandbox-windows-acl'

const workspaceRoot = process.cwd()

// mode selects the token's restricting-SID list (see Modes below) and must
// match the grant shape: read-only pairs with zero grants.
const sandbox = new AclSandbox({ writableDirs: [workspaceRoot], mode: 'workspace-write' })
await sandbox.init() // throws on ANY Win32 failure — never spawns unrestricted

const child = sandbox.spawn({ command: 'pwsh', args: ['-NoProfile', '-Command', '...'], cwd: workspaceRoot })
const { stdout, stderr, exitCode } = await child.wait()

sandbox.dispose() // revokes all standing grants; reports every cleanup failure
```

直接使用 `AclSandbox` 时按实例授权与回收（每个 spawn 周期一个白名单）。服务器侧的按会话复用是 `AclWriteGrant` 类：每个会话一个实例，每个目录一次 `add()`，提供方关闭时 `dispose()` ——见下方 runner 契约。本包对**每一个** Win32 API 调用都做返回值检查；失败抛出 `Win32Error`，携带 API 名、精确的 Win32 错误码、`FormatMessageW` 系统文本和出错的路径/上下文。这是有意为之：原 POC 忽略所有返回值，当 `CreateRestrictedToken` 失败时会静默地用**完整未受限令牌**运行子进程（fail-open）。本移植从构造上保证 fail-closed。

## 隔离 runner

面向 seam 的形态是 **runner 入口**（`./runner`）：`@deepseek-ai/dsh-sandbox-local` 用它替换调用方命令的 argv 前缀包装——与 bwrap/landlock-run/sandbox-exec 同一架构，因此沙盒 seam 的 `confine()` 契约**无需任何改动**。稳定的 argv 契约：

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> [--write-sid <S-1-4-…>] -- <argv...>
```

runner 创建受限令牌，在令牌下启动被包裹的 argv，stdio 直接透传（spawn 前后把调用方的管道句柄恢复/清除继承位——Node 启动时会清掉自身 stdio 的继承位，裸 spawn 必须补偿这一点），把子进程放进 `KILL_ON_JOB_CLOSE` 作业（runner 死亡即杀死子进程），忽略自身的控制台 Ctrl+C 让子进程自行处理，镜像子进程退出码，退出时回收所有授权。任何 runner 侧失败都会向 stderr 打印 `windows-acl-run: <detail>` 并以 127 退出——seam 的 `RUNNER_FAILURE_RULES` 据此区分 runner 失败与真正的权限拒绝。

**按会话授权复用**（`--write-sid`）：seam 为每个会话只配置一个孤儿 SID——以仅作日志记录的 `sandbox/acl-session` 事件写入会话日志，因此恢复的会话回放**同一个** SID，fork 则铸造一个新的——并在会话首次受限执行时惰性物化其 ACE，在**服务器**进程生命周期内持有（提供方 dispose 时撤销）。传入 `--write-sid` 时 runner 既不授权也不回收（`manageDacls: false`）；不传它（独立使用）则与之前一样按调用自行管理授权。重启后重新授权是幂等的：`grantWrite` 读取当前 DACL，当完全相同的 ACE 已存在时跳过 `SetNamedSecurityInfoW` 的应用（该应用会把相同的 ACE 急切地重新传播到整棵树——大型工作区上以分钟计）。异常关闭遗留的 ACE 无需垃圾回收：会话记录重新授权同一个 SID，下一次 dispose 即撤销它们。已知代价：在大型工作区树上物化授权会阻塞整次急切传播，每个服务器生命周期内每会话一次。

模式（令牌的 restricting SID 列表随模式而定；保活组在**两种**模式下都是登录 SID + Everyone——没有它们，早期 DLL init 会以 `0xC0000142` 死亡，CNG 会让 pwsh 以 `0xE0434352` 崩溃）：
- `workspace-write`（登录 SID、Everyone、孤儿 SID）：工作区与会话的**私有**临时子目录携带孤儿 SID 的 Write 授权；其余写全部被令牌交集拒绝。
- `read-only`（登录 SID、Everyone——不含孤儿 SID）：**严格零授权**——没有任何可写位置。孤儿 SID 有意留在列表**之外**：先前 workspace-write 时期留下的驻留授权 ACE（`/permission` 降级，或崩溃后恢复的会话）在 read-only 下保持**失效**，因为 write-restricted 的 pass-2 检查只授予 restricting 列表所携带的内容——而未撤销的 ACE 让重新升级免于重新传播。NUL 设备是带安全描述符的对象，同样不被授权（区别于 Linux 的 `/dev/null` sink）：`Set-Content NUL` 与原生 `> NUL` 写会以 access denied 失败，而 PowerShell 的 `> $null` 重定向不受影响（它直接丢弃、不打开 NUL）。

Authenticated Users 在**两种**列表中都缺席——WMI 命名空间安全检查失败（`0x80041003`），因此 CIM cmdlet 与 `Get-ComputerInfo`（静默返回不完整结果而非报错）在**每一种**受限模式下都不可用，且 C:\-root 建树逃逸（驻留的 `AU:(AD)` + `AU:(OI)(CI)(IO)(M)` ACE）在两种模式下都被关闭——模型可见面文档化的是这一契约，而非提示词承诺。INTERACTIVE/LOCAL 同样在**两种**列表中都缺席：宿主的 Public 树把写权限授予 INTERACTIVE，因此 Public 写入会被拒绝——由 runner 的环境可写 Public-probe 回归钉住（见设计笔记）。

`AclSandbox` 类（`tempDir: null` 关闭临时目录授权）仍是直接 spawn 场景的程序化 API；`AclWriteGrant` 是按会话契约中服务器侧的物化半边。

## 头文件查证

所有常量、函数签名和结构体布局都对照开发机的 Windows 头文件（MinGW `winnt.h` / `accctrl.h` / `aclapi.h` / `securitybaseapi.h` / `sddl.h` / `processthreadsapi.h` / `fileapi.h` / `namedpipeapi.h` / `synchapi.h` / `winbase.h`）逐一核实，并由 [`verify/abi-probe.cpp`](verify/abi-probe.cpp)（尺寸、偏移、枚举值、static_assert）交叉验证：

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp -ladvapi32 && ./abi-probe.exe
```

模块加载时 koffi 结构体定义会与探针输出比对尺寸，头文件/koffi 布局一旦漂移立即报错，而不是悄悄写坏内存。

## 已验证的边界（受限令牌固有，非本移植缺陷）

- **只限制写；读、网络、进程可见性均不受限。** `WRITE_RESTRICTED` 只对写访问做交集检查，受限子进程可以读取调用者能读的任何文件、可以开 socket。因此 `read-only` 模式无法仅靠本机制表达，需要叠加读侧策略或改用 AppContainer/`S-1-15-2` capability 令牌做强隔离。
- **控制台隔离不可用。** 受限令牌下用 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 创建的子进程会在 DLL 初始化阶段以 `STATUS_DLL_INIT_FAILED`（`0xC0000142`）死亡。POC 曾试图把控制台登录 SID（`S-1-2-1`）加进 restricting 列表来修复：在 Windows 11 26200 上 `CreateWellKnownSid(WinLocalLogonSid)` 直接失败（`ERROR_INVALID_PARAMETER` 87），改用正确的 `WinConsoleLogonSid` 虽能得到合法的 `S-1-2-1`，子进程仍然死亡，POC 最终版本遂删除了该 SID 并放弃控制台隔离。因此子进程共享宿主控制台；stdio 重定向走管道，不受影响。
- **ACL 授权是对真实目录的驻留改动。** 进程中途死亡会留下授权；`dispose()` 负责回收，`init()` 后续步骤失败时也会回滚已应用的授权。POC 注释里的手工清理命令（`icacls <dir> /remove '*S-1-4-…'`）在本平台实测失败（`ERROR_NONE_MAPPED` 1332）——请通过本模块回收。按会话记录让异常关闭可自愈：恢复时重新授权同一个 SID（ACE 已存在则跳过应用），并在下一次 dispose 撤销；孤儿 ACE 不会因每次重启而累积新 SID。
- **被授权目录必须归调用者所有。** 所有者隐含的 `WRITE_DAC` 是免提权改 DACL 的前提。
- **临时目录授权跟随 `GetTempPathW`** —— 尽可能显式传入 `tempDir`。`GetTempPathW` 读取的是原生环境块，用 worker 池管理 `process.env` 的宿主运行时（vitest 实测）不会把 worker 侧的 `process.env.TMP` 改动同步过去。seam 会传入会话的**私有**子目录（`<temp>\dsh-<hash>`）；若默认授权落到真实临时目录，其 `(OI)(CI)` 继承会覆盖 temp 下所有子目录、静默扩大白名单——请指向按沙盒隔离的目录。
- **受限子进程的临时根目录按会话私有**（workspace-write + `--write-sid`）：runner 在 spawn 之前用 `SetEnvironmentVariableW` 把 TMP/TEMP 改写为会话的私有子目录，子进程继承改写后的环境块（bwrap `--tmpfs /tmp` 的语义）。read-only 保持环境中的临时目录条目不动——那里的写入反正会被拒绝。子目录本身只是 `%TEMP%` 下的普通垃圾、没有垃圾回收：OS 对临时目录的日常清理会回收它，记录的确定性让之后的恢复可以复用它。
- **`whoami` 与令牌检查类 cmdlet 在受限令牌下会失败。** 副本上的 `GetTokenInformation` 对子进程部分不可用，因此 `whoami /all` 会报错——这是受限方案的诊断噪音，而非运行故障；真正重要的拒绝面（文件写入）不受影响。

## 模型体验

经 [`dsh-bash-sandbox`](../../bash/bash-sandbox/README.md)、[`dsh-pwsh-sandbox`](../../bash/pwsh-sandbox/README.md) 及其工具间接生效：它们渲染本后端的强制完整性与拒绝事实（受限 stderr 由工具层按 `denialSignatures` 分类），而 [`dsh-sandbox`](../sandbox/README.md) seam 拥有 `SANDBOX_UNAVAILABLE` 文本与 runner 选择。

#### KV Cache 影响

无直接影响；拒绝呈现面属于工具层。

## 已知限制与后续工作

- **每个实例一个写入白名单** —— 孤儿 SID 是白名单的基本单位；同一沙盒实例跨两个工作区复用时，两个根目录会互相扩大授权面。请按工作区根目录各建一个实例（seam 的按会话记录正是这样做的：每个会话一个 SID，以会话不可变的 cwd 为键）。
- **清理尽力而为** —— `dispose()` 会尝试全部回收并把失败聚合为 `AggregateError`；清理失败只会留下仅含孤儿 SID 的 ACE，本进程下次 `init()`/`dispose()` 循环或 `icacls`（按 ACE 而非受托者名）仍可清除。
- **授权物化是急切的全树传播。** 对带可继承 ACE 的目录调用 `SetNamedSecurityInfoW` 会立即遍历每个后代（**不是**按访问惰性求值——实测在大型工作区树加上真实临时根上要几十秒）。按会话复用使它在每个服务器生命周期内每会话只付一次（在首次受限执行时惰性发生；完全相同的 ACE 历经重启存活时整体跳过）；自管理的 runner 回退路径仍每次调用都付。若会话的工作区巨大，每个服务器生命周期内的第一次 pwsh 调用会相应地变慢。
- **在两个服务器进程中并发恢复同一会话会产生两个 SID。** 持久化记录存放在会话日志中；两个进程各自读取或创建记录，按路径的锁保持 DACL 合并一致，最后写入的记录胜出并用于后续恢复——落败 SID 的 ACE 由其所属进程的 dispose 撤销。单写者的会话用法（常规部署形态）不会遇到这种情况。
- **读侧隔离与网络策略超出范围** —— `WRITE_RESTRICTED` 只对写访问做交集检查；更强的隔离需叠加读侧策略。
- **宽目录与 FAT 卷警告留待后续；FAT 类目标保持可写。** 针对异常宽的目录或 FAT 类（无 ACL）卷授权的 UI 侧警告尚未实现，且 FAT 卷作为授权**根**时只会让授权立即报错（无 ACL 支持）。位于授权根**之外**的 FAT 类目标则不同：它没有安全描述符，因此受限令牌的写检查会通过（Everyone 在两种列表中都存在），这类目标在**两种**受限模式下都可写。FAT 视作历史残留——不支持、不工程化应对；这一仅警告性姿态在此记录成文，而非加以缓解。
- **两种受限模式都以 ConstrainedLanguage 运行 `pwsh`。** 受限令牌触发 PowerShell 的锁定检测，因此在 `read-only` 与 `workspace-write` 下语言模式都是 ConstrainedLanguage：`Add-Type`（C# 编译、P/Invoke）、非核心 .NET 静态调用（`[System.IO.*]::`、`[math]::`、`[Environment]::`）、COM 对象与反射都会以 `Cannot create type` / `Cannot invoke method`（“only core types”）错误失败，且 `$ExecutionContext.SessionState.LanguageMode = 'FullLanguage'` 会被拒绝。核心 cmdlet、核心类型（`[string]`、`[datetime]`、`[regex]`、`[guid]`）、`-f` 格式化与属性访问继续工作。`pwsh` 工具描述把这一契约教给模型；`danger-full-access` 调用不受隔离、以 FullLanguage 运行。
