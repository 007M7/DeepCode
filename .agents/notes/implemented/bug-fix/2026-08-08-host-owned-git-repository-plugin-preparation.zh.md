# Agent Note: 宿主自有的准备机制使 GitHub repository 插件可安装

状态：已实现

[English](2026-08-08-host-owned-git-repository-plugin-preparation.md) | 中文

## 问题

repository 插件的创作契约依赖 `scripts.prepare: "dsh-plugin-prepare"`，并要求源码仓库将 `@deepseek-ai/dsh-repository-plugin` 添加为开发依赖。该包是私有包，且未发布到 NPM，因此即使外部 GitHub 仓库符合其他要求，也无法在全新安装中取得该辅助程序。

这种生命周期选择也无法支持 pnpm 工作区内可选的 `.dsh-plugin`。pnpm 会先运行 Git 托管仓库首选的包管理器，再打包选定的子目录，从而准备 Git 托管包。嵌套执行的 `pnpm install` 会加入外层工作区，而不一定执行未列入其中的 `.dsh-plugin` 包的 `prepare` 脚本。因此，安装可能成功并发布一个仅包含源包元数据的缓存 generation；随后真实 DSH 启动因 `dsh-plugin.mjs` 不存在而失败。

签入仓库的 headless fixture（测试前置数据）没有捕获任一缺陷，因为它挂载的是已准备好的包装层。它证明的是运行时组合，而不是 GitHub 获取或包准备。

## 决策

修复后的创作格式要求元数据中精确包含 `scripts.prepack: "dsh-plugin-prepare"`，且不包含 DSH 依赖。pnpm 针对 Git 托管包的准备流程会在依赖安装步骤之后、打包清单选择 `.dsh-plugin` 子树之前显式调用 `prepack`，因此辅助程序仍可将 `../skills` 等同仓库的相邻资源复制进包内。

`@deepseek-ai/dsh-repository-plugin` 会生成临时的 POSIX 和 Windows 命令包装脚本，用于调用其自有的已构建 `dsh-plugin-prepare` 入口。`RepositoryCache` 接受由调用方持有的可执行文件目录，将它们解析为绝对路径，再前置到传给随附 pnpm、已清除凭据的包生命周期 `PATH`。该命令目录仅存在于安装事务期间，无论成功还是失败都会被移除。仓库仍是受信任的包管理器输入：DSH 仅提供这一条命令，其他生命周期脚本和依赖仍会按既有信任契约执行。

Node 24 消费方 CI 任务会传入从 PR（Pull Request）head 仓库和 SHA 派生的精确源。由于该仓库为私有仓库，工作流会写入一份作业作用域的 Git 配置，使用该作业的只读 token 对 GitHub HTTPS 连接进行认证，并将 pnpm 的 SSH 回退路径重写为这一已认证的传输方式。其构建入口验收会启动真实的 `apps/cli/lib/bin.js run` 命令，并通过一个仅作用于当次运行的 patch 选择 `private: true`、不含依赖的 GitHub fixture。验收要求该次运行到达 mock LLM（大语言模型），在实际模型请求中找到 repository skill 描述，并验证不可变 DSH 缓存中的生成包装层和已复制 skill。如果 CI 遗漏精确源，测试会失败，而不是静默跳过。

## 考虑过的替代方案

**把准备辅助程序发布到 NPM。** 拒绝，因为源包会仅为了调用当前运行的 DSH 安装本就拥有的代码，而增加一个需要发布和管理版本的依赖；现有辅助程序又有意保持私有。

**保留 `prepare`，只注入命令。** 拒绝，因为当 Git 仓库的包管理器把嵌套包当作另一工作区的一部分时，即使命令可用，也不会使嵌套包的 `prepare` 生命周期得以运行。

**在 RepositoryCache 安装选定包后再准备。** 拒绝，因为 pnpm 打包后的子目录不再包含 `../skills` 等路径所引用的同仓库相邻资源；准备必须在生成打包清单前完成。

**在 DSH 中克隆 GitHub 仓库，并绕过 pnpm 的 Git 获取器。** 拒绝，因为这会重复实现已由锁定版本的包管理器负责的 ref 解析、子目录选择、依赖安装、打包清单行为和缓存完整性。

## 后果

- 仓库作者可以把修复后的 `.dsh-plugin/package.json` 和源资源提交到 GitHub，而无需把插件或其准备辅助程序发布到 NPM。
- 私有 GitHub 源使用宿主的标准 Git 认证。CI 使用临时的只读配置而非运行器上的持久凭据来验证该路径。
- 预发布创作格式使用 `prepack` 而不是 `prepare`。无效的生命周期元数据会在源码准备或已安装包校验阶段导致失败，而不会留下状态不明的半成品格式。
- 精确源字符串仍标识不可变缓存 generation；改变 ref 或源配置会选择另一个 generation。
- 本次修复不扩大贡献范围：已准备的 repository 插件仍只贡献已声明的 skills 和通用 MCP 定义，而任意包生命周期代码仍是受信任的安装代码，不是面向模型的 Cordis 插件 API。

## 测试

`packages/ui/app-boot/tests/repository-cache.spec.ts` 会用注入的命令目录通过随附 pnpm 运行本地 Git 子路径，并证明可见环境变量得以保留，而名称符合凭据模式的变量会被清除。`packages/cordis/repository-plugin/tests/repository-plugin.spec.ts` 锁定精确的 `prepack` 元数据和临时命令清理行为。`examples/headless-agent/tests/keyless-smoke.e2e.ts` 使签入仓库的已准备 fixture 继续符合该源格式契约。`apps/cli/tests/github-repository-plugin.built.e2e.ts` 是产品验收测试：全新的 DSH 主目录、精确且经过认证的私有 GitHub 源、实际构建产物的 `dsh run`、真实 headless 组合、mock LLM 请求观测，以及对已准备缓存的检查。
