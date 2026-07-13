#!/usr/bin/env python3
"""Keyless full-turn smoke for the SDK wrapper and direct NDJSON runtime use."""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable


EXPECTED_TEXT = "runtime smoke ok"
CUSTOM_CORDIS = """\
- id: jsonrpc
  name: '@deepseek-ai/dsh-jsonrpc'
- id: agent-core
  name: '@deepseek-ai/dsh-agent-core'
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: !!js process.env.DSH_CWD
"""


class MockModelHandler(BaseHTTPRequestHandler):
    """Return one deterministic OpenAI-compatible streaming completion."""

    requests: list[dict[str, object]] = []

    def do_POST(self) -> None:
        content_length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(content_length))
        self.requests.append(body)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        chunks = [
            {"choices": [{"delta": {"role": "assistant", "content": None, "reasoning_content": ""}}]},
            {"choices": [{"delta": {"content": EXPECTED_TEXT}}]},
            {"choices": [{"delta": {"content": ""}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 3, "completion_tokens": 3}},
        ]
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, _format: str, *_args: object) -> None:
        return


class MockModel:
    def __enter__(self) -> "MockModel":
        MockModelHandler.requests.clear()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MockModelHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.url = f"http://{host}:{port}"
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("all", "sdk-default", "sdk-custom", "direct"), default="all")
    parser.add_argument("--exe", type=Path)
    args = parser.parse_args()
    if args.scenario in {"all", "sdk-custom", "direct"} and args.exe is None:
        parser.error("--exe is required for custom and direct scenarios")
    if args.exe is not None and not args.exe.is_file():
        parser.error(f"runtime executable does not exist: {args.exe}")

    with MockModel() as model:
        if args.scenario in {"all", "sdk-default"}:
            smoke_sdk_default(model.url)
        if args.scenario in {"all", "sdk-custom"}:
            assert args.exe is not None
            smoke_sdk_custom(model.url, args.exe.resolve())
        if args.scenario in {"all", "direct"}:
            assert args.exe is not None
            smoke_direct(model.url, args.exe.resolve())
        if not MockModelHandler.requests:
            raise AssertionError("mock model endpoint received no requests")
    print(f"smoke-python-runtime: {args.scenario} passed")


def smoke_sdk_default(base_url: str) -> None:
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-default-") as temporary:
        root = Path(temporary).resolve()
        sessions = root / "sessions"
        with DeepSeekHarness(
            model="smoke-model",
            cwd=str(root),
            session_root=str(sessions),
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run("reply with the smoke text", session_id="default-smoke")
        assert result.status == "ok", result
        assert result.final_response == EXPECTED_TEXT, result.final_response
        assert_session_log(sessions, root)


def smoke_sdk_custom(base_url: str, executable: Path) -> None:
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-custom-") as temporary:
        root = Path(temporary).resolve()
        sessions = root / "sessions"
        cordis = root / "cordis.yml"
        cordis.write_text(CUSTOM_CORDIS)
        with DeepSeekHarness(
            model="smoke-model",
            cwd=str(root),
            session_root=str(sessions),
            cordis=str(cordis),
            runtime_bin=str(executable),
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run("reply with the smoke text", session_id="custom-smoke")
        assert result.status == "ok", result
        assert result.final_response == EXPECTED_TEXT, result.final_response
        assert_session_log(sessions, root)


def smoke_direct(base_url: str, executable: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="dsh-direct-") as temporary:
        root = Path(temporary).resolve()
        sessions = root / "sessions"
        cordis = root / "cordis.yml"
        cordis.write_text(CUSTOM_CORDIS)
        environment = {
            **os.environ,
            "DSH_CORDIS_CONFIG": str(cordis),
            "DSH_SESSION_ROOT": str(sessions),
            "DSH_CWD": str(root),
            "DEEPSEEK_API_KEY": "sk-keyless-smoke",
            "DEEPSEEK_BASE_URL": base_url,
        }
        peer = RuntimePeer([str(executable)], root, environment)
        try:
            peer.send({"jsonrpc": "2.0", "id": "initialize", "method": "initialize", "params": {"cwd": str(root), "model": "smoke-model"}})
            peer.read_until(lambda message: message.get("id") == "initialize")
            peer.send({
                "jsonrpc": "2.0",
                "id": "prompt",
                "method": "session/prompt",
                "params": {"sessionId": "direct-smoke", "contentBlocks": [{"type": "text", "text": "reply with the smoke text"}]},
            })
            messages = peer.read_until(lambda message: message.get("id") == "prompt")
            if not any(message.get("method") == "session.finished" and message.get("params", {}).get("status") == "ok" for message in messages):
                messages.extend(peer.read_until(lambda message: message.get("method") == "session.finished"))
            event_text = json.dumps(messages)
            if EXPECTED_TEXT not in event_text:
                raise AssertionError(f"direct runtime emitted no final response: {messages}")
            peer.send({"jsonrpc": "2.0", "id": "shutdown", "method": "shutdown"})
            peer.read_until(lambda message: message.get("id") == "shutdown")
        finally:
            peer.close()
        assert_session_log(sessions, root)


class RuntimePeer:
    def __init__(self, argv: list[str], cwd: Path, environment: dict[str, str]) -> None:
        self.process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.stdout: queue.Queue[str | None] = queue.Queue()
        self.stderr: list[str] = []
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def send(self, message: dict[str, object]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("runtime stdin is unavailable")
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def read_until(self, predicate: Callable[[dict[str, object]], bool]) -> list[dict[str, object]]:
        deadline = time.monotonic() + 60
        messages: list[dict[str, object]] = []
        while time.monotonic() < deadline:
            try:
                line = self.stdout.get(timeout=min(0.25, deadline - time.monotonic()))
            except queue.Empty:
                continue
            if line is None:
                raise RuntimeError(f"runtime exited before expected message; stderr: {''.join(self.stderr)}")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            messages.append(message)
            if predicate(message):
                return messages
        raise TimeoutError(f"runtime timed out; messages={messages}; stderr={''.join(self.stderr)}")

    def close(self) -> None:
        if self.process.stdin is not None and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        if self.process.returncode not in {0, -15}:
            raise RuntimeError(f"runtime exited {self.process.returncode}; stderr: {''.join(self.stderr)}")

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.stdout.put(line)
        self.stdout.put(None)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        self.stderr.extend(self.process.stderr)


def assert_session_log(sessions: Path, cwd: Path) -> None:
    logs = list(sessions.rglob("*.jsonl"))
    if len(logs) != 1:
        raise AssertionError(f"expected one JSONL session log under {sessions}, found {logs}")
    lines = logs[0].read_text().splitlines()
    header = json.loads(lines[0])
    if header.get("cwd") != str(cwd):
        raise AssertionError(f"session header cwd is not absolute/canonical: {header}")
    if EXPECTED_TEXT not in "\n".join(lines):
        raise AssertionError(f"session log has no final response: {logs[0]}")


if __name__ == "__main__":
    main()
