# Agent Note: 让 Lefthook 安装限定于各 worktree

Status: implemented

[English](2026-07-27-worktree-local-lefthook.md) | 中文

## 问题

每次运行 `pnpm install` 都会执行根目录的 [`postinstall`](../../../../package.json)，其中的 [`install-lefthook.mjs`](../../../../scripts/install-lefthook.mjs) 会调用 `lefthook install --force`。若无额外配置，关联的 Git worktree 共用同一仓库的默认钩子目录，因此在任一 worktree 中安装都可能改写其他所有 worktree 使用的钩子。

Lefthook 生成的钩子会优先使用安装时从对应 worktree 记录的绝对二进制文件路径，之后才尝试当前 worktree 的回退路径。因此，共享钩子会一直运行另一个 worktree 固定版本的二进制文件，直到该 worktree 消失；并发安装还会写入同一组文件。

## 决策

钩子安装以 worktree 为作用域。当 `CI=true` 或 `GITHUB_ACTIONS=true` 时，安装程序会在探测 Git 或做出任何变更之前返回，因为自动化任务不会使用贡献者钩子。否则，为了获取配置作用域的来源信息，安装程序要求 Git 2.26 或更高版本；它会将格式版本为 0 的仓库升级到格式版本 1，启用 `extensions.worktreeConfig`，并将当前 worktree 的 `core.hooksPath` 设为指向 `$GIT_DIR/dsh-hooks` 的绝对路径。首次启用这一仓库级扩展前，安装程序会检查主 worktree 与每个已注册关联 worktree 中尚未生效的 `config.worktree` 文件，并拒绝任何一经激活就会改变当前或其他 worktree 的设置。主 worktree 使用 `$GIT_COMMON_DIR/dsh-hooks`；每个关联 worktree 则使用 `$GIT_COMMON_DIR/worktrees/<id>` 下的对应目录。仓库级锁会串行化配置迁移与钩子写入，包括并发触发的重复安装。每个锁都会记录进程 ID 和随机所有权令牌；释放锁时会验证同一个文件身份与完全一致的记录。安装程序绝不会自动破坏所属进程已结束或内容无效的锁，因此诊断会要求贡献者先确认没有安装程序正在运行，再手动移除该锁。

安装程序通过私有所有权标记识别其钩子目录，并以幂等方式更新该目录。它会检查 `core.hooksPath` 的生效作用域、来源和值，并拒绝没有所有权标记的目录、所有命令作用域路径，以及所有非本安装程序所有的 worktree 作用域路径，包括通过 `config.worktree` 中的 include 加载的值。安装程序会用 Git 的解析器跟踪 `includeIf`；若命令作用域或 worktree 作用域的目标配置提供钩子路径，或者无法安全证明它不会提供钩子路径，安装程序就会拒绝继续。因此，安装时未生效的条件日后也无法在安装程序的直接配置值之前隐藏用户自有路径。系统配置、全局配置或共用仓库配置中存在相同风险时，必须设置 `DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1`，从而只让当前 worktree 显式启用 Lefthook，其他 worktree 则继续使用继承路径。与钩子无关的 `includeIf` 仍然有效。完成验证后，Lefthook 子进程的环境会移除命令作用域的 Git 配置。这项显式选择不会尝试串联任意钩子管理器。

启用 worktree 配置时，安装程序会从共用配置中移除标准但冗余的 `core.bare=false`，因为 false 仍是 Git 的默认值；无论共用配置直接设置了 `core.worktree` 或 `core.bare=true`，还是通过当前生效的 include 加载了这些值，安装程序都会拒绝继续并要求手动迁移。启用扩展之前，安装程序会跟踪共用配置中的 `includeIf`；若目标配置提供任一迁移敏感键，或者无法安全证明它不会提供这些键，安装程序就会拒绝继续。与迁移无关的 `includeIf` 仍然有效。若首次安装期间 Lefthook 失败，安装程序会移除新建的 worktree 覆盖，使原有的继承钩子或共用钩子继续生效。worktree 本地安装程序绝不会移除或改写 `$GIT_COMMON_DIR/hooks` 中的旧文件。

[`install-lefthook.spec.ts`](../../../../scripts/install-lefthook.spec.ts) 覆盖 CI 下不执行操作的行为、主 worktree 和关联 worktree、移除后的相互独立性、重复与并发安装、陈旧锁与锁所有权被替换、Git 版本边界、拒绝激活其他 worktree 中尚未生效的配置、通过生效及条件式共用配置 include 加载的迁移键、按作用域拒绝自定义路径与显式覆盖、生效及未生效的 worktree include、继承的条件式路径、命令环境隔离、保留旧公共钩子，以及安装失败时的回滚。

## 考虑过的替代方案

**保留共享的生成钩子，并依赖其当前 worktree 回退路径。** 只要对应 worktree 仍存在，记录的绝对路径就会优先生效，因此回退路径无法提供版本或生命周期隔离。

**让每个 worktree 都指向同一个纳入版本控制的 `.githooks` 目录。** 使用受版本控制的相对目录可以消除生成的绝对路径，但更改共享的 `core.hooksPath` 可能会禁用旧 worktree 中的钩子，因为其分支并不包含该目录；同时，每个 worktree 仍然耦合于同一个共享配置值。

**构建通用的钩子管理器串联层。** 执行顺序、参数转发、失败语义和升级都会成为仓库自行负责的行为，却与 Lefthook 隔离无关。因此，安装程序会拒绝 worktree 专属的自定义路径，只将范围更窄的继承路径覆盖设为显式操作。

**将特定 CI 提供商的凭据 include 路径加入白名单。** CI 不使用贡献者钩子，因此路径豁免会使安装程序的安全性耦合于提供商的检出目录内部结构，并削弱贡献者安装时的严格验证。CI 无操作方案无需任何豁免即可避免修改仓库。

**停止自动安装钩子。** 手动设置可以避免共享写入，却会使仓库中低成本的提交与推送检查意外变成可选项，短期存在、由 agent（智能体）使用的 worktree 尤其容易受到影响。

## 后果

安装或移除任一 worktree 不再改变其他 worktree 的生效钩子、二进制文件路径或生成的钩子字节。并发安装会串行执行，重复安装保持幂等；[快速本地 Git 钩子](2026-07-22-fast-local-git-hooks.md)所规定的任务与延迟边界保持不变。

首次安装后，仓库会采用 Git 格式版本 1，并拒绝版本低于 Git 2.26 的客户端。自定义 worktree 钩子管理器需要明确选择集成方式；继承钩子路径可继续供其他 worktree 使用，但当前 worktree 显式启用 Lefthook 后，其中不会运行这些继承钩子，除非贡献者通过 `lefthook.yml` 将其串联起来。

旧的共用钩子会为尚未升级的 worktree 保留在磁盘上。它们可能逐渐陈旧，但自动删除这些钩子会破坏已注册但所在分支尚未采用本安装程序的 worktree。
