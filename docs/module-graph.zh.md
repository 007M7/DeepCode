<!-- 英文源文件由 scripts/gen-module-graph.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-module-graph` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/module-graph.md` 重新记录配对。 -->

# 模块依赖关系图

[English](module-graph.md) | 中文

`@deepseek-ai/dsh-*` harness 包之间的依赖关系。该关系图根据各包的 `peerDependencies`（规范的运行时依赖信号）生成，并按 `packages/<group>/<pkg>` 层级分组。边 `a --> b` 表示包 `a` 依赖包 `b`。名称中的 `@deepseek-ai/dsh-` 前缀已移除。

```mermaid
flowchart TD
  subgraph group_util["packages/util"]
    pkg_atomic_write["atomic-write"]
    pkg_brand["brand"]
    pkg_environment["environment"]
    pkg_native_command["native-command"]
    pkg_paths["paths"]
    pkg_retention["retention"]
    pkg_timeout["timeout"]
  end
  subgraph group_llm["packages/llm"]
    pkg_llm["llm"]
    pkg_llm_deepseek["llm-deepseek"]
    pkg_llm_pi_ai["llm-pi-ai"]
    pkg_llm_retry["llm-retry"]
    pkg_token_meter["token-meter"]
  end
  subgraph group_core["packages/core"]
    pkg_agent["agent"]
    pkg_agent_loop["agent-loop"]
    pkg_scope["scope"]
    pkg_session["session"]
    pkg_system_prompt["system-prompt"]
    pkg_tools["tools"]
  end
  subgraph group_goal["packages/goal"]
    pkg_command_goal["command-goal"]
    pkg_goal["goal"]
    pkg_goal_session["goal-session"]
    pkg_tool_goal["tool-goal"]
  end
  subgraph group_bash["packages/bash"]
    pkg_bash["bash"]
    pkg_bash_env["bash-env"]
    pkg_bash_local["bash-local"]
    pkg_bash_sandbox["bash-sandbox"]
    pkg_pwsh_local["pwsh-local"]
    pkg_tool_bash["tool-bash"]
    pkg_tool_pwsh["tool-pwsh"]
  end
  subgraph group_fs["packages/fs"]
    pkg_fs["fs"]
    pkg_fs_local["fs-local"]
    pkg_fs_policy["fs-policy"]
    pkg_fs_sandbox["fs-sandbox"]
    pkg_tool_fs["tool-fs"]
    pkg_tool_fs_search["tool-fs-search"]
    pkg_tool_str_replace_editor["tool-str-replace-editor"]
  end
  subgraph group_skill["packages/skill"]
    pkg_skill["skill"]
    pkg_skill_badge["skill-badge"]
    pkg_skill_local["skill-local"]
    pkg_tool_skill["tool-skill"]
  end
  subgraph group_compact["packages/compact"]
    pkg_command_compact["command-compact"]
    pkg_compact["compact"]
    pkg_compact_basic["compact-basic"]
    pkg_compact_tool_result_prune["compact-tool-result-prune"]
  end
  subgraph group_subagent["packages/subagent"]
    pkg_subagent["subagent"]
    pkg_subagent_acp["subagent-acp"]
    pkg_subagent_claude_code["subagent-claude-code"]
    pkg_subagent_codex["subagent-codex"]
    pkg_subagent_dsh_sdk["subagent-dsh-sdk"]
    pkg_subagent_fork["subagent-fork"]
    pkg_subagent_inprocess["subagent-inprocess"]
    pkg_subagent_spawn["subagent-spawn"]
    pkg_tool_subagent["tool-subagent"]
    pkg_tool_subagent_control["tool-subagent-control"]
    pkg_tool_subagent_report["tool-subagent-report"]
  end
  subgraph group_web["packages/web"]
    pkg_tool_web["tool-web"]
    pkg_web["web"]
    pkg_web_fetch_local["web-fetch-local"]
    pkg_web_search_deepseek["web-search-deepseek"]
    pkg_web_search_exa["web-search-exa"]
    pkg_web_search_perplexity["web-search-perplexity"]
  end
  subgraph group_spill["packages/spill"]
    pkg_spill["spill"]
    pkg_spill_local["spill-local"]
    pkg_spill_policy["spill-policy"]
  end
  subgraph group_todo["packages/todo"]
    pkg_tool_todo["tool-todo"]
  end
  subgraph group_plan["packages/plan"]
    pkg_plan_mode["plan-mode"]
  end
  subgraph group_hooks["packages/hooks"]
    pkg_hook_protocol["hook-protocol"]
    pkg_hooks_claude["hooks-claude"]
    pkg_hooks_codex["hooks-codex"]
  end
  subgraph group_session_query["packages/session-query"]
    pkg_session_query["session-query"]
    pkg_session_query_sqlite["session-query-sqlite"]
    pkg_tool_session_query["tool-session-query"]
  end
  subgraph group_support["packages/support"]
    pkg_acp_snapshot["acp-snapshot"]
    pkg_agent_loop_testkit["agent-loop-testkit"]
    pkg_invariants["invariants"]
    pkg_llm_mock_server["llm-mock-server"]
    pkg_llm_replay["llm-replay"]
    pkg_loader_smoke["loader-smoke"]
  end
  subgraph group_acp["packages/acp"]
    pkg_acp["acp"]
  end
  subgraph group_api["packages/api"]
    pkg_api_gateway["api-gateway"]
    pkg_api_remotes["api-remotes"]
  end
  subgraph group_boot["packages/boot"]
    pkg_app_boot["app-boot"]
  end
  subgraph group_bundle["packages/bundle"]
    pkg_base["base"]
    pkg_headless["headless"]
    pkg_web_app["web-app"]
  end
  subgraph group_client["packages/client"]
    pkg_client_connection["client-connection"]
    pkg_client_hmr["client-hmr"]
    pkg_client_locale["client-locale"]
    pkg_client_modules["client-modules"]
    pkg_client_runtime["client-runtime"]
    pkg_client_schema_form["client-schema-form"]
    pkg_client_test_runtime["client-test-runtime"]
    pkg_client_ui_command["client-ui-command"]
    pkg_client_ui_conversation["client-ui-conversation"]
    pkg_client_ui_deliverables["client-ui-deliverables"]
    pkg_client_ui_goal["client-ui-goal"]
    pkg_client_ui_layout["client-ui-layout"]
    pkg_client_ui_model["client-ui-model"]
    pkg_client_ui_models["client-ui-models"]
    pkg_client_ui_permission["client-ui-permission"]
    pkg_client_ui_plan["client-ui-plan"]
    pkg_client_ui_primitives["client-ui-primitives"]
    pkg_client_ui_question["client-ui-question"]
    pkg_client_ui_settings["client-ui-settings"]
    pkg_client_ui_settings_general["client-ui-settings-general"]
    pkg_client_ui_sidebar["client-ui-sidebar"]
    pkg_client_ui_skill["client-ui-skill"]
    pkg_client_ui_slash["client-ui-slash"]
    pkg_client_ui_slots["client-ui-slots"]
    pkg_client_ui_subagent["client-ui-subagent"]
    pkg_client_ui_theme["client-ui-theme"]
    pkg_client_ui_tool["client-ui-tool"]
    pkg_client_ui_trajectory["client-ui-trajectory"]
    pkg_client_ui_workspace["client-ui-workspace"]
    pkg_client_web["client-web"]
    pkg_client_web_react["client-web-react"]
  end
  subgraph group_code_runtime["packages/code-runtime"]
    pkg_code_runtime["code-runtime"]
    pkg_code_runtime_worker["code-runtime-worker"]
  end
  subgraph group_context["packages/context"]
    pkg_session_reference["session-reference"]
    pkg_time_context["time-context"]
    pkg_tmux_context["tmux-context"]
    pkg_workspace_context["workspace-context"]
  end
  subgraph group_credentials["packages/credentials"]
    pkg_credentials["credentials"]
    pkg_credentials_local["credentials-local"]
  end
  subgraph group_e2b["packages/e2b"]
    pkg_e2b["e2b"]
    pkg_fs_e2b["fs-e2b"]
    pkg_subprocess_e2b["subprocess-e2b"]
  end
  subgraph group_examples["packages/examples"]
    pkg_acp_demo["acp-demo"]
    pkg_agent_spine_demo["agent-spine-demo"]
    pkg_jsonrpc_demo["jsonrpc-demo"]
  end
  subgraph group_feedback["packages/feedback"]
    pkg_command_feedback["command-feedback"]
  end
  subgraph group_guard["packages/guard"]
    pkg_repeat_tool_guard["repeat-tool-guard"]
    pkg_timeout_policy["timeout-policy"]
  end
  subgraph group_host["packages/host"]
    pkg_frontend_static["frontend-static"]
    pkg_host_apiproxy["host-apiproxy"]
    pkg_host_directory_picker["host-directory-picker"]
    pkg_host_directory_picker_auto["host-directory-picker-auto"]
    pkg_host_directory_picker_browse["host-directory-picker-browse"]
    pkg_host_directory_picker_native["host-directory-picker-native"]
    pkg_host_webserver["host-webserver"]
  end
  subgraph group_interaction["packages/interaction"]
    pkg_commands["commands"]
    pkg_permission["permission"]
    pkg_tool_ask_user["tool-ask-user"]
    pkg_user_approval["user-approval"]
    pkg_user_interaction["user-interaction"]
  end
  subgraph group_lsp["packages/lsp"]
    pkg_lsp["lsp"]
    pkg_lsp_local["lsp-local"]
    pkg_tool_lsp["tool-lsp"]
  end
  subgraph group_mcp["packages/mcp"]
    pkg_mcp_client["mcp-client"]
  end
  subgraph group_pty["packages/pty"]
    pkg_pty["pty"]
    pkg_pty_local["pty-local"]
    pkg_tool_bash_persistent["tool-bash-persistent"]
    pkg_tool_pty["tool-pty"]
  end
  subgraph group_sandbox["packages/sandbox"]
    pkg_sandbox["sandbox"]
    pkg_sandbox_local["sandbox-local"]
    pkg_sandbox_policy["sandbox-policy"]
  end
  subgraph group_scaffold["packages/scaffold"]
    pkg_helper["helper"]
    pkg_jsonrpc["jsonrpc"]
    pkg_scripts["scripts"]
    pkg_sdk_client["sdk-client"]
    pkg_sdk_protocol["sdk-protocol"]
    pkg_telemetry["telemetry"]
  end
  subgraph group_self_modification["packages/self-modification"]
    pkg_repository_plugin["repository-plugin"]
    pkg_tool_cordis["tool-cordis"]
  end
  subgraph group_session["packages/session"]
    pkg_session_checkpoint_policy["session-checkpoint-policy"]
    pkg_session_persistence["session-persistence"]
    pkg_session_persistence_jsonl["session-persistence-jsonl"]
    pkg_session_persistence_sqlite["session-persistence-sqlite"]
    pkg_session_projection["session-projection"]
    pkg_session_projection_cache["session-projection-cache"]
    pkg_session_telemetry["session-telemetry"]
    pkg_session_telemetry_otel["session-telemetry-otel"]
    pkg_session_title["session-title"]
    pkg_session_title_all_messages_llm["session-title-all-messages-llm"]
    pkg_session_title_first_message_llm["session-title-first-message-llm"]
    pkg_session_title_llm["session-title-llm"]
  end
  subgraph group_settings["packages/settings"]
    pkg_settings["settings"]
    pkg_settings_local["settings-local"]
  end
  subgraph group_storage["packages/storage"]
    pkg_storage["storage"]
    pkg_storage_domain["storage-domain"]
    pkg_storage_json["storage-json"]
    pkg_storage_sqlite["storage-sqlite"]
  end
  subgraph group_subprocess["packages/subprocess"]
    pkg_subprocess["subprocess"]
    pkg_subprocess_local["subprocess-local"]
  end
  subgraph group_tasks["packages/tasks"]
    pkg_tasks["tasks"]
    pkg_tasks_local["tasks-local"]
    pkg_tool_tasks["tool-tasks"]
  end
  subgraph group_typert["packages/typert"]
    pkg_type_meta["type-meta"]
    pkg_typert_generator["typert-generator"]
    pkg_typert_loader["typert-loader"]
    pkg_typert_registry["typert-registry"]
  end
  subgraph group_workflow["packages/workflow"]
    pkg_tool_ralph["tool-ralph"]
    pkg_tool_workflow["tool-workflow"]
    pkg_workflow["workflow"]
    pkg_workflow_workerthread["workflow-workerthread"]
  end
  subgraph group_workspace["packages/workspace"]
    pkg_workspace["workspace"]
  end
  pkg_atomic_write --> pkg_invariants
  pkg_brand --> pkg_invariants
  pkg_environment --> pkg_invariants
  pkg_native_command --> pkg_invariants
  pkg_paths --> pkg_invariants
  pkg_retention --> pkg_invariants
  pkg_timeout --> pkg_invariants
  pkg_scope --> pkg_invariants
  pkg_llm_mock_server --> pkg_invariants
  pkg_base --> pkg_invariants
  pkg_client_modules --> pkg_invariants
  pkg_client_schema_form --> pkg_invariants
  pkg_client_ui_primitives --> pkg_invariants
  pkg_client_ui_slots --> pkg_invariants
  pkg_client_web --> pkg_invariants
  pkg_client_web_react --> pkg_invariants
  pkg_code_runtime --> pkg_invariants
  pkg_e2b --> pkg_invariants
  pkg_jsonrpc_demo --> pkg_invariants
  pkg_host_apiproxy --> pkg_invariants
  pkg_host_directory_picker --> pkg_invariants
  pkg_host_webserver --> pkg_invariants
  pkg_storage --> pkg_invariants
  pkg_subprocess --> pkg_invariants
  pkg_type_meta --> pkg_invariants
  pkg_typert_generator --> pkg_invariants
  pkg_typert_registry --> pkg_invariants
  pkg_llm --> pkg_brand
  pkg_llm --> pkg_invariants
  pkg_llm --> pkg_timeout
  pkg_client_connection --> pkg_host_webserver
  pkg_client_connection --> pkg_invariants
  pkg_client_hmr --> pkg_client_modules
  pkg_client_hmr --> pkg_host_webserver
  pkg_client_hmr --> pkg_invariants
  pkg_client_runtime --> pkg_invariants
  pkg_client_runtime --> pkg_type_meta
  pkg_client_runtime --> pkg_typert_registry
  pkg_credentials --> pkg_brand
  pkg_credentials --> pkg_invariants
  pkg_subprocess_e2b --> pkg_e2b
  pkg_subprocess_e2b --> pkg_invariants
  pkg_subprocess_e2b --> pkg_subprocess
  pkg_subprocess_e2b --> pkg_timeout
  pkg_frontend_static --> pkg_host_webserver
  pkg_frontend_static --> pkg_invariants
  pkg_helper --> pkg_brand
  pkg_helper --> pkg_invariants
  pkg_helper --> pkg_subprocess
  pkg_telemetry --> pkg_brand
  pkg_telemetry --> pkg_invariants
  pkg_telemetry --> pkg_paths
  pkg_settings --> pkg_brand
  pkg_settings --> pkg_invariants
  pkg_storage_domain --> pkg_invariants
  pkg_storage_domain --> pkg_storage
  pkg_storage_json --> pkg_invariants
  pkg_storage_json --> pkg_storage
  pkg_storage_sqlite --> pkg_invariants
  pkg_storage_sqlite --> pkg_storage
  pkg_subprocess_local --> pkg_invariants
  pkg_subprocess_local --> pkg_subprocess
  pkg_subprocess_local --> pkg_timeout
  pkg_typert_loader --> pkg_invariants
  pkg_typert_loader --> pkg_typert_registry
  pkg_llm_deepseek --> pkg_credentials
  pkg_llm_deepseek --> pkg_environment
  pkg_llm_deepseek --> pkg_invariants
  pkg_llm_deepseek --> pkg_llm
  pkg_llm_deepseek --> pkg_settings
  pkg_llm_deepseek --> pkg_timeout
  pkg_llm_pi_ai --> pkg_credentials
  pkg_llm_pi_ai --> pkg_environment
  pkg_llm_pi_ai --> pkg_invariants
  pkg_llm_pi_ai --> pkg_llm
  pkg_llm_pi_ai --> pkg_settings
  pkg_llm_pi_ai --> pkg_timeout
  pkg_session --> pkg_brand
  pkg_session --> pkg_invariants
  pkg_session --> pkg_llm
  pkg_session --> pkg_scope
  pkg_session --> pkg_type_meta
  pkg_system_prompt --> pkg_invariants
  pkg_system_prompt --> pkg_llm
  pkg_system_prompt --> pkg_scope
  pkg_skill --> pkg_invariants
  pkg_skill --> pkg_llm
  pkg_web --> pkg_invariants
  pkg_web --> pkg_llm
  pkg_api_gateway --> pkg_client_connection
  pkg_api_gateway --> pkg_invariants
  pkg_api_gateway --> pkg_typert_registry
  pkg_client_locale --> pkg_client_runtime
  pkg_client_locale --> pkg_client_ui_primitives
  pkg_client_locale --> pkg_client_ui_slots
  pkg_client_locale --> pkg_invariants
  pkg_client_test_runtime --> pkg_client_runtime
  pkg_client_test_runtime --> pkg_client_ui_slots
  pkg_client_test_runtime --> pkg_client_web_react
  pkg_client_test_runtime --> pkg_host_apiproxy
  pkg_client_test_runtime --> pkg_invariants
  pkg_client_ui_models --> pkg_client_connection
  pkg_client_ui_models --> pkg_client_runtime
  pkg_client_ui_models --> pkg_client_schema_form
  pkg_client_ui_models --> pkg_client_ui_primitives
  pkg_client_ui_models --> pkg_client_ui_slots
  pkg_client_ui_models --> pkg_client_web_react
  pkg_client_ui_models --> pkg_invariants
  pkg_client_ui_settings --> pkg_client_runtime
  pkg_client_ui_settings --> pkg_client_ui_primitives
  pkg_client_ui_settings --> pkg_client_ui_slots
  pkg_client_ui_settings --> pkg_invariants
  pkg_client_ui_trajectory --> pkg_client_runtime
  pkg_client_ui_trajectory --> pkg_client_ui_primitives
  pkg_client_ui_trajectory --> pkg_invariants
  pkg_credentials_local --> pkg_atomic_write
  pkg_credentials_local --> pkg_credentials
  pkg_credentials_local --> pkg_environment
  pkg_credentials_local --> pkg_invariants
  pkg_credentials_local --> pkg_paths
  pkg_lsp --> pkg_brand
  pkg_lsp --> pkg_invariants
  pkg_lsp --> pkg_llm
  pkg_sandbox --> pkg_invariants
  pkg_sandbox --> pkg_llm
  pkg_settings_local --> pkg_atomic_write
  pkg_settings_local --> pkg_invariants
  pkg_settings_local --> pkg_paths
  pkg_settings_local --> pkg_settings
  pkg_agent --> pkg_invariants
  pkg_agent --> pkg_llm
  pkg_agent --> pkg_scope
  pkg_agent --> pkg_session
  pkg_agent --> pkg_system_prompt
  pkg_agent --> pkg_type_meta
  pkg_bash --> pkg_invariants
  pkg_bash --> pkg_sandbox
  pkg_bash --> pkg_subprocess
  pkg_fs --> pkg_brand
  pkg_fs --> pkg_invariants
  pkg_fs --> pkg_llm
  pkg_fs --> pkg_sandbox
  pkg_skill_badge --> pkg_invariants
  pkg_skill_badge --> pkg_skill
  pkg_compact --> pkg_invariants
  pkg_compact --> pkg_llm
  pkg_compact --> pkg_session
  pkg_web_fetch_local --> pkg_invariants
  pkg_web_fetch_local --> pkg_timeout
  pkg_web_fetch_local --> pkg_web
  pkg_web_search_exa --> pkg_environment
  pkg_web_search_exa --> pkg_invariants
  pkg_web_search_exa --> pkg_web
  pkg_web_search_perplexity --> pkg_environment
  pkg_web_search_perplexity --> pkg_invariants
  pkg_web_search_perplexity --> pkg_web
  pkg_spill --> pkg_brand
  pkg_spill --> pkg_invariants
  pkg_spill --> pkg_llm
  pkg_spill --> pkg_session
  pkg_acp_snapshot --> pkg_invariants
  pkg_acp_snapshot --> pkg_session
  pkg_app_boot --> pkg_environment
  pkg_app_boot --> pkg_invariants
  pkg_app_boot --> pkg_paths
  pkg_app_boot --> pkg_system_prompt
  pkg_client_ui_question --> pkg_client_locale
  pkg_client_ui_question --> pkg_invariants
  pkg_client_ui_settings_general --> pkg_client_connection
  pkg_client_ui_settings_general --> pkg_client_locale
  pkg_client_ui_settings_general --> pkg_client_runtime
  pkg_client_ui_settings_general --> pkg_client_ui_primitives
  pkg_client_ui_settings_general --> pkg_client_ui_settings
  pkg_client_ui_settings_general --> pkg_client_ui_slots
  pkg_client_ui_settings_general --> pkg_client_web_react
  pkg_client_ui_settings_general --> pkg_invariants
  pkg_client_ui_sidebar --> pkg_client_locale
  pkg_client_ui_sidebar --> pkg_client_runtime
  pkg_client_ui_sidebar --> pkg_client_ui_primitives
  pkg_client_ui_sidebar --> pkg_client_ui_slots
  pkg_client_ui_sidebar --> pkg_invariants
  pkg_client_ui_slash --> pkg_client_locale
  pkg_client_ui_slash --> pkg_client_runtime
  pkg_client_ui_slash --> pkg_client_ui_primitives
  pkg_client_ui_slash --> pkg_client_ui_slots
  pkg_client_ui_slash --> pkg_invariants
  pkg_client_ui_theme --> pkg_client_locale
  pkg_client_ui_theme --> pkg_client_runtime
  pkg_client_ui_theme --> pkg_client_ui_primitives
  pkg_client_ui_theme --> pkg_client_ui_slots
  pkg_client_ui_theme --> pkg_invariants
  pkg_client_ui_workspace --> pkg_client_locale
  pkg_client_ui_workspace --> pkg_client_runtime
  pkg_client_ui_workspace --> pkg_client_ui_primitives
  pkg_client_ui_workspace --> pkg_client_ui_slots
  pkg_client_ui_workspace --> pkg_invariants
  pkg_code_runtime_worker --> pkg_code_runtime
  pkg_code_runtime_worker --> pkg_invariants
  pkg_code_runtime_worker --> pkg_session
  pkg_code_runtime_worker --> pkg_timeout
  pkg_sandbox_local --> pkg_invariants
  pkg_sandbox_local --> pkg_llm
  pkg_sandbox_local --> pkg_sandbox
  pkg_session_persistence --> pkg_brand
  pkg_session_persistence --> pkg_invariants
  pkg_session_persistence --> pkg_session
  pkg_session_persistence --> pkg_timeout
  pkg_session_projection --> pkg_invariants
  pkg_session_projection --> pkg_session
  pkg_llm_retry --> pkg_agent
  pkg_llm_retry --> pkg_invariants
  pkg_llm_retry --> pkg_llm
  pkg_llm_retry --> pkg_session
  pkg_llm_retry --> pkg_timeout
  pkg_token_meter --> pkg_compact
  pkg_token_meter --> pkg_invariants
  pkg_token_meter --> pkg_llm
  pkg_token_meter --> pkg_session
  pkg_token_meter --> pkg_session_projection
  pkg_goal --> pkg_agent
  pkg_goal --> pkg_brand
  pkg_goal --> pkg_invariants
  pkg_goal --> pkg_llm
  pkg_goal --> pkg_scope
  pkg_goal --> pkg_session
  pkg_goal --> pkg_session_projection
  pkg_goal --> pkg_type_meta
  pkg_bash_local --> pkg_bash
  pkg_bash_local --> pkg_invariants
  pkg_bash_local --> pkg_subprocess
  pkg_bash_local --> pkg_timeout
  pkg_pwsh_local --> pkg_bash
  pkg_pwsh_local --> pkg_invariants
  pkg_pwsh_local --> pkg_subprocess
  pkg_pwsh_local --> pkg_timeout
  pkg_fs_local --> pkg_fs
  pkg_fs_local --> pkg_invariants
  pkg_fs_policy --> pkg_fs
  pkg_fs_policy --> pkg_invariants
  pkg_skill_local --> pkg_fs
  pkg_skill_local --> pkg_invariants
  pkg_skill_local --> pkg_paths
  pkg_skill_local --> pkg_skill
  pkg_web_search_deepseek --> pkg_agent
  pkg_web_search_deepseek --> pkg_credentials
  pkg_web_search_deepseek --> pkg_environment
  pkg_web_search_deepseek --> pkg_invariants
  pkg_web_search_deepseek --> pkg_session
  pkg_web_search_deepseek --> pkg_web
  pkg_spill_local --> pkg_invariants
  pkg_spill_local --> pkg_spill
  pkg_hook_protocol --> pkg_bash
  pkg_hook_protocol --> pkg_invariants
  pkg_hook_protocol --> pkg_session
  pkg_llm_replay --> pkg_compact
  pkg_llm_replay --> pkg_invariants
  pkg_llm_replay --> pkg_llm
  pkg_llm_replay --> pkg_session
  pkg_loader_smoke --> pkg_agent
  pkg_loader_smoke --> pkg_invariants
  pkg_loader_smoke --> pkg_llm
  pkg_loader_smoke --> pkg_session
  pkg_headless --> pkg_agent
  pkg_headless --> pkg_host_apiproxy
  pkg_headless --> pkg_host_webserver
  pkg_headless --> pkg_invariants
  pkg_headless --> pkg_session
  pkg_client_ui_layout --> pkg_client_runtime
  pkg_client_ui_layout --> pkg_client_ui_slots
  pkg_client_ui_layout --> pkg_client_ui_theme
  pkg_client_ui_layout --> pkg_invariants
  pkg_time_context --> pkg_agent
  pkg_time_context --> pkg_invariants
  pkg_time_context --> pkg_session
  pkg_tmux_context --> pkg_agent
  pkg_tmux_context --> pkg_bash
  pkg_tmux_context --> pkg_invariants
  pkg_tmux_context --> pkg_session
  pkg_fs_e2b --> pkg_e2b
  pkg_fs_e2b --> pkg_fs
  pkg_fs_e2b --> pkg_invariants
  pkg_host_directory_picker_browse --> pkg_client_locale
  pkg_host_directory_picker_browse --> pkg_client_runtime
  pkg_host_directory_picker_browse --> pkg_client_ui_primitives
  pkg_host_directory_picker_browse --> pkg_client_ui_slots
  pkg_host_directory_picker_browse --> pkg_client_ui_workspace
  pkg_host_directory_picker_browse --> pkg_invariants
  pkg_host_directory_picker_native --> pkg_client_runtime
  pkg_host_directory_picker_native --> pkg_client_ui_slots
  pkg_host_directory_picker_native --> pkg_client_ui_workspace
  pkg_host_directory_picker_native --> pkg_invariants
  pkg_commands --> pkg_agent
  pkg_commands --> pkg_brand
  pkg_commands --> pkg_invariants
  pkg_commands --> pkg_scope
  pkg_commands --> pkg_session
  pkg_user_approval --> pkg_agent
  pkg_user_approval --> pkg_brand
  pkg_user_approval --> pkg_invariants
  pkg_user_approval --> pkg_llm
  pkg_user_approval --> pkg_scope
  pkg_user_approval --> pkg_session
  pkg_user_approval --> pkg_system_prompt
  pkg_user_interaction --> pkg_agent
  pkg_user_interaction --> pkg_invariants
  pkg_user_interaction --> pkg_llm
  pkg_lsp_local --> pkg_brand
  pkg_lsp_local --> pkg_fs
  pkg_lsp_local --> pkg_invariants
  pkg_lsp_local --> pkg_llm
  pkg_lsp_local --> pkg_lsp
  pkg_lsp_local --> pkg_subprocess
  pkg_lsp_local --> pkg_timeout
  pkg_pty --> pkg_agent
  pkg_pty --> pkg_brand
  pkg_pty --> pkg_invariants
  pkg_sandbox_policy --> pkg_agent
  pkg_sandbox_policy --> pkg_invariants
  pkg_sandbox_policy --> pkg_sandbox
  pkg_sandbox_policy --> pkg_session
  pkg_sandbox_policy --> pkg_system_prompt
  pkg_scripts --> pkg_app_boot
  pkg_scripts --> pkg_invariants
  pkg_session_persistence_jsonl --> pkg_invariants
  pkg_session_persistence_jsonl --> pkg_session
  pkg_session_persistence_jsonl --> pkg_session_persistence
  pkg_session_persistence_sqlite --> pkg_invariants
  pkg_session_persistence_sqlite --> pkg_session
  pkg_session_persistence_sqlite --> pkg_session_persistence
  pkg_session_projection_cache --> pkg_invariants
  pkg_session_projection_cache --> pkg_session
  pkg_session_projection_cache --> pkg_session_persistence
  pkg_session_projection_cache --> pkg_session_projection
  pkg_session_projection_cache --> pkg_storage_domain
  pkg_session_telemetry --> pkg_agent
  pkg_session_telemetry --> pkg_invariants
  pkg_session_telemetry --> pkg_session
  pkg_session_title --> pkg_brand
  pkg_session_title --> pkg_invariants
  pkg_session_title --> pkg_llm
  pkg_session_title --> pkg_session
  pkg_session_title --> pkg_session_projection
  pkg_tasks --> pkg_agent
  pkg_tasks --> pkg_brand
  pkg_tasks --> pkg_invariants
  pkg_tasks --> pkg_session
  pkg_workflow --> pkg_agent
  pkg_workflow --> pkg_brand
  pkg_workflow --> pkg_invariants
  pkg_workflow --> pkg_llm
  pkg_workflow --> pkg_session
  pkg_workspace --> pkg_brand
  pkg_workspace --> pkg_invariants
  pkg_workspace --> pkg_session
  pkg_workspace --> pkg_session_persistence
  pkg_workspace --> pkg_storage
  pkg_workspace --> pkg_storage_domain
  pkg_tools --> pkg_agent
  pkg_tools --> pkg_code_runtime
  pkg_tools --> pkg_invariants
  pkg_tools --> pkg_llm
  pkg_tools --> pkg_scope
  pkg_tools --> pkg_session
  pkg_tools --> pkg_system_prompt
  pkg_tools --> pkg_user_approval
  pkg_command_goal --> pkg_commands
  pkg_command_goal --> pkg_goal
  pkg_command_goal --> pkg_invariants
  pkg_goal_session --> pkg_agent
  pkg_goal_session --> pkg_goal
  pkg_goal_session --> pkg_invariants
  pkg_goal_session --> pkg_llm
  pkg_goal_session --> pkg_session
  pkg_bash_sandbox --> pkg_bash
  pkg_bash_sandbox --> pkg_bash_local
  pkg_bash_sandbox --> pkg_invariants
  pkg_bash_sandbox --> pkg_sandbox
  pkg_bash_sandbox --> pkg_sandbox_policy
  pkg_fs_sandbox --> pkg_fs
  pkg_fs_sandbox --> pkg_fs_local
  pkg_fs_sandbox --> pkg_invariants
  pkg_fs_sandbox --> pkg_sandbox
  pkg_fs_sandbox --> pkg_sandbox_policy
  pkg_command_compact --> pkg_commands
  pkg_command_compact --> pkg_compact
  pkg_command_compact --> pkg_invariants
  pkg_compact_tool_result_prune --> pkg_compact
  pkg_compact_tool_result_prune --> pkg_invariants
  pkg_compact_tool_result_prune --> pkg_llm
  pkg_compact_tool_result_prune --> pkg_session
  pkg_compact_tool_result_prune --> pkg_token_meter
  pkg_session_query --> pkg_brand
  pkg_session_query --> pkg_invariants
  pkg_session_query --> pkg_llm
  pkg_session_query --> pkg_session
  pkg_session_query --> pkg_session_persistence
  pkg_session_query --> pkg_session_title
  pkg_acp --> pkg_agent
  pkg_acp --> pkg_invariants
  pkg_acp --> pkg_session
  pkg_acp --> pkg_user_approval
  pkg_api_remotes --> pkg_agent
  pkg_api_remotes --> pkg_goal
  pkg_api_remotes --> pkg_invariants
  pkg_api_remotes --> pkg_session
  pkg_api_remotes --> pkg_session_persistence
  pkg_api_remotes --> pkg_typert_registry
  pkg_client_ui_conversation --> pkg_client_locale
  pkg_client_ui_conversation --> pkg_client_runtime
  pkg_client_ui_conversation --> pkg_client_ui_primitives
  pkg_client_ui_conversation --> pkg_client_ui_slash
  pkg_client_ui_conversation --> pkg_client_ui_slots
  pkg_client_ui_conversation --> pkg_invariants
  pkg_client_ui_conversation --> pkg_token_meter
  pkg_command_feedback --> pkg_commands
  pkg_command_feedback --> pkg_invariants
  pkg_command_feedback --> pkg_session
  pkg_host_directory_picker_auto --> pkg_host_directory_picker_browse
  pkg_host_directory_picker_auto --> pkg_host_directory_picker_native
  pkg_host_directory_picker_auto --> pkg_host_webserver
  pkg_host_directory_picker_auto --> pkg_invariants
  pkg_permission --> pkg_bash
  pkg_permission --> pkg_commands
  pkg_permission --> pkg_invariants
  pkg_permission --> pkg_sandbox
  pkg_permission --> pkg_sandbox_policy
  pkg_permission --> pkg_session
  pkg_permission --> pkg_session_projection
  pkg_permission --> pkg_settings
  pkg_permission --> pkg_user_approval
  pkg_pty_local --> pkg_agent
  pkg_pty_local --> pkg_invariants
  pkg_pty_local --> pkg_pty
  pkg_pty_local --> pkg_sandbox
  pkg_pty_local --> pkg_sandbox_policy
  pkg_pty_local --> pkg_session
  pkg_pty_local --> pkg_subprocess
  pkg_session_title_llm --> pkg_invariants
  pkg_session_title_llm --> pkg_llm
  pkg_session_title_llm --> pkg_session
  pkg_session_title_llm --> pkg_session_title
  pkg_session_title_llm --> pkg_timeout
  pkg_tasks_local --> pkg_agent
  pkg_tasks_local --> pkg_invariants
  pkg_tasks_local --> pkg_tasks
  pkg_tasks_local --> pkg_timeout
  pkg_agent_loop --> pkg_agent
  pkg_agent_loop --> pkg_invariants
  pkg_agent_loop --> pkg_llm
  pkg_agent_loop --> pkg_scope
  pkg_agent_loop --> pkg_session
  pkg_agent_loop --> pkg_session_persistence
  pkg_agent_loop --> pkg_system_prompt
  pkg_agent_loop --> pkg_tools
  pkg_tool_goal --> pkg_agent
  pkg_tool_goal --> pkg_goal
  pkg_tool_goal --> pkg_invariants
  pkg_tool_goal --> pkg_llm
  pkg_tool_goal --> pkg_session
  pkg_tool_goal --> pkg_system_prompt
  pkg_tool_goal --> pkg_tools
  pkg_bash_env --> pkg_bash
  pkg_bash_env --> pkg_invariants
  pkg_bash_env --> pkg_paths
  pkg_bash_env --> pkg_session_persistence
  pkg_bash_env --> pkg_tools
  pkg_tool_fs --> pkg_fs
  pkg_tool_fs --> pkg_invariants
  pkg_tool_fs --> pkg_llm
  pkg_tool_fs --> pkg_sandbox
  pkg_tool_fs --> pkg_sandbox_policy
  pkg_tool_fs --> pkg_session
  pkg_tool_fs --> pkg_system_prompt
  pkg_tool_fs --> pkg_tools
  pkg_tool_fs --> pkg_user_approval
  pkg_tool_fs_search --> pkg_invariants
  pkg_tool_fs_search --> pkg_llm
  pkg_tool_fs_search --> pkg_retention
  pkg_tool_fs_search --> pkg_session
  pkg_tool_fs_search --> pkg_spill
  pkg_tool_fs_search --> pkg_subprocess
  pkg_tool_fs_search --> pkg_system_prompt
  pkg_tool_fs_search --> pkg_timeout
  pkg_tool_fs_search --> pkg_tools
  pkg_tool_str_replace_editor --> pkg_fs
  pkg_tool_str_replace_editor --> pkg_invariants
  pkg_tool_str_replace_editor --> pkg_sandbox
  pkg_tool_str_replace_editor --> pkg_sandbox_policy
  pkg_tool_str_replace_editor --> pkg_tools
  pkg_tool_skill --> pkg_agent
  pkg_tool_skill --> pkg_invariants
  pkg_tool_skill --> pkg_llm
  pkg_tool_skill --> pkg_skill
  pkg_tool_skill --> pkg_tools
  pkg_compact_basic --> pkg_agent
  pkg_compact_basic --> pkg_compact
  pkg_compact_basic --> pkg_compact_tool_result_prune
  pkg_compact_basic --> pkg_invariants
  pkg_compact_basic --> pkg_llm
  pkg_compact_basic --> pkg_session
  pkg_compact_basic --> pkg_token_meter
  pkg_subagent --> pkg_agent
  pkg_subagent --> pkg_brand
  pkg_subagent --> pkg_invariants
  pkg_subagent --> pkg_llm
  pkg_subagent --> pkg_scope
  pkg_subagent --> pkg_session
  pkg_subagent --> pkg_session_persistence
  pkg_subagent --> pkg_session_projection
  pkg_subagent --> pkg_session_projection_cache
  pkg_subagent --> pkg_tasks
  pkg_subagent --> pkg_tools
  pkg_tool_web --> pkg_invariants
  pkg_tool_web --> pkg_llm
  pkg_tool_web --> pkg_system_prompt
  pkg_tool_web --> pkg_tools
  pkg_tool_web --> pkg_web
  pkg_spill_policy --> pkg_invariants
  pkg_spill_policy --> pkg_llm
  pkg_spill_policy --> pkg_retention
  pkg_spill_policy --> pkg_session
  pkg_spill_policy --> pkg_spill
  pkg_spill_policy --> pkg_tools
  pkg_tool_todo --> pkg_agent
  pkg_tool_todo --> pkg_invariants
  pkg_tool_todo --> pkg_session
  pkg_tool_todo --> pkg_session_projection
  pkg_tool_todo --> pkg_tools
  pkg_plan_mode --> pkg_agent
  pkg_plan_mode --> pkg_commands
  pkg_plan_mode --> pkg_invariants
  pkg_plan_mode --> pkg_llm
  pkg_plan_mode --> pkg_session
  pkg_plan_mode --> pkg_session_projection
  pkg_plan_mode --> pkg_system_prompt
  pkg_plan_mode --> pkg_tools
  pkg_plan_mode --> pkg_user_interaction
  pkg_hooks_codex --> pkg_agent
  pkg_hooks_codex --> pkg_hook_protocol
  pkg_hooks_codex --> pkg_invariants
  pkg_hooks_codex --> pkg_llm
  pkg_hooks_codex --> pkg_session
  pkg_hooks_codex --> pkg_session_persistence
  pkg_hooks_codex --> pkg_tools
  pkg_session_query_sqlite --> pkg_invariants
  pkg_session_query_sqlite --> pkg_session
  pkg_session_query_sqlite --> pkg_session_persistence
  pkg_session_query_sqlite --> pkg_session_query
  pkg_tool_session_query --> pkg_invariants
  pkg_tool_session_query --> pkg_llm
  pkg_tool_session_query --> pkg_session
  pkg_tool_session_query --> pkg_session_query
  pkg_tool_session_query --> pkg_system_prompt
  pkg_tool_session_query --> pkg_timeout
  pkg_tool_session_query --> pkg_tools
  pkg_agent_loop_testkit --> pkg_agent
  pkg_agent_loop_testkit --> pkg_invariants
  pkg_agent_loop_testkit --> pkg_llm
  pkg_agent_loop_testkit --> pkg_session
  pkg_agent_loop_testkit --> pkg_system_prompt
  pkg_agent_loop_testkit --> pkg_tools
  pkg_client_ui_command --> pkg_client_connection
  pkg_client_ui_command --> pkg_client_locale
  pkg_client_ui_command --> pkg_client_runtime
  pkg_client_ui_command --> pkg_client_ui_conversation
  pkg_client_ui_command --> pkg_client_ui_primitives
  pkg_client_ui_command --> pkg_client_ui_slash
  pkg_client_ui_command --> pkg_client_ui_slots
  pkg_client_ui_command --> pkg_invariants
  pkg_client_ui_deliverables --> pkg_client_locale
  pkg_client_ui_deliverables --> pkg_client_runtime
  pkg_client_ui_deliverables --> pkg_client_ui_conversation
  pkg_client_ui_deliverables --> pkg_client_ui_slots
  pkg_client_ui_deliverables --> pkg_invariants
  pkg_client_ui_goal --> pkg_api_remotes
  pkg_client_ui_goal --> pkg_client_locale
  pkg_client_ui_goal --> pkg_client_runtime
  pkg_client_ui_goal --> pkg_client_ui_conversation
  pkg_client_ui_goal --> pkg_client_ui_primitives
  pkg_client_ui_goal --> pkg_client_ui_slots
  pkg_client_ui_goal --> pkg_goal
  pkg_client_ui_goal --> pkg_invariants
  pkg_client_ui_tool --> pkg_client_locale
  pkg_client_ui_tool --> pkg_client_runtime
  pkg_client_ui_tool --> pkg_client_ui_conversation
  pkg_client_ui_tool --> pkg_client_ui_primitives
  pkg_client_ui_tool --> pkg_client_ui_slots
  pkg_client_ui_tool --> pkg_invariants
  pkg_session_reference --> pkg_agent
  pkg_session_reference --> pkg_compact
  pkg_session_reference --> pkg_invariants
  pkg_session_reference --> pkg_llm
  pkg_session_reference --> pkg_retention
  pkg_session_reference --> pkg_session
  pkg_session_reference --> pkg_session_query
  pkg_workspace_context --> pkg_agent
  pkg_workspace_context --> pkg_fs
  pkg_workspace_context --> pkg_invariants
  pkg_workspace_context --> pkg_llm
  pkg_workspace_context --> pkg_paths
  pkg_workspace_context --> pkg_session
  pkg_workspace_context --> pkg_tools
  pkg_repeat_tool_guard --> pkg_agent
  pkg_repeat_tool_guard --> pkg_invariants
  pkg_repeat_tool_guard --> pkg_tools
  pkg_timeout_policy --> pkg_invariants
  pkg_timeout_policy --> pkg_llm
  pkg_timeout_policy --> pkg_timeout
  pkg_timeout_policy --> pkg_tools
  pkg_tool_ask_user --> pkg_agent
  pkg_tool_ask_user --> pkg_invariants
  pkg_tool_ask_user --> pkg_tools
  pkg_tool_ask_user --> pkg_user_interaction
  pkg_tool_lsp --> pkg_invariants
  pkg_tool_lsp --> pkg_llm
  pkg_tool_lsp --> pkg_lsp
  pkg_tool_lsp --> pkg_system_prompt
  pkg_tool_lsp --> pkg_timeout
  pkg_tool_lsp --> pkg_tools
  pkg_mcp_client --> pkg_invariants
  pkg_mcp_client --> pkg_llm
  pkg_mcp_client --> pkg_subprocess
  pkg_mcp_client --> pkg_tools
  pkg_tool_bash_persistent --> pkg_agent
  pkg_tool_bash_persistent --> pkg_invariants
  pkg_tool_bash_persistent --> pkg_pty
  pkg_tool_bash_persistent --> pkg_timeout
  pkg_tool_bash_persistent --> pkg_tools
  pkg_tool_pty --> pkg_agent
  pkg_tool_pty --> pkg_invariants
  pkg_tool_pty --> pkg_llm
  pkg_tool_pty --> pkg_pty
  pkg_tool_pty --> pkg_retention
  pkg_tool_pty --> pkg_system_prompt
  pkg_tool_pty --> pkg_tasks
  pkg_tool_pty --> pkg_tools
  pkg_tool_cordis --> pkg_invariants
  pkg_tool_cordis --> pkg_scope
  pkg_tool_cordis --> pkg_tools
  pkg_session_checkpoint_policy --> pkg_agent
  pkg_session_checkpoint_policy --> pkg_invariants
  pkg_session_checkpoint_policy --> pkg_llm
  pkg_session_checkpoint_policy --> pkg_session
  pkg_session_checkpoint_policy --> pkg_session_persistence
  pkg_session_checkpoint_policy --> pkg_tools
  pkg_session_telemetry_otel --> pkg_brand
  pkg_session_telemetry_otel --> pkg_command_feedback
  pkg_session_telemetry_otel --> pkg_invariants
  pkg_session_telemetry_otel --> pkg_llm
  pkg_session_telemetry_otel --> pkg_paths
  pkg_session_telemetry_otel --> pkg_session
  pkg_session_telemetry_otel --> pkg_session_telemetry
  pkg_session_title_all_messages_llm --> pkg_invariants
  pkg_session_title_all_messages_llm --> pkg_llm
  pkg_session_title_all_messages_llm --> pkg_session
  pkg_session_title_all_messages_llm --> pkg_session_title
  pkg_session_title_all_messages_llm --> pkg_session_title_llm
  pkg_session_title_first_message_llm --> pkg_invariants
  pkg_session_title_first_message_llm --> pkg_llm
  pkg_session_title_first_message_llm --> pkg_session
  pkg_session_title_first_message_llm --> pkg_session_title
  pkg_session_title_first_message_llm --> pkg_session_title_llm
  pkg_tool_tasks --> pkg_agent
  pkg_tool_tasks --> pkg_invariants
  pkg_tool_tasks --> pkg_llm
  pkg_tool_tasks --> pkg_retention
  pkg_tool_tasks --> pkg_system_prompt
  pkg_tool_tasks --> pkg_tasks
  pkg_tool_tasks --> pkg_tools
  pkg_tool_workflow --> pkg_agent
  pkg_tool_workflow --> pkg_invariants
  pkg_tool_workflow --> pkg_llm
  pkg_tool_workflow --> pkg_system_prompt
  pkg_tool_workflow --> pkg_tools
  pkg_tool_workflow --> pkg_workflow
  pkg_tool_bash --> pkg_agent
  pkg_tool_bash --> pkg_bash
  pkg_tool_bash --> pkg_bash_env
  pkg_tool_bash --> pkg_invariants
  pkg_tool_bash --> pkg_llm
  pkg_tool_bash --> pkg_sandbox
  pkg_tool_bash --> pkg_sandbox_policy
  pkg_tool_bash --> pkg_system_prompt
  pkg_tool_bash --> pkg_tasks
  pkg_tool_bash --> pkg_tools
  pkg_tool_bash --> pkg_user_approval
  pkg_tool_pwsh --> pkg_agent
  pkg_tool_pwsh --> pkg_bash
  pkg_tool_pwsh --> pkg_bash_env
  pkg_tool_pwsh --> pkg_invariants
  pkg_tool_pwsh --> pkg_llm
  pkg_tool_pwsh --> pkg_system_prompt
  pkg_tool_pwsh --> pkg_tasks
  pkg_tool_pwsh --> pkg_tools
  pkg_subagent_acp --> pkg_agent
  pkg_subagent_acp --> pkg_invariants
  pkg_subagent_acp --> pkg_llm
  pkg_subagent_acp --> pkg_session
  pkg_subagent_acp --> pkg_subagent
  pkg_subagent_acp --> pkg_subprocess
  pkg_subagent_acp --> pkg_timeout
  pkg_subagent_claude_code --> pkg_invariants
  pkg_subagent_claude_code --> pkg_llm
  pkg_subagent_claude_code --> pkg_session
  pkg_subagent_claude_code --> pkg_subagent
  pkg_subagent_claude_code --> pkg_subprocess
  pkg_subagent_claude_code --> pkg_timeout
  pkg_subagent_inprocess --> pkg_agent
  pkg_subagent_inprocess --> pkg_invariants
  pkg_subagent_inprocess --> pkg_llm
  pkg_subagent_inprocess --> pkg_sandbox_policy
  pkg_subagent_inprocess --> pkg_session
  pkg_subagent_inprocess --> pkg_subagent
  pkg_subagent_inprocess --> pkg_system_prompt
  pkg_subagent_inprocess --> pkg_tools
  pkg_subagent_inprocess --> pkg_user_approval
  pkg_tool_subagent --> pkg_agent
  pkg_tool_subagent --> pkg_invariants
  pkg_tool_subagent --> pkg_llm
  pkg_tool_subagent --> pkg_subagent
  pkg_tool_subagent --> pkg_tasks
  pkg_tool_subagent --> pkg_tools
  pkg_tool_subagent_control --> pkg_invariants
  pkg_tool_subagent_control --> pkg_llm
  pkg_tool_subagent_control --> pkg_session
  pkg_tool_subagent_control --> pkg_subagent
  pkg_tool_subagent_control --> pkg_tools
  pkg_tool_subagent_report --> pkg_invariants
  pkg_tool_subagent_report --> pkg_llm
  pkg_tool_subagent_report --> pkg_subagent
  pkg_tool_subagent_report --> pkg_tools
  pkg_hooks_claude --> pkg_agent
  pkg_hooks_claude --> pkg_hook_protocol
  pkg_hooks_claude --> pkg_invariants
  pkg_hooks_claude --> pkg_llm
  pkg_hooks_claude --> pkg_session
  pkg_hooks_claude --> pkg_session_persistence
  pkg_hooks_claude --> pkg_subagent
  pkg_hooks_claude --> pkg_tools
  pkg_web_app --> pkg_bash_env
  pkg_web_app --> pkg_invariants
  pkg_web_app --> pkg_system_prompt
  pkg_client_ui_model --> pkg_client_connection
  pkg_client_ui_model --> pkg_client_locale
  pkg_client_ui_model --> pkg_client_runtime
  pkg_client_ui_model --> pkg_client_ui_command
  pkg_client_ui_model --> pkg_client_ui_conversation
  pkg_client_ui_model --> pkg_client_ui_primitives
  pkg_client_ui_model --> pkg_client_ui_slash
  pkg_client_ui_model --> pkg_client_ui_slots
  pkg_client_ui_model --> pkg_invariants
  pkg_client_ui_permission --> pkg_client_connection
  pkg_client_ui_permission --> pkg_client_locale
  pkg_client_ui_permission --> pkg_client_runtime
  pkg_client_ui_permission --> pkg_client_schema_form
  pkg_client_ui_permission --> pkg_client_ui_command
  pkg_client_ui_permission --> pkg_client_ui_primitives
  pkg_client_ui_permission --> pkg_client_ui_slash
  pkg_client_ui_permission --> pkg_client_ui_slots
  pkg_client_ui_permission --> pkg_invariants
  pkg_client_ui_permission --> pkg_permission
  pkg_client_ui_plan --> pkg_client_connection
  pkg_client_ui_plan --> pkg_client_locale
  pkg_client_ui_plan --> pkg_client_runtime
  pkg_client_ui_plan --> pkg_client_ui_conversation
  pkg_client_ui_plan --> pkg_client_ui_primitives
  pkg_client_ui_plan --> pkg_client_ui_slots
  pkg_client_ui_plan --> pkg_invariants
  pkg_client_ui_plan --> pkg_plan_mode
  pkg_client_ui_skill --> pkg_client_connection
  pkg_client_ui_skill --> pkg_client_locale
  pkg_client_ui_skill --> pkg_client_runtime
  pkg_client_ui_skill --> pkg_client_ui_primitives
  pkg_client_ui_skill --> pkg_client_ui_slash
  pkg_client_ui_skill --> pkg_client_ui_slots
  pkg_client_ui_skill --> pkg_client_ui_tool
  pkg_client_ui_skill --> pkg_invariants
  pkg_client_ui_subagent --> pkg_client_locale
  pkg_client_ui_subagent --> pkg_client_runtime
  pkg_client_ui_subagent --> pkg_client_ui_conversation
  pkg_client_ui_subagent --> pkg_client_ui_primitives
  pkg_client_ui_subagent --> pkg_client_ui_slash
  pkg_client_ui_subagent --> pkg_client_ui_slots
  pkg_client_ui_subagent --> pkg_invariants
  pkg_client_ui_subagent --> pkg_subagent
  pkg_client_ui_subagent --> pkg_token_meter
  pkg_sdk_protocol --> pkg_invariants
  pkg_sdk_protocol --> pkg_llm
  pkg_sdk_protocol --> pkg_session
  pkg_sdk_protocol --> pkg_subagent
  pkg_repository_plugin --> pkg_invariants
  pkg_repository_plugin --> pkg_mcp_client
  pkg_repository_plugin --> pkg_paths
  pkg_repository_plugin --> pkg_skill_local
  pkg_tool_ralph --> pkg_agent
  pkg_tool_ralph --> pkg_invariants
  pkg_tool_ralph --> pkg_llm
  pkg_tool_ralph --> pkg_subagent
  pkg_tool_ralph --> pkg_system_prompt
  pkg_tool_ralph --> pkg_tools
  pkg_tool_ralph --> pkg_workflow
  pkg_workflow_workerthread --> pkg_agent
  pkg_workflow_workerthread --> pkg_brand
  pkg_workflow_workerthread --> pkg_invariants
  pkg_workflow_workerthread --> pkg_llm
  pkg_workflow_workerthread --> pkg_session
  pkg_workflow_workerthread --> pkg_subagent
  pkg_workflow_workerthread --> pkg_tools
  pkg_workflow_workerthread --> pkg_workflow
  pkg_subagent_codex --> pkg_invariants
  pkg_subagent_codex --> pkg_llm
  pkg_subagent_codex --> pkg_sdk_protocol
  pkg_subagent_codex --> pkg_session
  pkg_subagent_codex --> pkg_subagent
  pkg_subagent_codex --> pkg_subprocess
  pkg_subagent_codex --> pkg_timeout
  pkg_subagent_fork --> pkg_agent
  pkg_subagent_fork --> pkg_invariants
  pkg_subagent_fork --> pkg_session
  pkg_subagent_fork --> pkg_subagent
  pkg_subagent_fork --> pkg_subagent_inprocess
  pkg_subagent_spawn --> pkg_invariants
  pkg_subagent_spawn --> pkg_subagent
  pkg_subagent_spawn --> pkg_subagent_inprocess
  pkg_agent_spine_demo --> pkg_agent
  pkg_agent_spine_demo --> pkg_agent_loop
  pkg_agent_spine_demo --> pkg_bash_env
  pkg_agent_spine_demo --> pkg_goal
  pkg_agent_spine_demo --> pkg_goal_session
  pkg_agent_spine_demo --> pkg_invariants
  pkg_agent_spine_demo --> pkg_llm
  pkg_agent_spine_demo --> pkg_llm_retry
  pkg_agent_spine_demo --> pkg_paths
  pkg_agent_spine_demo --> pkg_scope
  pkg_agent_spine_demo --> pkg_session
  pkg_agent_spine_demo --> pkg_session_title
  pkg_agent_spine_demo --> pkg_skill
  pkg_agent_spine_demo --> pkg_skill_local
  pkg_agent_spine_demo --> pkg_system_prompt
  pkg_agent_spine_demo --> pkg_tasks_local
  pkg_agent_spine_demo --> pkg_tool_bash
  pkg_agent_spine_demo --> pkg_tool_goal
  pkg_agent_spine_demo --> pkg_tool_skill
  pkg_agent_spine_demo --> pkg_tool_tasks
  pkg_agent_spine_demo --> pkg_tools
  pkg_agent_spine_demo --> pkg_workspace_context
  pkg_jsonrpc --> pkg_agent
  pkg_jsonrpc --> pkg_invariants
  pkg_jsonrpc --> pkg_llm
  pkg_jsonrpc --> pkg_llm_deepseek
  pkg_jsonrpc --> pkg_scope
  pkg_jsonrpc --> pkg_sdk_protocol
  pkg_jsonrpc --> pkg_session
  pkg_jsonrpc --> pkg_subagent
  pkg_sdk_client --> pkg_invariants
  pkg_sdk_client --> pkg_llm
  pkg_sdk_client --> pkg_sdk_protocol
  pkg_sdk_client --> pkg_session
  pkg_subagent_dsh_sdk --> pkg_agent
  pkg_subagent_dsh_sdk --> pkg_invariants
  pkg_subagent_dsh_sdk --> pkg_llm
  pkg_subagent_dsh_sdk --> pkg_sdk_client
  pkg_subagent_dsh_sdk --> pkg_session
  pkg_subagent_dsh_sdk --> pkg_subagent
  pkg_subagent_dsh_sdk --> pkg_subprocess
  pkg_acp_demo --> pkg_acp
  pkg_acp_demo --> pkg_agent_spine_demo
  pkg_acp_demo --> pkg_app_boot
  pkg_acp_demo --> pkg_invariants
  pkg_acp_demo --> pkg_session_checkpoint_policy
  pkg_acp_demo --> pkg_session_persistence_jsonl
  pkg_acp_demo --> pkg_session_query
  pkg_acp_demo --> pkg_session_query_sqlite
  pkg_acp_demo --> pkg_tools
  pkg_acp_demo --> pkg_workspace_context
```

