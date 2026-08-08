# 持久 Web Schedule

[English](README.md) | 中文

此 overlay 让一个 `dsh web` 进程显式启用持久 Schedule 提醒，同时不改变交付的默认 Web 组合：

```sh
dsh web --patch examples/web-schedule/cordis.yml
```

当前 overlay 支持使用正整数 `after_seconds` 创建的一次性提醒。模型通过 `schedule_create`、`schedule_list` 和 `schedule_delete` 管理它们；每个结果都会把交付模式标为 `session-local`。

每条提醒由原 Session 日志拥有。live 根 Agent 会等待，在恢复 idle 后重试，并在 Web 会话中记录持久 dispatch 回执。关闭进程或让 Session 保持 cold 会停止内存 timer，但不会删除记录；重新打开同一个 Session 会恢复等待并交付逾期提醒。仅查看 cold 历史不会激活提醒，fork 也不会继承父 Session 的提醒。

创建和实际删除操作只有在 Session persistence 确认对应事件前缀后才会确认成功。提醒回执同样只在 dispatch 持久化后出现。Schedule 不提供浏览器、操作系统、邮件、短信或其他外部通知，best-effort 模型 follow-up 也不构成交付确认。

本层不接受绝对时间、固定间隔或 cron 规则。
