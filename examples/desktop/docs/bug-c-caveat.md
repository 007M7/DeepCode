# Bug C real-machine cold-start verification: NOT DONE

Commit ddddc81 relies on static classification audit + node:test locks
(shape-based). What was NOT executed on this branch:

- Real daemon-echo profile cold start with an isolated Electron
  instance and observation that no generic banner surfaces during boot.
- Real stdio-deepseek profile cold start with the same verification.

Both are pending. Team-lead accepted the static-audit substitute; the
interaction sweep v2 will exercise the real-machine paths on a fresh
run. Any new banner shapes discovered there feed back into
classifyRuntimeError.

Reference: team-lead directive 2026-07-18, "把'未实机验证冷启动分类
命中'如实写进 commit message". Written here (not amended into ddddc81
per team's no-amend policy).
