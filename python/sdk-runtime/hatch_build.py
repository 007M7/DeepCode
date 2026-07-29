from __future__ import annotations

import os
import platform
import stat
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


_PLATFORMS = {
    "linux-x64": ("manylinux_2_28_x86_64", "dsh-jsonrpc-agent-pkg-linux-x64"),
    "linux-arm64": ("manylinux_2_28_aarch64", "dsh-jsonrpc-agent-pkg-linux-arm64"),
    "macos-arm64": ("macosx_11_0_arm64", "dsh-jsonrpc-agent-pkg-macos-arm64"),
}
_SPAWN_HELPER_SUFFIX = "-spawn-helper"


def _host_platform_tag() -> str:
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64" if machine in {"x86_64", "amd64"} else machine
    system = platform.system().lower()
    key = f"macos-{arch}" if system == "darwin" else f"linux-{arch}" if system == "linux" else system
    try:
        return _PLATFORMS[key][0]
    except KeyError as exc:
        raise RuntimeError(f"unsupported deepseek-harness-runtime-bin build platform: {key}") from exc


class RuntimeBuildHook(BuildHookInterface):
    """Assign the native wheel tag and reject incomplete or mixed-platform payloads."""

    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        if version == "editable":
            return
        if self.target_name == "sdist":
            raise RuntimeError(
                "deepseek-harness-runtime-bin is wheel-only; build and publish platform wheels only."
            )

        platform_tag = os.environ.get("DSH_RUNTIME_PLATFORM_TAG") or _host_platform_tag()
        matches = [(key, value) for key, value in _PLATFORMS.items() if value[0] == platform_tag]
        if len(matches) != 1:
            supported = ", ".join(value[0] for value in _PLATFORMS.values())
            raise RuntimeError(
                f"unsupported DSH_RUNTIME_PLATFORM_TAG {platform_tag!r}; expected one of {supported}"
            )
        expected_target, (_, expected_executable) = matches[0]
        runtime_dir = Path(self.root) / "src" / "deepseek_harness_runtime" / "runtime"
        runtime_files = sorted(runtime_dir.glob("dsh-jsonrpc-agent-pkg-*") if runtime_dir.is_dir() else [])
        executables = [path for path in runtime_files if not path.name.endswith(_SPAWN_HELPER_SUFFIX)]
        helpers = [path for path in runtime_files if path.name.endswith(_SPAWN_HELPER_SUFFIX)]
        if [path.name for path in executables] != [expected_executable]:
            found = ", ".join(path.name for path in executables) or "none"
            raise RuntimeError(
                f"runtime wheel {platform_tag} must contain only {expected_executable}; found {found}"
            )
        expected_helper = f"{expected_executable}{_SPAWN_HELPER_SUFFIX}"
        expected_helpers = [expected_helper] if expected_target.startswith("macos-") else []
        if [path.name for path in helpers] != expected_helpers:
            expected = ", ".join(expected_helpers) or "none"
            found = ", ".join(path.name for path in helpers) or "none"
            raise RuntimeError(
                f"runtime wheel {platform_tag} helper payload mismatch: expected {expected}; found {found}"
            )
        for executable in [executables[0], *helpers]:
            if executable.stat().st_mode & stat.S_IXUSR == 0:
                raise RuntimeError(f"runtime executable is not executable: {executable}")
        build_data["pure_python"] = False
        build_data["infer_tag"] = False
        build_data["tag"] = f"py3-none-{platform_tag}"
