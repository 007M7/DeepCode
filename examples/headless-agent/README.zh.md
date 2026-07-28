# headless-agent

[English](README.md) | 中文

无头单次 agent（智能体）接线：DeepSeek V4 + 本地 bash 与文件系统工具 + subagent 委托 + 工作流与新 agent Ralph 迭代 + `todo_write` + JSONL 持久化，并以 [`@deepseek-ai/dsh-cli-demo`](../../packages/examples/cli-demo) 作为应用入口。

## 运行

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm run demo:headless "fix the failing test in this workspace"
pnpm run demo:headless --output-format json -- "summarize the implementation"
pnpm run demo:headless --output-format stream-json -- "run the focused tests"
```

必须提供且只能提供一个非空位置任务；含空格的任务需要加引号。没有 `-p` 标志。`text` 打印最后一条包含文本的 assistant 消息，`json` 打印一条 DSH 原生结果记录，`stream-json` 则在该记录之前发出顶层会话的规范任务轮次事件。子会话只通过父工具事件和结果对外显示。

每次调用都会创建并持久化新会话，在一个轮次中运行所有模型和工具步骤，然后刷新、释放并退出。这是非交互式自动化：没有提示符、批准、恢复、第二轮次或 stdin 上下文。已配置工具可以修改启动 workspace、运行命令、spawn 子 agent，并消耗提供方 token。

## E2B POC overlay

[`e2b.cordis.yml`](e2b.cordis.yml) 使用一个共享 E2B 沙箱替换本地文件系统与进程管理提供方，同时保留 `dsh-bash-local` 和相同的面向模型工具。请在 git 忽略的根目录 `.env` 中，将 `E2B_API_KEY` 与 `DEEPSEEK_API_KEY` 放在一起，然后运行：

```sh
pnpm run demo:e2b "create hello.txt, read it back, and run pwd"
```

该 overlay 会在沙箱中创建拼写相同的绝对 cwd，但不会上传或挂载宿主工作区。文件与 Bash 变更只存在于 E2B；Cordis、模型调用、agent／会话状态、会话日志、skill（技能）和 SDK 缓冲仍在宿主上。演示会在超时和资源释放时终止其沙箱。它是提供方组合 POC，而不是完整 harness 迁移或工作区同步功能。

## 高级与快照接线

[`advanced.cordis.yml`](advanced.cordis.yml) 在已交付叶节点上添加 Code Mode 和 Cordis 工具。[`advanced.cordis.snapshot.yml`](advanced.cordis.snapshot.yml) 只将实时 LLM（大语言模型）替换为回放。[`tests/`](tests/) 下的测试拥有无密钥真实 Loader 冒烟测试、密钥门控的外部状态验证冒烟测试，以及带父子会话 fixture（测试前置数据）的 `stream-json` 回放快照。

包级 [CLI 契约](../../packages/examples/cli-demo/README.md)记录输出记录、退出状态、取消、持久化以及模型／token 影响。
