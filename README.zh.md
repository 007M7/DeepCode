# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是一款基于 DeepSeek Harness SDK 构建的开源 coding agent（智能体）。

它采用了**一切皆插件**的架构。

## 内测声明

DeepSeek Harness 正处于内部测试阶段，功能和接口可能发生变化。

为帮助诊断上报的问题，内测版本默认上传所有会话日志。设置 `DSH_TELEMETRY_DISABLED=1` 可关闭遥测。请通过内部企业微信群反馈问题和建议。

## 运行

安装 Node.js ^22.19 或 >= 24 和 pnpm 11，然后运行已发布的包：

```sh
npx @deepseek-ai/dsh web
```

该命令会初始化 Web profile 并打印 Web UI 地址，默认地址为 `http://127.0.0.1:3080`。打开该地址，在**设置 → 模型**中添加 DeepSeek API 密钥，然后启动一个会话。调用目录是默认工作区；你可以尝试输入 `Summarize this repository and identify its main packages.`。

下一步请阅读 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

如需改为运行仓库 checkout：

```sh
git clone https://github.com/deepseek-harness/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm dsh web
```

最后一条命令会构建仓库，并进入相同的 Web UI 路径。

## Profile 与插件

profile 是按顺序排列的插件 bundle 列表。随附的 `web` profile 为 `dsh web` 提供功能。使用 `dsh plugin --profile <name> <pnpm args>` 管理 profile；该命令会在对应 profile 目录中将剩余参数转发给 pnpm：

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add <package>
npx -p @deepseek-ai/dsh dsh plugin --profile web remove <package>
```

`add`、`remove`、`update`、`why` 等 pnpm 命令均可直接使用。该命令会先初始化不存在的 profile，再修改其中的包，并根据声明了 `dsh.bundle` 的已安装包更新 bundle 列表。准确行为见 [CLI 参考](apps/cli/reference/README.md#plugin-management)。

[CLI（命令行界面）参考](apps/cli/README.md)介绍 headless 执行与自定义 profile。[Python SDK](python/README.md) 和[示例](examples/README.md)介绍程序化组合与自定义组合。

## 社区

扫描二维码，或打开 <a href="https://wj.qq.com/s2/27234598/03eb/">DeepSeek Harness 微信社区申请页面</a> 申请加入。

<p>
  <img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 微信社区二维码" width="240">
</p>

## 开发

请先阅读[开发指南](docs/development.md)；修改包之前，请阅读[架构文档](docs/architecture.md)。

面向 agent：遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[BSD 3-Clause](LICENSE)

第三方依赖及其许可证在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中披露。

## 参与贡献

向本仓库贡献前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
