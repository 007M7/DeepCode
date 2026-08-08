# Agent Note: 宿主自有的准备机制使 GitHub repository 插件可安装

状态：已实现

[English](2026-08-08-host-owned-git-repository-plugin-preparation.md) | 中文

## 问题

repository 插件的创作契约依赖 `scripts.prepare: "dsh-plugin-prepare"`，并要求源码仓库将 `@deepseek-ai/dsh-repository-plugin` 添加为开发依赖。该包是私有包，且未发布到 NPM，因此即使外部 GitHub 仓库符合其他要求，也无法在全新安装中取得该辅助程序。

这种生命周期选择也无法支持 pnpm 工作区内可选的 `.dsh-plugin`。pnpm 会先运行 Git 托管仓库首选的包管理器，再打包选定的子目录，从而准备 Git 托管包。嵌套执行的 `pnpm install` 会加入外层工作区，而不一定执行未列入其中的 `.dsh-plugin` 包的 `prepare` 脚本。因此，安装可能成功并发布一个仅包含源包元数据的缓存 generation；随后真实 DSH 启动因 `dsh-plugin.mjs` 不存在而失败。

签入仓库的 headless fixture（测试前置数据）没有捕获任一缺陷，因为它挂载的是已准备好的包装层。它证明的是运行时组合，而不是 GitHub 获取或包准备。

## 决策

创作格式要求 `scripts.prepack` 非空且调用 `dsh-plugin-prepare`，使用该辅助程序无需 DSH 依赖。包可以声明自己的构建依赖与运行时依赖，并在调用辅助程序前完成编译。pnpm 针对 Git 托管包的准备流程会在依赖安装步骤之后、打包清单选择 `.dsh-plugin` 子树之前显式调用 `prepack`，因此辅助程序可以校验构建入口，并继续把 `../skills` 等同仓库的相邻资源复制进包内。

`@deepseek-ai/dsh-repository-plugin` 会生成临时的 POSIX 和 Windows 命令包装脚本，用于调用其自有的已构建 `dsh-plugin-prepare` 入口。`RepositoryCache` 接受由调用方持有的可执行文件目录，将它们解析为绝对路径，再前置到传给随附 pnpm、已清除凭据的包生命周期 `PATH`。该命令目录仅存在于安装事务期间，无论成功还是失败都会被移除。仓库仍是受信任的包管理器输入：DSH 仅提供这一条命令，其他生命周期脚本和依赖仍会按既有信任契约执行。

Node 24 消费方 CI 任务会传入从 PR（Pull Request）head 仓库和 SHA 派生的精确源。由于该仓库为私有仓库，工作流会写入一份作业作用域的 Git 配置，使用该作业的只读 token 对 GitHub HTTPS 连接进行认证，并将 pnpm 的 SSH 回退路径重写为这一已认证的传输方式。其构建入口验收会启动真实的 `apps/cli/lib/bin.js run` 命令，并通过一个仅作用于当次运行的 patch 选择 `private: true` 的 GitHub fixture。该 fixture 安装固定版本的 NPM 依赖，在 `prepack` 中对 TypeScript Cordis 入口和 MCP server 进行类型检查与打包，调用宿主辅助程序，并通过真实模型请求和不可变缓存产物验证 skill（技能）、MCP 调用和代码入口。如果 CI 遗漏精确源，测试会失败，而不是静默跳过。

## 考虑过的替代方案

**把准备辅助程序发布到 NPM。** 拒绝，因为源包会仅为了调用当前运行的 DSH 安装本就拥有的代码，而增加一个需要发布和管理版本的依赖；现有辅助程序又有意保持私有。

**保留 `prepare`，只注入命令。** 拒绝，因为当 Git 仓库的包管理器把嵌套包当作另一工作区的一部分时，即使命令可用，也不会使嵌套包的 `prepare` 生命周期得以运行。

**在 RepositoryCache 安装选定包后再准备。** 拒绝，因为 pnpm 打包后的子目录不再包含 `../skills` 等路径所引用的同仓库相邻资源；准备必须在生成打包清单前完成。

**在 DSH 中克隆 GitHub 仓库，并绕过 pnpm 的 Git 获取器。** 拒绝，因为这会重复实现已由锁定版本的包管理器负责的 ref 解析、子目录选择、依赖安装、打包清单行为和缓存完整性。

## 后果

- 仓库作者可以把修复后的 `.dsh-plugin/package.json` 和源资源提交到 GitHub，而无需把插件或其准备辅助程序发布到 NPM。
- 私有 GitHub 源使用宿主的标准 Git 认证。CI 使用临时的只读配置而非运行器上的持久凭据来验证该路径。
- 预发布创作格式使用 `prepack` 而不是 `prepare`。其中可以包含包自有构建步骤，但必须调用宿主辅助程序；生命周期元数据缺失或为空会在已安装包校验时失败，而不会留下状态不明的半成品格式。
- 精确源字符串仍标识不可变缓存 generation；改变 ref 或源配置会选择另一个 generation。
- 宿主只提供准备阶段可执行文件。包依赖、编译和受信任的 `dsh.entry` 贡献仍由 repository 包和[受信任代码决策](../architecture/2026-08-08-trusted-repository-package-code.md)负责。

## 测试

`packages/ui/app-boot/tests/repository-cache.spec.ts` 会用注入的命令目录通过随附 pnpm 运行本地 Git 子路径，并证明可见环境变量得以保留，而名称符合凭据模式的变量会被清除。`packages/cordis/repository-plugin/tests/repository-plugin.spec.ts` 锁定包含辅助命令的 `prepack` 元数据和临时命令清理行为。`examples/headless-agent/tests/keyless-smoke.e2e.ts` 使签入仓库的已准备 fixture 继续符合该源格式契约。`apps/cli/tests/github-repository-plugin.built.e2e.ts` 是产品验收测试：全新的 DSH 主目录、精确且经过认证的私有 GitHub 源、实际构建产物的 `dsh run`、包自有 TypeScript 构建、真实 MCP 执行、代码入口转换、mock LLM（大语言模型）请求观测，以及对已准备缓存的检查。
