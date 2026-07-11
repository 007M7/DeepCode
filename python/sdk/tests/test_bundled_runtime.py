"""Smoke tests against the bundled dsh-jsonrpc-agent artifacts.

These boot the runtime the way an installed SDK does, once per bundled
carrier: the platform single-file exe (production) and the dev-only node
closure under ``runtime/node`` driven by system ``node``. Each carrier skips
independently when its artifact is absent on this machine — build or fetch it
per the FileNotFoundError guidance quoted in the skip reason. Keyless: the
dummy DEEPSEEK_API_KEY only satisfies the adapter's load-time check;
initialize/shutdown never call a model.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness, HarnessClient, HarnessConfig
from deepseek_harness.errors import TransportClosedError
from deepseek_harness_runtime import resolve_bundled_launch_args

_MODES = ("exe", "node")

# The serving surface is itself a plugin: without the dsh-jsonrpc entry the
# runtime boots an agent nobody can talk to and exits 0 on stdin EOF.
_CORDIS_YML = """\
- id: jsonrpc
  name: '@deepseek-ai/dsh-jsonrpc'
- id: agent-core
  name: '@deepseek-ai/dsh-agent-core'
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: './sessions'
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: '.'
- id: todo
  name: '@deepseek-ai/dsh-tool-todo'
"""


def _launch_args(mode: str) -> tuple[str, ...]:
    try:
        return resolve_bundled_launch_args(mode)
    except FileNotFoundError as exc:
        pytest.skip(f"bundled {mode}-mode runtime unavailable on this machine: {exc}")


def _client(tmp_path: Path, launch_args: tuple[str, ...]) -> HarnessClient:
    return HarnessClient(
        HarnessConfig(
            launch_args_override=launch_args,
            cwd=str(tmp_path),
            env={
                "DSH_CORDIS_CONFIG": "./cordis.yml",
                "DSH_SESSION_ROOT": str(tmp_path / "sessions"),
                "DSH_CWD": str(tmp_path),
                # initialize() lazily mounts the llm-deepseek adapter for the
                # requested model; a dummy key keeps the keyless boot green
                # (initialize/shutdown never call the model).
                "DEEPSEEK_API_KEY": "sk-dummy-for-boot",
                "DEEPSEEK_BASE_URL": "http://127.0.0.1:9",
            },
            request_timeout_seconds=120,
        )
    )


@pytest.mark.parametrize("mode", _MODES)
def test_bundled_runtime_boots_a_cordis_config(tmp_path: Path, mode: str) -> None:
    launch_args = _launch_args(mode)
    (tmp_path / "cordis.yml").write_text(_CORDIS_YML)

    with _client(tmp_path, launch_args) as client:
        init = client.initialize(cwd=str(tmp_path), model="deepseek-v4-pro")

    assert init.serverInfo is not None
    assert init.serverInfo.name == "deepseek-harness-sdk-runtime"


@pytest.mark.parametrize("mode", _MODES)
def test_bundled_runtime_surfaces_unbundled_plugin_failure(tmp_path: Path, mode: str) -> None:
    launch_args = _launch_args(mode)
    (tmp_path / "cordis.yml").write_text(
        "- id: missing\n  name: '@deepseek-ai/dsh-does-not-exist'\n"
    )

    client = _client(tmp_path, launch_args)
    client.start()
    try:
        with pytest.raises((TransportClosedError, TimeoutError)) as excinfo:
            client.initialize(cwd=str(tmp_path), model="deepseek-v4-pro")
    finally:
        client.close()

    assert "@deepseek-ai/dsh-does-not-exist" in str(excinfo.value)


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.parametrize("ambient_config", [None, ""], ids=["unset", "empty-counts-as-absent"])
def test_zero_config_run_injects_bundled_default_cordis_config(
    tmp_path: Path, mode: str, ambient_config: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _launch_args(mode)  # skip early when this carrier is unavailable
    monkeypatch.setenv("DSH_RUNTIME_MODE", mode)
    if ambient_config is None:
        monkeypatch.delenv("DSH_CORDIS_CONFIG", raising=False)
    else:
        monkeypatch.setenv("DSH_CORDIS_CONFIG", ambient_config)

    harness = DeepSeekHarness(
        model="deepseek-v4-pro",
        cwd=str(tmp_path),
        session_root=str(tmp_path / "sessions"),
        api_key="sk-dummy-for-boot",
        base_url="http://127.0.0.1:9",
        request_timeout_seconds=120,
    )
    with harness:
        # __enter__ boots the runtime, which exits with a usage error unless
        # HarnessClient.start() injected the bundled default config over the
        # unset/empty DSH_CORDIS_CONFIG; __exit__ shuts it down.
        pass
