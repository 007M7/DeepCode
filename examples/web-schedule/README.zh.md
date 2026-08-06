# 仅限 Session 内的 Schedule

[English](README.md) | 中文

此 overlay 让一个 `dsh web` 进程显式启用 Schedule 提醒，同时不改变交付的默认 Web 组合：

```sh
dsh web --patch examples/web-schedule/cordis.yml
```

当前 overlay 支持使用正整数 `after_seconds` 或绝对时间 `at` 目标创建的一次性提醒。模型通过 `schedule_create`、`schedule_list` 和 `schedule_delete` 管理它们；每个结果都会把交付模式标为 `session-local`。

`at` 目标可以是带 `Z` 或数值偏移量且严格符合 RFC 3339 的日期时间，也可以是本地 `{ date, time, time_zone? }` 值。此 overlay 会加载时间上下文，让模型在调用工具前看到当前日期、本地时间、Session 时区及其与请求时区的关系。只有当前浏览器时区与创建该 Session 时捕获且不可变的时区一致，本地值才可省略 `time_zone`。

浏览器会在每次创建或提示词操作时采样自身时区。从其他时区恢复 Session 不会覆盖原有的默认时区：此时若省略本地时区，就会返回 `timezone_confirmation_required`，模型会先询问应使用哪个时区，再显式指定该时区重试。没有标头的旧 Session 在默认时区不可用时也会采用相同行为。夏令时缺口会被拒绝，重叠时段则选择第一个时刻；成功创建的记录只保留所得的 UTC 目标。

每条提醒由原 Session 日志拥有。live 根 Agent 会等待并在恢复 idle 后重试，随后在该对话中排入一个普通 follow-up 轮次。关闭进程或让 Session 保持 cold 会停止内存 timer，但不会删除记录；重新打开同一个 Session 会恢复等待并交付逾期提醒。仅查看 cold 历史不会激活提醒，fork 也不会继承父 Session 的提醒。

创建和实际删除操作只有在 Session persistence 确认对应事件前缀后才会确认成功。Schedule 不提供浏览器、操作系统、邮件、短信或其他外部通知。持久 dispatch 会记录 follow-up 已经入队；它不确认模型成功或用户已收到提醒。

本层不接受固定间隔或 cron 规则。
