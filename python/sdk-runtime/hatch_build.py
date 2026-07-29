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


def _spawn_helper_binary_target(header: bytes) -> str | None:
    if (
        len(header) >= 20
        and header[:4] == b"\x7fELF"
        and header[4] == 2
        and header[5] == 1
    ):
        machine = int.from_bytes(header[18:20], "little")
        if machine == 62:
            return "linux-x64"
        if machine == 183:
            return "linux-arm64"
    if len(header) >= 8 and header[:4] == b"\xcf\xfa\xed\xfe":
        if int.from_bytes(header[4:8], "little") == 0x0100000C:
            return "macos-arm64"
    return None


def _validate_spawn_helper(path: Path, expected_target: str) -> None:
    with path.open("rb") as helper:
        actual_target = _spawn_helper_binary_target(helper.read(20))
    if actual_target != expected_target:
        raise RuntimeError(
            f"runtime spawn helper binary mismatch: expected {expected_target}, "
            f"found {actual_target or 'unsupported format or architecture'} at {path}"
        )


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
        if [path.name for path in helpers] != [expected_helper]:
            found = ", ".join(path.name for path in helpers) or "none"
            raise RuntimeError(
                f"runtime wheel {platform_tag} must contain only {expected_helper}; found {found}"
            )
        for executable in [executables[0], helpers[0]]:
            if executable.stat().st_mode & stat.S_IXUSR == 0:
                raise RuntimeError(f"runtime executable is not executable: {executable}")
        _validate_spawn_helper(helpers[0], expected_target)

        build_data["pure_python"] = False
        build_data["infer_tag"] = False
        build_data["tag"] = f"py3-none-{platform_tag}"
