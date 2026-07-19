"""Keyless runtime-resolution tests; launch coverage lives in test_bundled_runtime.py."""

from __future__ import annotations

import pytest

from deepseek_harness_runtime import (
    RUNTIME_MODE_ENV_VAR,
    bundled_default_config_path,
    bundled_package_dir,
    resolve_bundled_launch_args,
)


def test_default_config_is_shipped_with_the_package() -> None:
    path = bundled_default_config_path()
    assert path == bundled_package_dir() / "runtime" / "cordis.yml"
    assert "@deepseek-ai/dsh-agent-spine-demo" in path.read_text()


def test_unknown_explicit_mode_fails_loud() -> None:
    with pytest.raises(ValueError, match="expected 'exe' or 'node'"):
        resolve_bundled_launch_args("bogus")


def test_unknown_env_mode_fails_loud(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(RUNTIME_MODE_ENV_VAR, "bogus")
    with pytest.raises(ValueError, match="expected 'exe' or 'node'"):
        resolve_bundled_launch_args()


def test_explicit_mode_wins_over_env_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(RUNTIME_MODE_ENV_VAR, "bogus")
    try:
        args = resolve_bundled_launch_args("exe")
    except FileNotFoundError:
        return  # explicit 'exe' was honored; only the artifact is missing
    assert args[0].endswith(("-x64", "-arm64"))