| 包 | 分组 | 依赖项 |
| --- | --- | --- |
| [`invariants`](../packages/support/invariants) | `support` | — |
| [`atomic-write`](../packages/util/atomic-write) | `util` | [`invariants`](../packages/support/invariants) |
| [`brand`](../packages/util/brand) | `util` | [`invariants`](../packages/support/invariants) |
| [`environment`](../packages/util/environment) | `util` | [`invariants`](../packages/support/invariants) |
| [`native-command`](../packages/util/native-command) | `util` | [`invariants`](../packages/support/invariants) |
| [`paths`](../packages/util/paths) | `util` | [`invariants`](../packages/support/invariants) |
| [`retention`](../packages/util/retention) | `util` | [`invariants`](../packages/support/invariants) |
| [`timeout`](../packages/util/timeout) | `util` | [`invariants`](../packages/support/invariants) |
| [`scope`](../packages/core/scope) | `core` | [`invariants`](../packages/support/invariants) |
| [`llm-mock-server`](../packages/support/llm-mock-server) | `support` | [`invariants`](../packages/support/invariants) |
| [`base`](../packages/bundle/base) | `bundle` | [`invariants`](../packages/support/invariants) |
| [`client-modules`](../packages/client/modules) | `client` | [`invariants`](../packages/support/invariants) |
| [`client-schema-form`](../packages/client/schema-form) | `client` | [`invariants`](../packages/support/invariants) |
| [`client-ui-primitives`](../packages/client/ui-primitives) | `client` | [`invariants`](../packages/support/invariants) |
| [`client-ui-slots`](../packages/client/ui-slots) | `client` | [`invariants`](../packages/support/invariants) |
| [`client-web`](../packages/client/web) | `client` | [`invariants`](../packages/support/invariants) |
| [`client-web-react`](../packages/client/web-react) | `client` | [`invariants`](../packages/support/invariants) |
| [`code-runtime`](../packages/code-runtime/code-runtime) | `code-runtime` | [`invariants`](../packages/support/invariants) |
| [`e2b`](../packages/e2b/e2b) | `e2b` | [`invariants`](../packages/support/invariants) |
| [`jsonrpc-demo`](../packages/examples/jsonrpc-demo) | `examples` | [`invariants`](../packages/support/invariants) |
| [`host-apiproxy`](../packages/host/apiproxy) | `host` | [`invariants`](../packages/support/invariants) |
| [`host-directory-picker`](../packages/host/directory-picker) | `host` | [`invariants`](../packages/support/invariants) |
| [`host-webserver`](../packages/host/webserver) | `host` | [`invariants`](../packages/support/invariants) |
| [`storage`](../packages/storage/storage) | `storage` | [`invariants`](../packages/support/invariants) |
| [`subprocess`](../packages/subprocess/subprocess) | `subprocess` | [`invariants`](../packages/support/invariants) |
| [`type-meta`](../packages/typert/type-meta) | `typert` | [`invariants`](../packages/support/invariants) |
| [`typert-generator`](../packages/typert/generator) | `typert` | [`invariants`](../packages/support/invariants) |
| [`typert-registry`](../packages/typert/registry) | `typert` | [`invariants`](../packages/support/invariants) |
| [`llm`](../packages/llm/llm) | `llm` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`timeout`](../packages/util/timeout) |
| [`client-connection`](../packages/client/connection) | `client` | [`host-webserver`](../packages/host/webserver), [`invariants`](../packages/support/invariants) |
| [`client-hmr`](../packages/client/hmr) | `client` | [`client-modules`](../packages/client/modules), [`host-webserver`](../packages/host/webserver), [`invariants`](../packages/support/invariants) |
| [`client-runtime`](../packages/client/runtime) | `client` | [`invariants`](../packages/support/invariants), [`type-meta`](../packages/typert/type-meta), [`typert-registry`](../packages/typert/registry) |
| [`credentials`](../packages/credentials/credentials) | `credentials` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants) |
| [`subprocess-e2b`](../packages/e2b/subprocess-e2b) | `e2b` | [`e2b`](../packages/e2b/e2b), [`invariants`](../packages/support/invariants), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`frontend-static`](../packages/host/frontend-static) | `host` | [`host-webserver`](../packages/host/webserver), [`invariants`](../packages/support/invariants) |
| [`helper`](../packages/scaffold/helper) | `sdk` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`subprocess`](../packages/subprocess/subprocess) |
| [`telemetry`](../packages/scaffold/telemetry) | `sdk` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`paths`](../packages/util/paths) |
| [`settings`](../packages/settings/settings) | `settings` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants) |
| [`storage-domain`](../packages/storage/storage-domain) | `storage` | [`invariants`](../packages/support/invariants), [`storage`](../packages/storage/storage) |
| [`storage-json`](../packages/storage/storage-json) | `storage` | [`invariants`](../packages/support/invariants), [`storage`](../packages/storage/storage) |
| [`storage-sqlite`](../packages/storage/storage-sqlite) | `storage` | [`invariants`](../packages/support/invariants), [`storage`](../packages/storage/storage) |
| [`subprocess-local`](../packages/subprocess/subprocess-local) | `subprocess` | [`invariants`](../packages/support/invariants), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`typert-loader`](../packages/typert/loader) | `typert` | [`invariants`](../packages/support/invariants), [`typert-registry`](../packages/typert/registry) |
| [`llm-deepseek`](../packages/llm/llm-deepseek) | `llm` | [`credentials`](../packages/credentials/credentials), [`environment`](../packages/util/environment), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`settings`](../packages/settings/settings), [`timeout`](../packages/util/timeout) |
| [`llm-pi-ai`](../packages/llm/llm-pi-ai) | `llm` | [`credentials`](../packages/credentials/credentials), [`environment`](../packages/util/environment), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`settings`](../packages/settings/settings), [`timeout`](../packages/util/timeout) |
| [`session`](../packages/core/session) | `core` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`type-meta`](../packages/typert/type-meta) |
| [`system-prompt`](../packages/core/system-prompt) | `core` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope) |
| [`skill`](../packages/skill/skill) | `skill` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm) |
| [`web`](../packages/web/web) | `web` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm) |
| [`api-gateway`](../packages/api/gateway) | `api` | [`client-connection`](../packages/client/connection), [`invariants`](../packages/support/invariants), [`typert-registry`](../packages/typert/registry) |
| [`client-locale`](../packages/client/locale) | `client` | [`client-runtime`](../packages/client/runtime), [`client-ui-primitives`](../packages/client/ui-primitives), [`client-ui-slots`](../packages/client/ui-slots), [`invariants`](../packages/support/invariants) |
| [`client-test-runtime`](../packages/client/test-runtime) | `client` | [`client-runtime`](../packages/client/runtime), [`client-ui-slots`](../packages/client/ui-slots), [`client-web-react`](../packages/client/web-react), [`host-apiproxy`](../packages/host/apiproxy), [`invariants`](../packages/support/invariants) |
| [`client-ui-models`](../packages/client/ui-models) | `client` | [`client-connection`](../packages/client/connection), [`client-runtime`](../packages/client/runtime), [`client-schema-form`](../packages/client/schema-form), [`client-ui-primitives`](../packages/client/ui-primitives), [`client-ui-slots`](../packages/client/ui-slots), [`client-web-react`](../packages/client/web-react), [`invariants`](../packages/support/invariants) |
| [`client-ui-settings`](../packages/client/ui-settings) | `client` | [`client-runtime`](../packages/client/runtime), [`client-ui-primitives`](../packages/client/ui-primitives), [`client-ui-slots`](../packages/client/ui-slots), [`invariants`](../packages/support/invariants) |
| [`client-ui-trajectory`](../packages/client/ui-trajectory) | `client` | [`client-runtime`](../packages/client/runtime), [`client-ui-primitives`](../packages/client/ui-primitives), [`invariants`](../packages/support/invariants) |
| [`credentials-local`](../packages/credentials/credentials-local) | `credentials` | [`atomic-write`](../packages/util/atomic-write), [`credentials`](../packages/credentials/credentials), [`environment`](../packages/util/environment), [`invariants`](../packages/support/invariants), [`paths`](../packages/util/paths) |
| [`lsp`](../packages/lsp/lsp) | `lsp` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm) |
| [`sandbox`](../packages/sandbox/sandbox) | `sandbox` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm) |
| [`settings-local`](../packages/settings/settings-local) | `settings` | [`atomic-write`](../packages/util/atomic-write), [`invariants`](../packages/support/invariants), [`paths`](../packages/util/paths), [`settings`](../packages/settings/settings) |
| [`agent`](../packages/core/agent) | `core` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`type-meta`](../packages/typert/type-meta) |
| [`bash`](../packages/bash/bash) | `bash` | [`invariants`](../packages/support/invariants), [`sandbox`](../packages/sandbox/sandbox), [`subprocess`](../packages/subprocess/subprocess) |
| [`fs`](../packages/fs/fs) | `fs` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`sandbox`](../packages/sandbox/sandbox) |
| [`skill-badge`](../packages/skill/skill-badge) | `skill` | [`invariants`](../packages/support/invariants), [`skill`](../packages/skill/skill) |
| [`compact`](../packages/compact/compact) | `compact` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`web-fetch-local`](../packages/web/web-fetch-local) | `web` | [`invariants`](../packages/support/invariants), [`timeout`](../packages/util/timeout), [`web`](../packages/web/web) |
| [`web-search-exa`](../packages/web/web-search-exa) | `web` | [`environment`](../packages/util/environment), [`invariants`](../packages/support/invariants), [`web`](../packages/web/web) |
| [`web-search-perplexity`](../packages/web/web-search-perplexity) | `web` | [`environment`](../packages/util/environment), [`invariants`](../packages/support/invariants), [`web`](../packages/web/web) |
| [`spill`](../packages/spill/spill) | `spill` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`session-persistence`](../packages/support/acp-snapshot) | `session-persistence` | [`brand`](../packages/support/invariants), [`invariants`](../packages/core/session), [`session`](../packages/boot/app-boot), [`timeout`](../packages/util/environment) |
| [`acp-snapshot`](../packages/support/invariants) | `support` | [`invariants`](../packages/util/paths), [`session`](../packages/core/system-prompt) |
| [`app-boot`](../packages/client/ui-question) | `ui` | [`environment`](../packages/client/locale), [`invariants`](../packages/support/invariants), [`paths`](../packages/client/ui-settings-general), [`system-prompt`](../packages/client/connection) |
| [`client-ui-question`](../packages/client/locale) | `client` | [`client-locale`](../packages/client/runtime), [`invariants`](../packages/client/ui-primitives) |
| [`client-ui-settings-general`](../packages/client/ui-settings) | `client` | [`client-connection`](../packages/client/ui-slots), [`client-locale`](../packages/client/web-react), [`client-runtime`](../packages/support/invariants), [`client-ui-primitives`](../packages/client/ui-sidebar), [`client-ui-settings`](../packages/client/locale), [`client-ui-slots`](../packages/client/runtime), [`client-web-react`](../packages/client/ui-primitives), [`invariants`](../packages/client/ui-slots) |
| [`client-ui-sidebar`](../packages/support/invariants) | `client` | [`client-locale`](../packages/client/ui-slash), [`client-runtime`](../packages/client/locale), [`client-ui-primitives`](../packages/client/runtime), [`client-ui-slots`](../packages/client/ui-primitives), [`invariants`](../packages/client/ui-slots) |
| [`client-ui-slash`](../packages/support/invariants) | `client` | [`client-locale`](../packages/client/ui-theme), [`client-runtime`](../packages/client/locale), [`client-ui-primitives`](../packages/client/runtime), [`client-ui-slots`](../packages/client/ui-primitives), [`invariants`](../packages/client/ui-slots) |
| [`client-ui-theme`](../packages/support/invariants) | `client` | [`client-locale`](../packages/client/ui-workspace), [`client-runtime`](../packages/client/locale), [`client-ui-primitives`](../packages/client/runtime), [`client-ui-slots`](../packages/client/ui-primitives), [`invariants`](../packages/client/ui-slots) |
| [`client-ui-workspace`](../packages/support/invariants) | `client` | [`client-locale`](../packages/code-runtime/code-runtime-worker), [`client-runtime`](../packages/code-runtime/code-runtime), [`client-ui-primitives`](../packages/support/invariants), [`client-ui-slots`](../packages/core/session), [`invariants`](../packages/util/timeout) |
| [`code-runtime-worker`](../packages/sandbox/sandbox-local) | `code-runtime` | [`code-runtime`](../packages/support/invariants), [`invariants`](../packages/llm/llm), [`session`](../packages/sandbox/sandbox), [`timeout`](../packages/session/session-persistence) |
| [`sandbox-local`](../packages/util/brand) | `sandbox` | [`invariants`](../packages/support/invariants), [`llm`](../packages/core/session), [`sandbox`](../packages/util/timeout) |
| [`session-projection`](../packages/session/session-projection) | `session-projection` | [`invariants`](../packages/support/invariants), [`session`](../packages/core/session) |
| [`llm-retry`](../packages/llm/llm-retry) | `llm` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`timeout`](../packages/util/timeout) |
| [`token-meter`](../packages/llm/token-meter) | `llm` | [`compact`](../packages/compact/compact), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection) |
| [`goal`](../packages/goal/goal) | `goal` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-projection`](../packages/session/session-projection), [`type-meta`](../packages/typert/type-meta) |
| [`bash-local`](../packages/bash/bash-local) | `bash` | [`bash`](../packages/bash/bash), [`invariants`](../packages/support/invariants), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`pwsh-local`](../packages/bash/pwsh-local) | `bash` | [`bash`](../packages/bash/bash), [`invariants`](../packages/support/invariants), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`fs-local`](../packages/fs/fs-local) | `fs` | [`fs`](../packages/fs/fs), [`invariants`](../packages/support/invariants) |
| [`fs-policy`](../packages/fs/fs-policy) | `fs` | [`fs`](../packages/fs/fs), [`invariants`](../packages/support/invariants) |
| [`skill-local`](../packages/skill/skill-local) | `skill` | [`fs`](../packages/fs/fs), [`invariants`](../packages/support/invariants), [`paths`](../packages/util/paths), [`skill`](../packages/skill/skill) |
| [`web-search-deepseek`](../packages/web/web-search-deepseek) | `web` | [`agent`](../packages/core/agent), [`credentials`](../packages/credentials/credentials), [`environment`](../packages/util/environment), [`invariants`](../packages/support/invariants), [`session`](../packages/core/session), [`web`](../packages/web/web) |
| [`spill-local`](../packages/spill/spill-local) | `spill` | [`invariants`](../packages/support/invariants), [`spill`](../packages/spill/spill) |
| [`hook-protocol`](../packages/hooks/hook-protocol) | `hooks` | [`bash`](../packages/bash/bash), [`invariants`](../packages/support/invariants), [`session`](../packages/core/session) |
| [`session-persistence-jsonl`](../packages/support/llm-replay) | `session-persistence` | [`invariants`](../packages/compact/compact), [`session`](../packages/support/invariants), [`session-persistence`](../packages/llm/llm) |
| [`session-persistence-sqlite`](../packages/core/session) | `session-persistence` | [`invariants`](../packages/support/loader-smoke), [`session`](../packages/core/agent), [`session-persistence`](../packages/support/invariants) |
| [`session-title`](../packages/llm/llm) | `session-title` | [`brand`](../packages/core/session), [`invariants`](../packages/bundle/headless), [`llm`](../packages/core/agent), [`session`](../packages/host/apiproxy), [`session-projection`](../packages/host/webserver) |
| [`llm-replay`](../packages/support/invariants) | `support` | [`compact`](../packages/core/session), [`invariants`](../packages/client/ui-layout), [`llm`](../packages/client/runtime), [`session`](../packages/client/ui-slots) |
| [`loader-smoke`](../packages/client/ui-theme) | `support` | [`agent`](../packages/support/invariants), [`invariants`](../packages/context/time-context), [`llm`](../packages/core/agent), [`session`](../packages/support/invariants) |
| [`commands`](../packages/core/session) | `ui` | [`agent`](../packages/context/tmux-context), [`brand`](../packages/core/agent), [`invariants`](../packages/bash/bash), [`scope`](../packages/support/invariants), [`session`](../packages/core/session) |
| [`user-approval`](../packages/e2b/fs-e2b) | `ui` | [`agent`](../packages/e2b/e2b), [`brand`](../packages/fs/fs), [`invariants`](../packages/support/invariants), [`llm`](../packages/host/directory-picker-browse), [`scope`](../packages/client/locale), [`session`](../packages/client/runtime), [`system-prompt`](../packages/client/ui-primitives) |
| [`user-interaction`](../packages/client/ui-slots) | `ui` | [`agent`](../packages/client/ui-workspace), [`invariants`](../packages/support/invariants), [`llm`](../packages/host/directory-picker-native) |
| [`headless`](../packages/client/runtime) | `bundle` | [`agent`](../packages/client/ui-slots), [`host-apiproxy`](../packages/client/ui-workspace), [`host-webserver`](../packages/support/invariants), [`invariants`](../packages/interaction/commands), [`session`](../packages/core/agent) |
| [`client-ui-layout`](../packages/util/brand) | `client` | [`client-runtime`](../packages/support/invariants), [`client-ui-slots`](../packages/core/scope), [`client-ui-theme`](../packages/core/session), [`invariants`](../packages/interaction/user-approval) |
| [`time-context`](../packages/core/agent) | `context` | [`agent`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`session`](../packages/llm/llm) |
| [`tmux-context`](../packages/core/scope) | `context` | [`agent`](../packages/core/session), [`bash`](../packages/core/system-prompt), [`invariants`](../packages/interaction/user-interaction), [`session`](../packages/core/agent) |
| [`fs-e2b`](../packages/support/invariants) | `e2b` | [`e2b`](../packages/llm/llm), [`fs`](../packages/lsp/lsp-local), [`invariants`](../packages/util/brand) |
| [`host-directory-picker-browse`](../packages/fs/fs) | `host` | [`client-locale`](../packages/support/invariants), [`client-runtime`](../packages/llm/llm), [`client-ui-primitives`](../packages/lsp/lsp), [`client-ui-slots`](../packages/subprocess/subprocess), [`client-ui-workspace`](../packages/util/timeout), [`invariants`](../packages/pty/pty) |
| [`host-directory-picker-native`](../packages/core/agent) | `host` | [`client-runtime`](../packages/util/brand), [`client-ui-slots`](../packages/support/invariants), [`client-ui-workspace`](../packages/sandbox/sandbox-policy), [`invariants`](../packages/core/agent) |
| [`lsp-local`](../packages/support/invariants) | `lsp` | [`brand`](../packages/sandbox/sandbox), [`fs`](../packages/core/session), [`invariants`](../packages/core/system-prompt), [`llm`](../packages/scaffold/scripts), [`lsp`](../packages/boot/app-boot), [`subprocess`](../packages/support/invariants), [`timeout`](../packages/session/session-persistence-jsonl) |
| [`pty`](../packages/support/invariants) | `pty` | [`agent`](../packages/core/session), [`brand`](../packages/session/session-persistence), [`invariants`](../packages/session/session-persistence-sqlite) |
| [`sandbox-policy`](../packages/support/invariants) | `sandbox` | [`agent`](../packages/core/session), [`invariants`](../packages/session/session-persistence), [`sandbox`](../packages/session/session-projection-cache), [`session`](../packages/support/invariants), [`system-prompt`](../packages/core/session) |
| [`scripts`](../packages/session/session-persistence) | `sdk` | [`app-boot`](../packages/session/session-projection), [`invariants`](../packages/storage/storage-domain) |
| [`session-projection-cache`](../packages/session/session-telemetry) | `session-projection` | [`invariants`](../packages/core/agent), [`session`](../packages/support/invariants), [`session-persistence`](../packages/core/session), [`session-projection`](../packages/session/session-title), [`storage-domain`](../packages/util/brand) |
| [`tasks`](../packages/support/invariants) | `tasks` | [`agent`](../packages/llm/llm), [`brand`](../packages/core/session), [`invariants`](../packages/session/session-projection), [`session`](../packages/tasks/tasks) |
| [`session-telemetry`](../packages/core/agent) | `telemetry` | [`agent`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`session`](../packages/core/session) |
| [`workflow`](../packages/workflow/workflow) | `workflow` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`workspace`](../packages/workspace/workspace) | `workspace` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`storage`](../packages/storage/storage), [`storage-domain`](../packages/storage/storage-domain) |
| [`tools`](../packages/core/tools) | `core` | [`agent`](../packages/core/agent), [`code-runtime`](../packages/code-runtime/code-runtime), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`user-approval`](../packages/interaction/user-approval) |
| [`command-goal`](../packages/goal/command-goal) | `goal` | [`commands`](../packages/interaction/commands), [`goal`](../packages/goal/goal), [`invariants`](../packages/support/invariants) |
| [`goal-session`](../packages/goal/goal-session) | `goal` | [`agent`](../packages/core/agent), [`goal`](../packages/goal/goal), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session) |
| [`bash-sandbox`](../packages/bash/bash-sandbox) | `bash` | [`bash`](../packages/bash/bash), [`bash-local`](../packages/bash/bash-local), [`invariants`](../packages/support/invariants), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy) |
| [`fs-sandbox`](../packages/fs/fs-sandbox) | `fs` | [`fs`](../packages/fs/fs), [`fs-local`](../packages/fs/fs-local), [`invariants`](../packages/support/invariants), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy) |
| [`command-compact`](../packages/compact/command-compact) | `compact` | [`commands`](../packages/interaction/commands), [`compact`](../packages/compact/compact), [`invariants`](../packages/support/invariants) |
| [`compact-tool-result-prune`](../packages/compact/compact-tool-result-prune) | `compact` | [`compact`](../packages/compact/compact), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`token-meter`](../packages/llm/token-meter) |
| [`session-query`](../packages/session-query/session-query) | `session-query` | [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`session-title`](../packages/session/session-title) |
| [`session-title-llm`](../packages/acp/acp) | `session-title` | [`invariants`](../packages/core/agent), [`llm`](../packages/support/invariants), [`session`](../packages/core/session), [`session-title`](../packages/interaction/user-approval), [`timeout`](../packages/api/remotes) |
| [`acp`](../packages/core/agent) | `acp` | [`agent`](../packages/goal/goal), [`invariants`](../packages/support/invariants), [`session`](../packages/core/session), [`user-approval`](../packages/session/session-persistence) |
| [`permission`](../packages/typert/registry) | `ui` | [`bash`](../packages/client/ui-conversation), [`commands`](../packages/client/locale), [`invariants`](../packages/client/runtime), [`sandbox`](../packages/client/ui-primitives), [`sandbox-policy`](../packages/client/ui-slash), [`session`](../packages/client/ui-slots), [`session-projection`](../packages/support/invariants), [`settings`](../packages/llm/token-meter), [`user-approval`](../packages/feedback/command-feedback) |
| [`api-remotes`](../packages/interaction/commands) | `api` | [`agent`](../packages/support/invariants), [`goal`](../packages/core/session), [`invariants`](../packages/host/directory-picker-auto), [`session`](../packages/host/directory-picker-browse), [`session-persistence`](../packages/host/directory-picker-native), [`typert-registry`](../packages/host/webserver) |
| [`client-ui-conversation`](../packages/support/invariants) | `client` | [`client-locale`](../packages/interaction/permission), [`client-runtime`](../packages/bash/bash), [`client-ui-primitives`](../packages/interaction/commands), [`client-ui-slash`](../packages/support/invariants), [`client-ui-slots`](../packages/sandbox/sandbox), [`invariants`](../packages/sandbox/sandbox-policy), [`token-meter`](../packages/core/session) |
| [`command-feedback`](../packages/session/session-projection) | `feedback` | [`commands`](../packages/settings/settings), [`invariants`](../packages/interaction/user-approval), [`session`](../packages/pty/pty-local) |
| [`host-directory-picker-auto`](../packages/core/agent) | `host` | [`host-directory-picker-browse`](../packages/support/invariants), [`host-directory-picker-native`](../packages/pty/pty), [`host-webserver`](../packages/sandbox/sandbox), [`invariants`](../packages/sandbox/sandbox-policy) |
| [`pty-local`](../packages/core/session) | `pty` | [`agent`](../packages/subprocess/subprocess), [`invariants`](../packages/session/session-title-llm), [`pty`](../packages/support/invariants), [`sandbox`](../packages/llm/llm), [`sandbox-policy`](../packages/core/session), [`session`](../packages/session/session-title), [`subprocess`](../packages/util/timeout) |
| [`tasks-local`](../packages/tasks/tasks-local) | `tasks` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`tasks`](../packages/tasks/tasks), [`timeout`](../packages/util/timeout) |
| [`agent-loop`](../packages/core/agent-loop) | `core` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`tool-goal`](../packages/goal/tool-goal) | `goal` | [`agent`](../packages/core/agent), [`goal`](../packages/goal/goal), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools) |
| [`bash-env`](../packages/bash/bash-env) | `bash` | [`bash`](../packages/bash/bash), [`invariants`](../packages/support/invariants), [`paths`](../packages/util/paths), [`session-persistence`](../packages/session/session-persistence), [`tools`](../packages/core/tools) |
| [`tool-fs`](../packages/fs/tool-fs) | `fs` | [`fs`](../packages/fs/fs), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`session`](../packages/core/session), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`user-approval`](../packages/interaction/user-approval) |
| [`tool-fs-search`](../packages/fs/tool-fs-search) | `fs` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`retention`](../packages/util/retention), [`session`](../packages/core/session), [`spill`](../packages/spill/spill), [`subprocess`](../packages/subprocess/subprocess), [`system-prompt`](../packages/core/system-prompt), [`timeout`](../packages/util/timeout), [`tools`](../packages/core/tools) |
| [`tool-str-replace-editor`](../packages/fs/tool-str-replace-editor) | `fs` | [`fs`](../packages/fs/fs), [`invariants`](../packages/support/invariants), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`tools`](../packages/core/tools) |
| [`tool-skill`](../packages/skill/tool-skill) | `skill` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`skill`](../packages/skill/skill), [`tools`](../packages/core/tools) |
| [`compact-basic`](../packages/compact/compact-basic) | `compact` | [`agent`](../packages/core/agent), [`compact`](../packages/compact/compact), [`compact-tool-result-prune`](../packages/compact/compact-tool-result-prune), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`token-meter`](../packages/llm/token-meter) |
| [`subagent`](../packages/subagent/subagent) | `subagent` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`scope`](../packages/core/scope), [`session`](../packages/core/session), [`session-persistence`](../packages/session/session-persistence), [`session-projection`](../packages/session/session-projection), [`session-projection-cache`](../packages/session/session-projection-cache), [`tasks`](../packages/tasks/tasks), [`tools`](../packages/core/tools) |
| [`tool-web`](../packages/web/tool-web) | `web` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`web`](../packages/web/web) |
| [`spill-policy`](../packages/spill/spill-policy) | `spill` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`retention`](../packages/util/retention), [`session`](../packages/core/session), [`spill`](../packages/spill/spill), [`tools`](../packages/core/tools) |
| [`timeout-policy`](../packages/todo/tool-todo) | `timeout` | [`invariants`](../packages/core/agent), [`llm`](../packages/support/invariants), [`timeout`](../packages/core/session), [`tools`](../packages/session/session-projection) |
| [`tool-todo`](../packages/core/tools) | `todo` | [`agent`](../packages/plan/plan-mode), [`invariants`](../packages/core/agent), [`session`](../packages/interaction/commands), [`session-projection`](../packages/support/invariants), [`tools`](../packages/llm/llm) |
| [`plan-mode`](../packages/core/session) | `plan` | [`agent`](../packages/session/session-projection), [`commands`](../packages/core/system-prompt), [`invariants`](../packages/core/tools), [`llm`](../packages/interaction/user-interaction), [`session`](../packages/hooks/hooks-codex), [`session-projection`](../packages/core/agent), [`system-prompt`](../packages/hooks/hook-protocol), [`tools`](../packages/support/invariants), [`user-interaction`](../packages/llm/llm) |
| [`tool-cordis`](../packages/core/session) | `cordis` | [`invariants`](../packages/session/session-persistence), [`scope`](../packages/core/tools), [`tools`](../packages/session-query/session-query-sqlite) |
| [`hooks-codex`](../packages/support/invariants) | `hooks` | [`agent`](../packages/core/session), [`hook-protocol`](../packages/session/session-persistence), [`invariants`](../packages/session-query/session-query), [`llm`](../packages/session-query/tool-session-query), [`session`](../packages/support/invariants), [`session-persistence`](../packages/llm/llm), [`tools`](../packages/core/session) |
| [`session-checkpoint-policy`](../packages/session-query/session-query) | `session-persistence` | [`agent`](../packages/core/system-prompt), [`invariants`](../packages/util/timeout), [`llm`](../packages/core/tools), [`session`](../packages/support/agent-loop-testkit), [`session-persistence`](../packages/core/agent), [`tools`](../packages/support/invariants) |
| [`session-query-sqlite`](../packages/llm/llm) | `session-query` | [`invariants`](../packages/core/session), [`session`](../packages/core/system-prompt), [`session-persistence`](../packages/core/tools), [`session-query`](../packages/client/ui-command) |
| [`tool-session-query`](../packages/client/connection) | `session-query` | [`invariants`](../packages/client/locale), [`llm`](../packages/client/runtime), [`session`](../packages/client/ui-conversation), [`session-query`](../packages/client/ui-primitives), [`system-prompt`](../packages/client/ui-slash), [`timeout`](../packages/client/ui-slots), [`tools`](../packages/support/invariants) |
| [`session-title-all-messages-llm`](../packages/client/ui-deliverables) | `session-title` | [`invariants`](../packages/client/locale), [`llm`](../packages/client/runtime), [`session`](../packages/client/ui-conversation), [`session-title`](../packages/client/ui-slots), [`session-title-llm`](../packages/support/invariants) |
| [`session-title-first-message-llm`](../packages/client/ui-goal) | `session-title` | [`invariants`](../packages/api/remotes), [`llm`](../packages/client/locale), [`session`](../packages/client/runtime), [`session-title`](../packages/client/ui-conversation), [`session-title-llm`](../packages/client/ui-primitives) |
| [`agent-loop-testkit`](../packages/client/ui-slots) | `support` | [`agent`](../packages/goal/goal), [`invariants`](../packages/support/invariants), [`llm`](../packages/client/ui-tool), [`session`](../packages/client/locale), [`system-prompt`](../packages/client/runtime), [`tools`](../packages/client/ui-conversation) |
| [`tool-ask-user`](../packages/client/ui-primitives) | `ui` | [`agent`](../packages/client/ui-slots), [`invariants`](../packages/support/invariants), [`tools`](../packages/context/session-reference), [`user-interaction`](../packages/core/agent) |
| [`client-ui-command`](../packages/compact/compact) | `client` | [`client-connection`](../packages/support/invariants), [`client-locale`](../packages/llm/llm), [`client-runtime`](../packages/util/retention), [`client-ui-conversation`](../packages/core/session), [`client-ui-primitives`](../packages/session-query/session-query), [`client-ui-slash`](../packages/context/workspace-context), [`client-ui-slots`](../packages/core/agent), [`invariants`](../packages/fs/fs) |
| [`client-ui-deliverables`](../packages/support/invariants) | `client` | [`client-locale`](../packages/llm/llm), [`client-runtime`](../packages/util/paths), [`client-ui-conversation`](../packages/core/session), [`client-ui-slots`](../packages/core/tools), [`invariants`](../packages/guard/repeat-tool-guard) |
| [`client-ui-goal`](../packages/core/agent) | `client` | [`api-remotes`](../packages/support/invariants), [`client-locale`](../packages/core/tools), [`client-runtime`](../packages/guard/timeout-policy), [`client-ui-conversation`](../packages/support/invariants), [`client-ui-primitives`](../packages/llm/llm), [`client-ui-slots`](../packages/util/timeout), [`goal`](../packages/core/tools), [`invariants`](../packages/interaction/tool-ask-user) |
| [`client-ui-tool`](../packages/core/agent) | `client` | [`client-locale`](../packages/support/invariants), [`client-runtime`](../packages/core/tools), [`client-ui-conversation`](../packages/interaction/user-interaction), [`client-ui-primitives`](../packages/lsp/tool-lsp), [`client-ui-slots`](../packages/support/invariants), [`invariants`](../packages/llm/llm) |
| [`session-reference`](../packages/lsp/lsp) | `context` | [`agent`](../packages/core/system-prompt), [`compact`](../packages/util/timeout), [`invariants`](../packages/core/tools), [`llm`](../packages/mcp/mcp-client), [`retention`](../packages/support/invariants), [`session`](../packages/llm/llm), [`session-query`](../packages/subprocess/subprocess) |
| [`workspace-context`](../packages/core/tools) | `context` | [`agent`](../packages/pty/tool-bash-persistent), [`fs`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/pty/pty), [`paths`](../packages/util/timeout), [`session`](../packages/core/tools), [`tools`](../packages/pty/tool-pty) |
| [`repeat-tool-guard`](../packages/core/agent) | `guard` | [`agent`](../packages/support/invariants), [`invariants`](../packages/llm/llm), [`tools`](../packages/pty/pty) |
| [`tool-lsp`](../packages/util/retention) | `lsp` | [`invariants`](../packages/core/system-prompt), [`llm`](../packages/tasks/tasks), [`lsp`](../packages/core/tools), [`system-prompt`](../packages/self-modification/tool-cordis), [`timeout`](../packages/support/invariants), [`tools`](../packages/core/scope) |
| [`mcp-client`](../packages/core/tools) | `mcp` | [`invariants`](../packages/session/session-checkpoint-policy), [`llm`](../packages/core/agent), [`subprocess`](../packages/support/invariants), [`tools`](../packages/llm/llm) |
| [`tool-bash-persistent`](../packages/core/session) | `pty` | [`agent`](../packages/session/session-persistence), [`invariants`](../packages/core/tools), [`pty`](../packages/session/session-telemetry-otel), [`timeout`](../packages/util/brand), [`tools`](../packages/feedback/command-feedback) |
| [`tool-pty`](../packages/support/invariants) | `pty` | [`agent`](../packages/llm/llm), [`invariants`](../packages/util/paths), [`llm`](../packages/core/session), [`pty`](../packages/session/session-telemetry), [`retention`](../packages/session/session-title-all-messages-llm), [`system-prompt`](../packages/support/invariants), [`tasks`](../packages/llm/llm), [`tools`](../packages/core/session) |
| [`tool-tasks`](../packages/session/session-title) | `tasks` | [`agent`](../packages/session/session-title-llm), [`invariants`](../packages/session/session-title-first-message-llm), [`llm`](../packages/support/invariants), [`retention`](../packages/llm/llm), [`system-prompt`](../packages/core/session), [`tasks`](../packages/session/session-title), [`tools`](../packages/session/session-title-llm) |
| [`session-telemetry-otel`](../packages/tasks/tool-tasks) | `telemetry` | [`brand`](../packages/core/agent), [`command-feedback`](../packages/support/invariants), [`invariants`](../packages/llm/llm), [`llm`](../packages/util/retention), [`paths`](../packages/core/system-prompt), [`session`](../packages/tasks/tasks), [`session-telemetry`](../packages/core/tools) |
| [`tool-workflow`](../packages/workflow/tool-workflow) | `workflow` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`workflow`](../packages/workflow/workflow) |
| [`tool-bash`](../packages/bash/tool-bash) | `bash` | [`agent`](../packages/core/agent), [`bash`](../packages/bash/bash), [`bash-env`](../packages/bash/bash-env), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`sandbox`](../packages/sandbox/sandbox), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`system-prompt`](../packages/core/system-prompt), [`tasks`](../packages/tasks/tasks), [`tools`](../packages/core/tools), [`user-approval`](../packages/interaction/user-approval) |
| [`tool-pwsh`](../packages/bash/tool-pwsh) | `bash` | [`agent`](../packages/core/agent), [`bash`](../packages/bash/bash), [`bash-env`](../packages/bash/bash-env), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`system-prompt`](../packages/core/system-prompt), [`tasks`](../packages/tasks/tasks), [`tools`](../packages/core/tools) |
| [`subagent-acp`](../packages/subagent/subagent-acp) | `subagent` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`subagent-claude-code`](../packages/subagent/subagent-claude-code) | `subagent` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`subagent-inprocess`](../packages/subagent/subagent-inprocess) | `subagent` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`sandbox-policy`](../packages/sandbox/sandbox-policy), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`user-approval`](../packages/interaction/user-approval) |
| [`tool-subagent`](../packages/subagent/tool-subagent) | `subagent` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`subagent`](../packages/subagent/subagent), [`tasks`](../packages/tasks/tasks), [`tools`](../packages/core/tools) |
| [`tool-subagent-control`](../packages/subagent/tool-subagent-control) | `subagent` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`tools`](../packages/core/tools) |
| [`tool-subagent-report`](../packages/subagent/tool-subagent-report) | `subagent` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`subagent`](../packages/subagent/subagent), [`tools`](../packages/core/tools) |
| [`repository-plugin`](../packages/hooks/hooks-claude) | `cordis` | [`invariants`](../packages/core/agent), [`mcp-client`](../packages/hooks/hook-protocol), [`paths`](../packages/support/invariants), [`skill-local`](../packages/llm/llm) |
| [`hooks-claude`](../packages/core/session) | `hooks` | [`agent`](../packages/session/session-persistence), [`hook-protocol`](../packages/subagent/subagent), [`invariants`](../packages/core/tools), [`llm`](../packages/bundle/web-app), [`session`](../packages/bash/bash-env), [`session-persistence`](../packages/support/invariants), [`subagent`](../packages/core/system-prompt), [`tools`](../packages/client/ui-model) |
| [`web-app`](../packages/client/connection) | `bundle` | [`bash-env`](../packages/client/locale), [`invariants`](../packages/client/runtime), [`system-prompt`](../packages/client/ui-command) |
| [`client-ui-model`](../packages/client/ui-conversation) | `client` | [`client-connection`](../packages/client/ui-primitives), [`client-locale`](../packages/client/ui-slash), [`client-runtime`](../packages/client/ui-slots), [`client-ui-command`](../packages/support/invariants), [`client-ui-conversation`](../packages/client/ui-permission), [`client-ui-primitives`](../packages/client/connection), [`client-ui-slash`](../packages/client/locale), [`client-ui-slots`](../packages/client/runtime), [`invariants`](../packages/client/schema-form) |
| [`client-ui-permission`](../packages/client/ui-command) | `client` | [`client-connection`](../packages/client/ui-primitives), [`client-locale`](../packages/client/ui-slash), [`client-runtime`](../packages/client/ui-slots), [`client-schema-form`](../packages/support/invariants), [`client-ui-command`](../packages/interaction/permission), [`client-ui-primitives`](../packages/client/ui-plan), [`client-ui-slash`](../packages/client/connection), [`client-ui-slots`](../packages/client/locale), [`invariants`](../packages/client/runtime), [`permission`](../packages/client/ui-conversation) |
| [`client-ui-plan`](../packages/client/ui-primitives) | `client` | [`client-connection`](../packages/client/ui-slots), [`client-locale`](../packages/support/invariants), [`client-runtime`](../packages/plan/plan-mode), [`client-ui-conversation`](../packages/client/ui-skill), [`client-ui-primitives`](../packages/client/connection), [`client-ui-slots`](../packages/client/locale), [`invariants`](../packages/client/runtime), [`plan-mode`](../packages/client/ui-primitives) |
| [`client-ui-skill`](../packages/client/ui-slash) | `client` | [`client-connection`](../packages/client/ui-slots), [`client-locale`](../packages/client/ui-tool), [`client-runtime`](../packages/support/invariants), [`client-ui-primitives`](../packages/client/ui-subagent), [`client-ui-slash`](../packages/client/locale), [`client-ui-slots`](../packages/client/runtime), [`client-ui-tool`](../packages/client/ui-conversation), [`invariants`](../packages/client/ui-primitives) |
| [`client-ui-subagent`](../packages/client/ui-slash) | `client` | [`client-locale`](../packages/client/ui-slots), [`client-runtime`](../packages/support/invariants), [`client-ui-conversation`](../packages/subagent/subagent), [`client-ui-primitives`](../packages/llm/token-meter), [`client-ui-slash`](../packages/scaffold/protocol), [`client-ui-slots`](../packages/support/invariants), [`invariants`](../packages/llm/llm), [`subagent`](../packages/core/session), [`token-meter`](../packages/subagent/subagent) |
| [`sdk-protocol`](../packages/self-modification/repository-plugin) | `sdk` | [`invariants`](../packages/support/invariants), [`llm`](../packages/mcp/mcp-client), [`session`](../packages/util/paths), [`subagent`](../packages/skill/skill-local) |
| [`tool-ralph`](../packages/workflow/tool-ralph) | `workflow` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`subagent`](../packages/subagent/subagent), [`system-prompt`](../packages/core/system-prompt), [`tools`](../packages/core/tools), [`workflow`](../packages/workflow/workflow) |
| [`workflow-workerthread`](../packages/workflow/workflow-workerthread) | `workflow` | [`agent`](../packages/core/agent), [`brand`](../packages/util/brand), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`tools`](../packages/core/tools), [`workflow`](../packages/workflow/workflow) |
| [`subagent-codex`](../packages/subagent/subagent-codex) | `subagent` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`sdk-protocol`](../packages/scaffold/protocol), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subprocess`](../packages/subprocess/subprocess), [`timeout`](../packages/util/timeout) |
| [`subagent-fork`](../packages/subagent/subagent-fork) | `subagent` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subagent-inprocess`](../packages/subagent/subagent-inprocess) |
| [`subagent-spawn`](../packages/subagent/subagent-spawn) | `subagent` | [`invariants`](../packages/support/invariants), [`subagent`](../packages/subagent/subagent), [`subagent-inprocess`](../packages/subagent/subagent-inprocess) |
| [`jsonrpc`](../packages/examples/agent-spine-demo) | `ui` | [`agent`](../packages/core/agent), [`invariants`](../packages/core/agent-loop), [`llm`](../packages/bash/bash-env), [`llm-deepseek`](../packages/goal/goal), [`scope`](../packages/goal/goal-session), [`sdk-protocol`](../packages/support/invariants), [`session`](../packages/llm/llm), [`subagent`](../packages/llm/llm-retry) |
| [`agent-spine-demo`](../packages/util/paths) | `examples` | [`agent`](../packages/core/scope), [`agent-loop`](../packages/core/session), [`bash-env`](../packages/session/session-title), [`goal`](../packages/skill/skill), [`goal-session`](../packages/skill/skill-local), [`invariants`](../packages/core/system-prompt), [`llm`](../packages/tasks/tasks-local), [`llm-retry`](../packages/bash/tool-bash), [`paths`](../packages/goal/tool-goal), [`scope`](../packages/skill/tool-skill), [`session`](../packages/tasks/tool-tasks), [`session-title`](../packages/core/tools), [`skill`](../packages/context/workspace-context), [`skill-local`](../packages/scaffold/server), [`system-prompt`](../packages/core/agent), [`tasks-local`](../packages/support/invariants), [`tool-bash`](../packages/llm/llm), [`tool-goal`](../packages/llm/llm-deepseek), [`tool-skill`](../packages/core/scope), [`tool-tasks`](../packages/scaffold/protocol), [`tools`](../packages/core/session), [`workspace-context`](../packages/subagent/subagent) |
| [`sdk-client`](../packages/scaffold/client) | `sdk` | [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`sdk-protocol`](../packages/scaffold/protocol), [`session`](../packages/core/session) |
| [`subagent-dsh-sdk`](../packages/subagent/subagent-dsh-sdk) | `subagent` | [`agent`](../packages/core/agent), [`invariants`](../packages/support/invariants), [`llm`](../packages/llm/llm), [`sdk-client`](../packages/scaffold/client), [`session`](../packages/core/session), [`subagent`](../packages/subagent/subagent), [`subprocess`](../packages/subprocess/subprocess) |
| [`acp-demo`](../packages/examples/acp-demo) | `examples` | [`acp`](../packages/acp/acp), [`agent-spine-demo`](../packages/examples/agent-spine-demo), [`app-boot`](../packages/boot/app-boot), [`invariants`](../packages/support/invariants), [`session-checkpoint-policy`](../packages/session/session-checkpoint-policy), [`session-persistence-jsonl`](../packages/session/session-persistence-jsonl), [`session-query`](../packages/session-query/session-query), [`session-query-sqlite`](../packages/session-query/session-query-sqlite), [`tools`](../packages/core/tools), [`workspace-context`](../packages/context/workspace-context) |
