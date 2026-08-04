# dsh-environment

[English](README.md) | 中文

把本次运行的环境冻结为一份不可变快照，并记住**每个值来自哪一层**。消费方用它而不是 `process.env` 解析面向用户的值，因为各层的可信程度并不相同，而压平后的视图无法区分它们。

| 层 | 来源 id | 它是什么 |
|---|---|---|
| 继承的进程环境 | `process` | 启动 shell、CI 任务或容器传入的东西——本次运行的明确意图 |
| `<invocation cwd>/.env` | `project-env` | 项目目录里恰好有的东西；在该工作区里工作的模型可以写它 |
| `$DSH_HOME/.env` | `user-env` | 用户自己的机器级默认值 |

这些值同样会进入 `process.env`——用户自己的 `--config` 树和第三方库要读它——但那份压平的视图不是 harness 解析任何值的依据。

## 解析

`get(name)` 按可信度从高到低搜索所有层。`getFrom(name, sources)` 只搜索调用方信任的层。

**省略某一层是拒绝，不是降级。** base URL 决定已解析的 API key 被发往何处，因此 LLM 适配器请求的是 `['process', 'user-env']`：后续任何重新排序都无法让项目文件重定向凭据，因为那一层根本不会被查询。

```ts
import type { Context } from 'cordis'
import { environmentOf } from '@deepseek-ai/dsh-environment'

declare const ctx: Context
const endpoint = environmentOf(ctx).getFrom('DEEPSEEK_BASE_URL', ['process', 'user-env'])?.value
```

当产品 CLI（命令行界面）启动了这棵树时，`environmentOf(ctx)` 返回启动器的快照；否则返回只含继承环境的那一层。该回退并不削弱规则：SDK 宿主或裸 `cordis.yml` 从未发现过任何文件，因此它拥有的一切确实就是它被启动时的环境。

## bootstrap 变量

`isBootstrapOnly(name)` 给出只有继承环境才能设置的变量。启动器一旦发现某个 `.env` 声明了其中之一，就会在应用任何内容之前拒绝启动。

bootstrap 变量决定**进程如何启动**（`PATH`、`SHELL`、`NODE_OPTIONS`、`NODE_PATH`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`DYLD_*`）、**代码或模型可见的指令从哪里加载**（整个 `DSH_*` 命名空间、`HOME`、`USERPROFILE`、`XDG_*`），或者**网络如何抵达与信任**（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`、`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`）。匹配不区分大小写，因此 `https_proxy` 不是绕过手段。

整个 `DSH_*` 命名空间被拒绝，而不是只拒绝一份经过审查的子集：harness 自己的开关——权限模式、agents home、内置 skill（技能）根目录——恰恰是敌意项目最想要的，而后来新增的开关不能因为忘记登记就变得可设置。

## Known Limitations and Deferred Work

- **快照不是子进程边界**：每一层同样会被物化进 `process.env`，因此普通的项目变量仍会按 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 的清洗规则抵达子进程。bootstrap 变量完全不能来自文件，但项目 `.env` 仍可以为 agent 运行的工具设置诸如 `GIT_SSH_COMMAND` 之类的变量。
- **没有按工作区划分的层**：项目层是*调用*目录，在启动时固定。之后在 Web UI 中选择的工作区不贡献任何内容，这是刻意的：跟随它等于让模型自己的工作区在会话中途改变 harness 的环境。
