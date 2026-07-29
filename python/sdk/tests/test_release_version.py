"""Tests for repository-owned Python release versions."""

from __future__ import annotations

import json
import runpy
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "build-python-release.py"
build_python_release = SimpleNamespace(**runpy.run_path(str(SCRIPT)))


def test_repository_version_matches_root_package_json() -> None:
    expected = json.loads((ROOT / "package.json").read_text())["version"]

    assert build_python_release.repository_version() == expected


def test_release_tag_is_optional_for_non_release_builds() -> None:
    build_python_release.validate_release_tag(None, "1.2.3")


def test_release_tag_must_match_repository_version() -> None:
    build_python_release.validate_release_tag("python-v1.2.3", "1.2.3")

    with pytest.raises(ValueError, match="expected 'python-v1.2.3'"):
        build_python_release.validate_release_tag("python-v1.2.4", "1.2.3")


def test_repository_version_rejects_non_stable_versions(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"version":"1.2.3-dev"}\n')

    with pytest.raises(ValueError, match="must be stable X.Y.Z"):
        build_python_release.repository_version(tmp_path)


def test_stage_runtime_copies_executable_and_spawn_helper(tmp_path: Path) -> None:
    executable = tmp_path / "dsh-jsonrpc-agent-pkg-macos-arm64"
    executable.write_bytes(b"runtime")
    executable.chmod(0o755)
    spawn_helper = Path(f"{executable}-spawn-helper")
    spawn_helper.write_bytes(b"helper")
    spawn_helper.chmod(0o751)
    destination = tmp_path / "staging"

    build_python_release.stage_runtime(
        destination,
        "1.2.3",
        executable,
        executable.name,
    )

    runtime_dir = destination / "src" / "deepseek_harness_runtime" / "runtime"
    assert (runtime_dir / executable.name).read_bytes() == b"runtime"
    copied_helper = runtime_dir / spawn_helper.name
    assert copied_helper.read_bytes() == b"helper"
    assert copied_helper.stat().st_mode & stat.S_IXUSR


def test_stage_runtime_rejects_missing_spawn_helper(tmp_path: Path) -> None:
    executable = tmp_path / "dsh-jsonrpc-agent-pkg-linux-x64"
    executable.write_bytes(b"runtime")
    executable.chmod(0o755)

    with pytest.raises(FileNotFoundError, match="spawn helper"):
        build_python_release.stage_runtime(
            tmp_path / "staging",
            "1.2.3",
            executable,
            executable.name,
        )
