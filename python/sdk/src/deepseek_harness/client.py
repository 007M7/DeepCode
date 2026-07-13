from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal, TypeAlias, TypeVar

from pydantic import BaseModel

from .errors import JsonRpcError, TransportClosedError
from .models import IncomingRequest, InitializeResponse, JsonObject, JsonValue, Notification

ModelT = TypeVar("ModelT", bound=BaseModel)
NotificationFilter: TypeAlias = Callable[[Notification], bool]


@dataclass(slots=True)
class HarnessConfig:
    """Configuration for launching the local DeepSeek Harness SDK runtime."""

    runtime_bin: str | None = None
    bridge_bin: str | None = None
    launch_args_override: tuple[str, ...] | None = None
    cwd: str | None = None
    env: dict[str, str] | None = None
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float | None = 1.0


class HarnessClient:
    """Synchronous JSON-RPC client for the DeepSeek Harness SDK runtime over stdio."""

    def __init__(self, config: HarnessConfig | None = None) -> None:
        self.config = config or HarnessConfig()
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._responses: dict[str, queue.Queue[JsonValue | BaseException]] = {}
        self._notifications: queue.Queue[Notification | BaseException] = queue.Queue()
        self._notification_subscribers: dict[
            str, tuple[queue.Queue[Notification | BaseException], NotificationFilter | None]
        ] = {}
        self._requests: queue.Queue[IncomingRequest | BaseException] = queue.Queue()
        self._stderr_lines: deque[str] = deque(maxlen=400)
        self._reader_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None

    def __enter__(self) -> "HarnessClient":
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def start(self) -> None:
        if self._proc is not None:
            return
        args = list(self.config.launch_args_override or self._default_launch_args())
        env = os.environ.copy()
        if self.config.env:
            env.update(self.config.env)
        self._inject_bundled_default_config(env)
        self._proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            cwd=None if self.config.cwd is None else str(Path(self.config.cwd).resolve()),
            env=env,
            bufsize=1,
        )
        self._start_reader_thread()
        self._start_stderr_thread()

    def close(self) -> None:
        proc = self._proc
        if proc is None:
            return
        try:
            self.request("shutdown", None, response_model=_ShutdownResponse, timeout_seconds=self.config.shutdown_timeout_seconds)
        except Exception as exc:
            self._stderr_lines.append(f"shutdown request failed: {exc}")
        if proc.stdin:
            try:
                proc.stdin.close()
            except Exception as exc:
                self._stderr_lines.append(f"stdin close failed: {exc}")
        if proc.poll() is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
        try:
            proc.wait(timeout=self.config.shutdown_timeout_seconds)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        self._proc = None
        self._fail_waiters(self._runtime_closed_error("DeepSeek Harness runtime closed"))
        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=0.5)
        if self._stderr_thread and self._stderr_thread.is_alive():
            self._stderr_thread.join(timeout=0.5)

    def initialize(
        self,
        *,
        cwd: str,
        model: str,
    ) -> InitializeResponse:
        payload: JsonObject = {
            "cwd": str(Path(cwd).resolve()),
            "model": model,
        }
        try:
            return self.request("initialize", payload, response_model=InitializeResponse)
        except BaseException:
            self.close()
            raise

    def session_prompt(
        self,
        session_id: str,
        content_blocks: list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> None:
        payload: JsonObject = {"sessionId": session_id, "contentBlocks": content_blocks}
        self.request(
            "session/prompt",
            payload,
            response_model=_SessionPromptResponse,
            on_notification=on_notification,
            notification_filter=_notification_belongs_to_session(session_id),
            notification_subscription=notification_subscription,
        )

    def request(
        self,
        method: str,
        params: JsonObject | None,
        *,
        response_model: type[ModelT],
        timeout_seconds: float | None = None,
        on_notification: Callable[[Notification], None] | None = None,
        notification_filter: NotificationFilter | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> ModelT:
        result = self._request_raw(
            method,
            params,
            timeout_seconds=timeout_seconds,
            on_notification=on_notification,
            notification_filter=notification_filter,
            notification_subscription=notification_subscription,
        )
        if not isinstance(result, dict):
            raise TypeError(f"{method} response must be a JSON object")
        return response_model.model_validate(result)

    def notify(self, method: str, params: JsonObject | None = None) -> None:
        message: JsonObject = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._write_message(message)

    def next_notification(self) -> Notification:
        item = self._notifications.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def subscribe_notifications(
        self,
        notification_filter: NotificationFilter | None = None,
    ) -> "NotificationSubscription":
        subscription_id = str(uuid.uuid4())
        notifications: queue.Queue[Notification | BaseException] = queue.Queue()
        with self._lock:
            self._notification_subscribers[subscription_id] = (notifications, notification_filter)
        return NotificationSubscription(self, subscription_id, notifications)

    def subscribe_session_notifications(self, session_id: str) -> "NotificationSubscription":
        return self.subscribe_notifications(_notification_belongs_to_session(session_id))

    def next_request(self) -> IncomingRequest:
        item = self._requests.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def respond(self, request_id: str | int, result: JsonValue) -> None:
        self._write_message({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(
        self,
        request_id: str | int,
        *,
        code: int,
        message: str,
        data: JsonValue | None = None,
    ) -> None:
        error: JsonObject = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._write_message({"jsonrpc": "2.0", "id": request_id, "error": error})

    def _request_raw(
        self,
        method: str,
        params: JsonObject | None = None,
        *,
        timeout_seconds: float | None = None,
        on_notification: Callable[[Notification], None] | None = None,
        notification_filter: NotificationFilter | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> JsonValue:
        request_id = str(uuid.uuid4())
        waiter: queue.Queue[JsonValue | BaseException] = queue.Queue(maxsize=1)
        temp_subscription: NotificationSubscription | None = None
        subscription = notification_subscription
        with self._lock:
            self._responses[request_id] = waiter
        if on_notification is not None and subscription is None:
            temp_subscription = self.subscribe_notifications(notification_filter)
            subscription = temp_subscription
        try:
            message: JsonObject = {"jsonrpc": "2.0", "id": request_id, "method": method}
            if params is not None:
                message["params"] = params
            self._write_message(message)
        except BaseException:
            with self._lock:
                self._responses.pop(request_id, None)
            if temp_subscription is not None:
                temp_subscription.close()
            raise
        timeout = self.config.request_timeout_seconds if timeout_seconds is None else timeout_seconds
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while True:
                if on_notification is not None and subscription is not None:
                    subscription.drain(on_notification)
                wait_timeout = None
                if on_notification is not None:
                    wait_timeout = 0.05
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        with self._lock:
                            self._responses.pop(request_id, None)
                        raise TimeoutError(f"{method} timed out waiting for DeepSeek Harness runtime")
                    wait_timeout = remaining if wait_timeout is None else min(wait_timeout, remaining)
                try:
                    item = waiter.get(timeout=wait_timeout)
                    if on_notification is not None and subscription is not None:
                        subscription.drain(on_notification)
                    break
                except queue.Empty:
                    continue
        except BaseException:
            with self._lock:
                self._responses.pop(request_id, None)
            if temp_subscription is not None:
                temp_subscription.close()
            raise
        finally:
            if temp_subscription is not None:
                temp_subscription.close()
        if isinstance(item, BaseException):
            raise item
        return item

    def _write_message(self, message: JsonObject) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise TransportClosedError("DeepSeek Harness runtime is not running")
        try:
            payload = json.dumps(message, separators=(",", ":")) + "\n"
            with self._write_lock:
                proc.stdin.write(payload)
                proc.stdin.flush()
        except Exception as exc:
            raise self._runtime_closed_error("Failed to write to DeepSeek Harness runtime") from exc

    def _start_reader_thread(self) -> None:
        self._reader_thread = threading.Thread(target=self._reader_loop, name="dsh-runtime-reader", daemon=True)
        self._reader_thread.start()

    def _start_stderr_thread(self) -> None:
        self._stderr_thread = threading.Thread(target=self._stderr_loop, name="dsh-runtime-stderr", daemon=True)
        self._stderr_thread.start()

    def _reader_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            for line in proc.stdout:
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self._handle_message(message)
        except BaseException as exc:
            self._fail_waiters(exc)
        finally:
            self._fail_waiters(self._runtime_closed_error("DeepSeek Harness runtime stdout closed"))

    def _stderr_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        for line in proc.stderr:
            self._stderr_lines.append(line.rstrip())

    def _handle_message(self, message: object) -> None:
        if not isinstance(message, dict):
            return
        msg_id = message.get("id")
        method = message.get("method")
        if isinstance(msg_id, (str, int)) and isinstance(method, str):
            params = message.get("params")
            self._requests.put(IncomingRequest(id=msg_id, method=method, payload=params if isinstance(params, dict) else {}))
            return
        if isinstance(msg_id, (str, int)):
            with self._lock:
                waiter = self._responses.pop(str(msg_id), None)
            if waiter is None:
                return
            if isinstance(message.get("error"), dict):
                err = message["error"]
                waiter.put(JsonRpcError(_int_or_none(err.get("code")), str(err.get("message", "JSON-RPC error")), err.get("data")))
            else:
                waiter.put(message.get("result"))
            return
        if isinstance(method, str):
            params = message.get("params")
            notification = Notification(method=method, payload=params if isinstance(params, dict) else {})
            with self._lock:
                subscribers = list(self._notification_subscribers.items())
            delivered = False
            for subscription_id, (subscriber, predicate) in subscribers:
                try:
                    matches = predicate is None or predicate(notification)
                except BaseException as exc:
                    with self._lock:
                        current = self._notification_subscribers.get(subscription_id)
                        if current is not None and current[0] is subscriber:
                            self._notification_subscribers.pop(subscription_id, None)
                    subscriber.put(exc)
                    continue
                if matches:
                    subscriber.put(notification)
                    delivered = True
            if not delivered:
                self._notifications.put(notification)

    def _fail_waiters(self, exc: BaseException) -> None:
        with self._lock:
            waiters = list(self._responses.values())
            self._responses.clear()
            subscribers = list(self._notification_subscribers.values())
            self._notification_subscribers.clear()
        for waiter in waiters:
            waiter.put(exc)
        for subscriber, _predicate in subscribers:
            subscriber.put(exc)
        self._notifications.put(exc)
        self._requests.put(exc)

    def _runtime_closed_error(self, reason: str) -> TransportClosedError:
        proc = self._proc
        if (
            proc is not None
            and proc.poll() is not None
            and self._stderr_thread is not None
            and self._stderr_thread.is_alive()
            and threading.current_thread() is not self._stderr_thread
        ):
            self._stderr_thread.join(timeout=0.1)

        parts = [reason]
        if proc is not None:
            exit_code = proc.poll()
            if exit_code is not None:
                parts.append(f"exit code: {exit_code}")
        if self._stderr_lines:
            parts.append("stderr tail:\n" + "\n".join(self._stderr_lines))
        return TransportClosedError("\n".join(parts))

    def _default_launch_args(self) -> tuple[str, ...]:
        if self.config.runtime_bin is not None:
            return (self.config.runtime_bin,)
        if self.config.bridge_bin is not None:
            return (self.config.bridge_bin,)
        try:
            from deepseek_harness_runtime import resolve_bundled_launch_args
        except ImportError as exc:
            raise FileNotFoundError(
                "Unable to locate the bundled DeepSeek Harness SDK runtime. "
                "Install deepseek-harness-runtime-bin or set HarnessConfig.runtime_bin."
            ) from exc
        return resolve_bundled_launch_args()

    def _inject_bundled_default_config(self, env: dict[str, str]) -> None:
        """Restore the zero-config experience over the config-mandatory bundled runtime.

        The bundled runtime (single-file exe or the dev-only node closure)
        always demands an explicit config. When the launch resolves to the
        bundled runtime (no ``runtime_bin`` / ``bridge_bin`` /
        ``launch_args_override``) and the merged subprocess environment has no
        non-empty ``DSH_CORDIS_CONFIG`` — the runtime bin treats an empty
        value as absent, so this does too — inject the runtime package's
        checked-in default cordis.yml. With an explicit runtime or config
        channel the client stays out of the way.
        """
        uses_bundled_runtime = (
            self.config.launch_args_override is None
            and self.config.runtime_bin is None
            and self.config.bridge_bin is None
        )
        if not uses_bundled_runtime or env.get("DSH_CORDIS_CONFIG"):
            return
        # Cannot fail: _default_launch_args() already imported the runtime
        # package on this (bundled) path, raising the actionable install
        # error when it is absent.
        from deepseek_harness_runtime import bundled_default_config_path

        env["DSH_CORDIS_CONFIG"] = str(bundled_default_config_path())

    def _unsubscribe_notifications(self, subscription_id: str) -> None:
        with self._lock:
            self._notification_subscribers.pop(subscription_id, None)


class NotificationSubscription:
    def __init__(
        self,
        client: HarnessClient,
        subscription_id: str,
        notifications: queue.Queue[Notification | BaseException],
    ) -> None:
        self._client = client
        self._subscription_id = subscription_id
        self._notifications = notifications
        self._closed = False

    def __enter__(self) -> "NotificationSubscription":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._client._unsubscribe_notifications(self._subscription_id)

    def next(self) -> Notification:
        item = self._notifications.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def drain(self, on_notification: Callable[[Notification], None]) -> None:
        while True:
            try:
                item = self._notifications.get_nowait()
            except queue.Empty:
                return
            if isinstance(item, BaseException):
                raise item
            on_notification(item)


class _SessionPromptResponse(BaseModel):
    accepted: Literal[True]


class _ShutdownResponse(BaseModel):
    pass


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) else None


def _notification_belongs_to_session(session_id: str) -> NotificationFilter:
    def belongs(notification: Notification) -> bool:
        payload = notification.payload
        return (
            payload.get("sessionId") == session_id
            or payload.get("parentSessionId") == session_id
            or payload.get("childSessionId") == session_id
        )

    return belongs
