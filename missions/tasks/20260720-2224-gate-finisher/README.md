# gate-finisher：pre-push 收口

一次性收口：verify-export-jsdoc 8 处违规补一行契约式 JSDoc（web-runtime fixture/fold-adapter、web-ui toolCardRegistry、apiproxy historyEntrySchema），连同前任留下的 zh 测试注记配对头改动合成一刀 commit `8972d0896`（--no-verify）；随后跑完整 check:pre-push 确认，不 push（用户亲自 push）。
