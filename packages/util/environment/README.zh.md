# dsh-environment

[English](README.md) | 中文

把本次运行的环境冻结为一份不可变快照，并记住**每个值来自哪一层**。消费方用它而不是 `process.env` 解析面向用户的值，因为各层的可信程度并不相同，而压平后的视图无法区分它们。

| 层 | 来源 id | 它是什么 |
|---|---|---|
| 继承的进程环境 | `process` | 启动 shell、CI 任务或容器传入的东西——本次运行的明确意图 |
| `<invocation cwd>/.env` | `project-env` | harness 被启动于其中的项目；产品信任它配置自己的 agent |
| `$DSH_HOME/.env` | `user-env` | 用户自己的机器级默认值 |

这些值同样会进入 `process.env`——用户自己的 `--config` 树和第三方库要读它——但那份压平的视图不是 harness 解析任何值的依据。

## 解析

`get(name)` 按可信度从高到低搜索所有层。`getFrom(name, sources)` 只搜索指定的层，不改变这一可信顺序。

**省略某一层是拒绝，不是降级**——绝不能接受某一层的调用方直接不把它列进去，后续任何重新排序都无法让它回来。provider 适配器三层全列，因为产品信任它所运行的项目；该机制是为那些「并非如此」的决策准备的。

变量名按平台自身的规则匹配：POSIX 上精确匹配，Windows 上不区分大小写。在 Windows 上做大小写敏感的查找会选错层——shell 里的 `deepseek_api_key` 与项目 `.env` 里的 `DEEPSEEK_API_KEY` 对操作系统而言是同一个变量，把它们当成两个就会让项目胜出。

```ts
import type { Context } from 'cordis'
import { environmentOf } from '@deepseek-ai/dsh-environment'

declare const ctx: Context
const endpoint = environmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value
```

当产品 CLI（命令行界面）启动了这棵树时，`environmentOf(ctx)` 返回启动器的快照；否则返回只含继承环境的那一层。该回退并不削弱规则：SDK 宿主或裸 `cordis.yml` 从未发现过任何文件，因此它拥有的一切确实就是它被启动时的环境。

## bootstrap 变量

`isBootstrapOnly(name)` 给出只有继承环境才能设置的变量。启动器一旦发现某个 `.env` 声明了其中之一，就会在应用任何内容之前拒绝启动。

信任一个项目配置 agent 的工作，不等于让它改变 harness 本身。bootstrap 变量决定**进程如何启动**（`PATH`、`SHELL`、`NODE_OPTIONS`、`LD_PRELOAD`、`DYLD_*`）、**运行时在执行被要求运行的程序之前先执行哪些代码**（`BASH_ENV` 及其各语言同类——`PERL5OPT`、`PYTHONSTARTUP`、`RUBYOPT`、`JAVA_TOOL_OPTIONS`——以及 Git 的钩子命令）、**模型可见的指令从哪里加载**（整个 `DSH_*` 命名空间、`HOME`、`XDG_*`），或者**网络如何抵达与信任**（proxy 与 CA 变量）。匹配不区分大小写，因此 `https_proxy` 不是绕过手段。

这些变量无需任何用户动作、在任何一轮开始之前、且在权限策略与沙箱之外就生效：`DSH_PERMISSION_MODE` 会关掉让「信任项目」有意义的那道审批，而 `BASH_ENV` 会在 bash 工具发出的每一次 `bash -c` 上执行项目指定的文件。

整个 `DSH_*` 命名空间被拒绝，而不是只拒绝一份经过审查的子集：harness 自己的开关——权限模式、agents home、内置 skill（技能）根目录——恰恰是敌意项目最想要的，而后来新增的开关不能因为忘记登记就变得可设置。

## Known Limitations and Deferred Work

- **快照不是子进程边界**：每一层同样会被物化进 `process.env`，因此项目里的普通变量会按 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 的清洗规则抵达子进程。这对普通变量是有意为之；会滥用这一点的代码加载钩子改为在加载时拒绝，新的运行时钩子出现时该扩展的是那份拒绝清单。
- **没有按工作区划分的层**：项目层是*调用*目录，在启动时固定。之后在 Web UI 中选择的工作区不贡献任何内容，这是刻意的：跟随它等于让模型自己的工作区在会话中途改变 harness 的环境。
