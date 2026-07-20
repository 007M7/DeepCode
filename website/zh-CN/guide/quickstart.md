# 快速开始

本指南带你在 5 分钟内跑起一个 Agent。

## 环境准备

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/) >= 9

```sh
# 确认版本
node -v   # v24.x 或更高
pnpm -v   # 9.x 或更高
```

## 第一步：运行 echo-agent

echo-agent 不需要 API key，装好依赖就能跑。

```sh
# 克隆仓库
git clone https://github.com/deepseek-harness/deepseek-harness.git
cd deepseek-harness

# 安装依赖
pnpm install
# 如果看到 ERR_PNPM_IGNORED_BUILDS，可以忽略——安装已经成功了。
# 想消除这个提示可以跑一次: pnpm approve-builds

# 启动 echo-agent
pnpm run demo:echo
```

启动后你会看到：

```
echo-agent ready. Type a message ("echo <text>" triggers the tool).
>
```

试着输入：

```
> echo hello world
```

你会看到模型发起了一次 tool call（工具调用），echo 工具将文本转为大写并返回：

```
[tool call] echo({"text":"hello world"})
[tool result] ECHO: HELLO WORLD
```

恭喜！环境没问题。

## 第二步：使用真实模型调用

接下来接入真实的 DeepSeek 模型，跑一个完整的命令行 Agent。

### 获取 API Key

前往 [DeepSeek Platform](https://platform.deepseek.com/) 获取你的 API key。

### 配置环境变量

在仓库根目录创建 `.env` 文件（已被 gitignore）：

```sh
DEEPSEEK_API_KEY=sk-your-key-here
```

### 启动 repl-agent

```sh
pnpm run demo:repl
```

```
agent REPL ready. Give it a coding task.
>
```

这就是一个完整的编程助手，它能读写文件、跑命令、拆分子任务。

试着给它一个任务：

```
> 在当前目录创建一个 hello.js，内容是打印 "Hello from Harness!"，然后运行它
```

## 回头看

echo-agent 和 repl-agent 用的是同一个应用框架(`@deepseek-ai/dsh-stdio-demo`)，区别只在 `cordis.yml`——换了哪些插件、填了什么配置。你以后定制自己的 Agent 也是同样的方式。

## 下一步

- [配置文件](config) — 了解 `cordis.yml` 的完整语法
- [开发插件](../develop/basic/) — 编写你自己的 tool 或后端
