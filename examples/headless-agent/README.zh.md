# headless-agent

[English](README.md) | 中文

无头单次 agent（智能体）接线：DeepSeek V4 + 本地 bash 与文件系统工具 + subagent 委托 + 工作流与全新 agent Ralph 迭代 + `todo_write` + JSONL 持久化，并以 [`@deepseek-ai/dsh-cli-demo`](../../packages/examples/cli-demo) 作为应用入口。

## 运行

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:headless "fix the failing test in this workspace"
pnpm run demo:headless --output-format json -- "summarize the implementation"
pnpm run demo:headless --output-format stream-json -- "run the focused tests"
```

必须提供一个且仅一个非空的任务位置参数；含空格的任务需要加引号。没有 `-p` 标志。`text` 打印最后一条包含文本的 assistant 消息，`json` 打印一条 DSH 原生结果记录，`stream-json` 则在该记录之前发出顶层会话的规范任务轮次事件。子会话只通过父会话的工具事件和结果对外显示。

每次调用都会创建并持久化新会话，在一个轮次中运行所有模型和工具步骤，然后刷写持久化数据、执行 dispose（资源释放），再退出。这是非交互式自动化：没有提示符、批准、恢复、第二轮次或 stdin 上下文。已配置工具可以修改启动时所在的工作区、运行命令、spawn 子 agent，并消耗提供方 token。

## 高级配置

[`advanced.cordis.yml`](advanced.cordis.yml) 在已交付叶节点上添加 Code Mode 和 Cordis 工具。

这份包级 [CLI（命令行界面）契约](../../packages/examples/cli-demo/README.md) 说明输出记录、退出状态、取消、持久化以及模型／token 影响。
