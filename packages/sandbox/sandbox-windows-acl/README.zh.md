# @deepseek-ai/dsh-sandbox-windows-acl

[English](README.md) | 中文

面向 [harness 沙盒接口](../sandbox/) 的 Windows 写入限制沙盒后端：用 Node.js/[koffi](https://koffi.dev/) 移植了 [huoyaoyuan/windows-acl-restrict-poc](https://github.com/huoyaoyuan/windows-acl-restrict-poc)（`10e4dfb` 修复版）的机制，作为 [`@deepseek-ai/dsh-sandbox-local`](../sandbox-local/) 链的 win32 档（`workspace-write` / `read-only` 模式）挂载；同一包还携带 Linux/macOS 后端。

一句话机制：把调用者令牌复制为 `WRITE_RESTRICTED` 受限令牌，其 restricting SIDs 中加入一个孤儿 SID（`S-1-4-x-y`），该 SID 只被本沙盒实例加到工作区与临时目录的 DACL 上。此后 Windows 只在「调用者正常权限」与「restricting SID 交集」同时允许时才放行写入——孤儿 SID 就是写入白名单，而它在系统其余位置不授予任何权限。

直接基于原始 ACL 机制实现是记录在案的设计选择：它能在不引入两个被否决容器方案所带问题的前提下实现两种限制模式——见[设计笔记](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md)（[mxc](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md) 要求 Windows 11 24H2 起步的 OS 版本，且任意路径读需要全盘写入宿主 DACL；AppContainer 则根本不支持任意路径读）。

## 用法

```ts
import { AclSandbox } from '@deepseek-ai/dsh-sandbox-windows-acl'

const workspaceRoot = process.cwd()

const sandbox = new AclSandbox({ writableDirs: [workspaceRoot] })
await sandbox.init() // throws on ANY Win32 failure — never spawns unrestricted

const child = sandbox.spawn({ command: 'pwsh', args: ['-NoProfile', '-Command', '...'], cwd: workspaceRoot })
const { stdout, stderr, exitCode } = await child.wait()

sandbox.dispose() // revokes all standing grants; reports every cleanup failure
```

本包对**每一个** Win32 API 调用都做返回值检查；失败抛出 `Win32Error`，携带 API 名、精确的 Win32 错误码、`FormatMessageW` 系统文本和出错的路径/上下文。这是有意为之：原 POC 忽略所有返回值，当 `CreateRestrictedToken` 失败时会静默地用**完整未受限令牌**运行子进程（fail-open）。本移植从构造上保证 fail-closed。

## 隔离 runner

面向 seam 的形态是 **runner 入口**（`./runner`）：`@deepseek-ai/dsh-sandbox-local` 用它替换调用方命令的 argv 前缀包装——与 bwrap/landlock-run/sandbox-exec 同一架构，因此沙盒 seam 的 `confine()` 契约**无需任何改动**。稳定的 argv 契约：

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> -- <argv...>
```

runner 创建受限令牌，在令牌下启动被包裹的 argv，stdio 直接透传（spawn 前后把调用方的管道句柄恢复/清除继承位——Node 启动时会清掉自身 stdio 的继承位，裸 spawn 必须补偿这一点），把子进程放进 `KILL_ON_JOB_CLOSE` 作业（runner 死亡即杀死子进程），忽略自身的控制台 Ctrl+C 让子进程自行处理，镜像子进程退出码，退出时回收所有授权。任何 runner 侧失败都会向 stderr 打印 `windows-acl-run: <detail>` 并以 127 退出——seam 的 `RUNNER_FAILURE_RULES` 据此区分 runner 失败与真正的权限拒绝。

模式：
- `workspace-write`：工作区与临时目录携带孤儿 SID 的 Write 授权；其余写全部被令牌交集拒绝。
- `read-only`：**严格零授权**——没有任何可写位置。NUL 设备是带安全描述符的对象，同样不被授权（区别于 Linux 的 `/dev/null` sink）：`Set-Content NUL` 与原生 `> NUL` 写会以 access denied 失败，而 PowerShell 的 `> $null` 重定向不受影响（它直接丢弃、不打开 NUL）。这是文档化的行为，不是给模型的承诺——模型可见面没有对 read-only 模式做过任何 sink 承诺。

`AclSandbox` 类（`tempDir: null` 关闭临时目录授权）仍是直接 spawn 场景的程序化 API。

## 头文件查证

所有常量、函数签名和结构体布局都对照开发机的 Windows 头文件（MinGW `winnt.h` / `accctrl.h` / `aclapi.h` / `securitybaseapi.h` / `sddl.h` / `processthreadsapi.h` / `fileapi.h` / `namedpipeapi.h` / `synchapi.h` / `winbase.h`）逐一核实，并由 [`verify/abi-probe.cpp`](verify/abi-probe.cpp)（尺寸、偏移、枚举值、static_assert）交叉验证：

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp -ladvapi32 && ./abi-probe.exe
```

模块加载时 koffi 结构体定义会与探针输出比对尺寸，头文件/koffi 布局一旦漂移立即报错，而不是悄悄写坏内存。

## 已验证的边界（受限令牌固有，非本移植缺陷）

- **只限制写；读、网络、进程可见性均不受限。** `WRITE_RESTRICTED` 只对写访问做交集检查，受限子进程可以读取调用者能读的任何文件、可以开 socket。因此 `read-only` 模式无法仅靠本机制表达，需要叠加读侧策略或改用 AppContainer/`S-1-15-2` capability 令牌做强隔离。
- **控制台隔离不可用。** 受限令牌下用 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 创建的子进程会在 DLL 初始化阶段以 `STATUS_DLL_INIT_FAILED`（`0xC0000142`）死亡。POC 曾试图把控制台登录 SID（`S-1-2-1`）加进 restricting 列表来修复：在 Windows 11 26200 上 `CreateWellKnownSid(WinLocalLogonSid)` 直接失败（`ERROR_INVALID_PARAMETER` 87），改用正确的 `WinConsoleLogonSid` 虽能得到合法的 `S-1-2-1`，子进程仍然死亡，POC 最终版本遂删除了该 SID 并放弃控制台隔离。因此子进程共享宿主控制台；stdio 重定向走管道，不受影响。
- **ACL 授权是对真实目录的驻留改动。** 进程中途死亡会留下授权；`dispose()` 负责回收，`init()` 后续步骤失败时也会回滚已应用的授权。POC 注释里的手工清理命令（`icacls <dir> /remove '*S-1-4-…'`）在本平台实测失败（`ERROR_NONE_MAPPED` 1332）——请通过本模块回收。
- **被授权目录必须归调用者所有。** 所有者隐含的 `WRITE_DAC` 是免提权改 DACL 的前提。
- **临时目录授权跟随 `GetTempPathW`** —— 尽可能显式传入 `tempDir`。`GetTempPathW` 读取的是原生环境块，用 worker 池管理 `process.env` 的宿主运行时（vitest 实测）不会把 worker 侧的 `process.env.TMP` 改动同步过去。若默认授权落到真实临时目录，其 `(OI)(CI)` 继承会覆盖 temp 下所有子目录、静默扩大白名单——请指向按沙盒隔离的目录。

## 模型体验

经 [`dsh-bash-sandbox`](../../bash/bash-sandbox/README.md)、[`dsh-pwsh-sandbox`](../../bash/pwsh-sandbox/README.md) 及其工具间接生效：它们渲染本后端的强制完整性与拒绝事实（受限 stderr 由工具层按 `denialSignatures` 分类），而 [`dsh-sandbox`](../sandbox/README.md) seam 拥有 `SANDBOX_UNAVAILABLE` 文本与 runner 选择。

#### KV Cache 影响

无直接影响；拒绝呈现面属于工具层。

## 已知限制与后续工作

- **每个实例一个写入白名单** —— 孤儿 SID 是白名单的基本单位；同一沙盒实例跨两个工作区复用时，两个根目录会互相扩大授权面。请按工作区根目录各建一个实例。
- **清理尽力而为** —— `dispose()` 会尝试全部回收并把失败聚合为 `AggregateError`；清理失败只会留下仅含孤儿 SID 的 ACE，本进程下次 `init()`/`dispose()` 循环或 `icacls`（按 ACE 而非受托者名）仍可清除。
- **每次受限命令都会改动两个目录的 DACL** —— 进入时授权、退出时撤销，分别作用在工作区根与临时根：每次命令若干次 Win32 调用（继承按访问惰性求值，不是逐文件遍历）。runner 按命令付这笔开销；按会话复用一次授权留作后续工作，待开销真的成为问题再实现。
- **读侧隔离与网络策略超出范围** —— `WRITE_RESTRICTED` 只对写访问做交集检查；更强的隔离需叠加读侧策略。
