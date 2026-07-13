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
CODE_PROMPT = "Use run_code to compute the packaged worker smoke value."
CODE_WORKER_TEXT = "code worker smoke ok"
WORKFLOW_PROMPT = "Use workflow to compute the packaged worker smoke value without agents."
WORKFLOW_WORKER_TEXT = "workflow worker smoke ok"
CUSTOM_CORDIS = """\
- id: jsonrpc
  name: '@deepseek-ai/dsh-jsonrpc'
- id: agent-core
  name: '@deepseek-ai/dsh-agent-core'
  config:
    tools:
      mode: both
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: !!js process.env.DSH_CWD
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker'
- id: subagents
  name: '@deepseek-ai/dsh-subagent'
- id: workflow-engine
  name: '@deepseek-ai/dsh-workflow-workerthread'
  config:
    provider: spawn
- id: workflow-tool
  name: '@deepseek-ai/dsh-tool-workflow'
"""


class MockModelHandler(BaseHTTPRequestHandler):
    """Return deterministic text and worker-tool streaming completions."""

    requests: list[dict[str, object]] = []

    def do_POST(self) -> None:
        content_length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(content_length))
        self.requests.append(body)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        chunks = completion_chunks(body)
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, _format: str, *_args: object) -> None:
        return


def completion_chunks(body: dict[str, object]) -> list[dict[str, object]]:
    """Choose the next deterministic model response from request history."""
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AssertionError(f"model request has no messages: {body}")
    latest = messages[-1]
    if not isinstance(latest, dict):
        raise AssertionError(f"model request has an invalid latest message: {body}")

    if latest.get("role") == "tool":
        tool_name = latest_tool_name(messages)
        tool_text = json.dumps(latest.get("content"))
        if "42" not in tool_text:
            raise AssertionError(f"{tool_name} worker returned no expected value: {latest}")
        if tool_name == "run_code":
            return text_chunks(CODE_WORKER_TEXT)
        if tool_name == "workflow":
            return text_chunks(WORKFLOW_WORKER_TEXT)
        raise AssertionError(f"unexpected tool follow-up: {tool_name}")

    prompt = message_text(latest.get("content"))
    if prompt == CODE_PROMPT:
        assert_advertised_tool(body, "run_code")
        return tool_call_chunks("call-code-worker", "run_code", {"code": "return 6 * 7"})
    if prompt == WORKFLOW_PROMPT:
        assert_advertised_tool(body, "workflow")
        return tool_call_chunks(
            "call-workflow-worker",
            "workflow",
            {
                "script": "return 6 * 7",
                "meta": {
                    "name": "pkg-worker-smoke",
                    "description": "exercise the packaged workflow worker",
                },
            },
        )
    return text_chunks(EXPECTED_TEXT)


def text_chunks(text: str) -> list[dict[str, object]]:
    """Build a complete streaming text response."""
    return [
        {"choices": [{"delta": {"role": "assistant", "content": None, "reasoning_content": ""}}]},
        {"choices": [{"delta": {"content": text}}]},
        {
            "choices": [{"delta": {"content": ""}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3},
        },
    ]


def tool_call_chunks(call_id: str, name: str, arguments: dict[str, object]) -> list[dict[str, object]]:
    """Build a complete streaming function-call response."""
    return [
        {"choices": [{"delta": {"role": "assistant", "content": None, "reasoning_content": ""}}]},
        {
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments)},
                    }],
                },
            }],
        },
        {
            "choices": [{"delta": {"content": ""}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3},
        },
    ]


def latest_tool_name(messages: list[object]) -> str:
    """Find the assistant tool call paired with the latest tool result."""
    for message in reversed(messages[:-1]):
        if not isinstance(message, dict):
            continue
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in reversed(calls):
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            if isinstance(function, dict) and isinstance(function.get("name"), str):
                return function["name"]
    raise AssertionError(f"tool result has no preceding assistant tool call: {messages}")


def message_text(content: object) -> str:
    """Read OpenAI text content in either string or block-list form."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return ""


def assert_advertised_tool(body: dict[str, object], expected: str) -> None:
    """Require the packaged deployment to expose the requested tool."""
    tools = body.get("tools")
    if not isinstance(tools, list):
        raise AssertionError(f"model request advertised no tools: {body}")
    names: set[str] = set()
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            names.add(function["name"])
    if expected not in names:
        raise AssertionError(f"model request did not advertise {expected}: {names}")


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
        assert_session_log(sessions, root, EXPECTED_TEXT)


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
            text_result = harness.run("reply with the smoke text", session_id="custom-smoke")
            code_result = harness.run(CODE_PROMPT, session_id="custom-smoke")
            workflow_result = harness.run(WORKFLOW_PROMPT, session_id="custom-smoke")
        assert text_result.status == "ok", text_result
        assert text_result.final_response == EXPECTED_TEXT, text_result.final_response
        assert code_result.status == "ok", code_result
        assert code_result.final_response == CODE_WORKER_TEXT, code_result.final_response
        assert workflow_result.status == "ok", workflow_result
        assert workflow_result.final_response == WORKFLOW_WORKER_TEXT, workflow_result.final_response
        assert_session_log(sessions, root, EXPECTED_TEXT, CODE_WORKER_TEXT, WORKFLOW_WORKER_TEXT)


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
        assert_session_log(sessions, root, EXPECTED_TEXT)


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


def assert_session_log(sessions: Path, cwd: Path, *expected_texts: str) -> None:
    logs = list(sessions.rglob("*.jsonl"))
    if len(logs) != 1:
        raise AssertionError(f"expected one JSONL session log under {sessions}, found {logs}")
    lines = logs[0].read_text().splitlines()
    header = json.loads(lines[0])
    if header.get("cwd") != str(cwd):
        raise AssertionError(f"session header cwd is not absolute/canonical: {header}")
    rendered = "\n".join(lines)
    for expected in expected_texts:
        if expected not in rendered:
            raise AssertionError(f"session log has no {expected!r} response: {logs[0]}")


if __name__ == "__main__":
    main()
