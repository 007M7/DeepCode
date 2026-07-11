from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .client import HarnessClient, HarnessConfig
from .models import JsonObject, Notification


@dataclass(slots=True)
class DeepSeekHarnessConfig:
    """Configuration for launching the local DeepSeek Harness SDK runtime.

    The runtime inherits the caller's environment by default, so existing
    DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL settings keep working. Use ``env`` to
    intentionally override or inject variables for a subprocess.
    """

    model: str = "deepseek-v4-flash"
    cwd: str | None = None
    runtime_cwd: str | None = None
    session_root: str | None = None
    cordis: str | None = None
    system_prompt: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    runtime_bin: str | None = None
    launch_args_override: tuple[str, ...] | None = None
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float | None = 1.0
    client_name: str = "deepseek_harness_python_sdk"
    client_version: str = "0.0.0-dev"
    base_url: str | None = None
    api_key: str | None = None


@dataclass(slots=True)
class TurnResult:
    session_id: str
    status: str
    final_response: str
    events: list[JsonObject]
    notifications: list[Notification]
    session_root: str | None = None


class DeepSeekHarness:
    """Synchronous high-level SDK for running DeepSeek Harness agent turns."""

    def __init__(self, config: DeepSeekHarnessConfig | None = None, **kwargs: object) -> None:
        if config is not None and kwargs:
            raise TypeError("pass either DeepSeekHarnessConfig or keyword options, not both")
        self.config = config or DeepSeekHarnessConfig(**kwargs)
        cwd = self.config.cwd or str(Path.cwd())
        runtime_cwd = self.config.runtime_cwd or cwd
        env = dict(self.config.env)
        if self.config.session_root is not None:
            env["DSH_SESSION_ROOT"] = self.config.session_root
        if self.config.cordis is not None:
            env["DSH_CORDIS_CONFIG"] = self.config.cordis
        else:
            self._inject_bundled_default_config(env)
        env["DSH_CWD"] = cwd
        if self.config.base_url is not None:
            env["DEEPSEEK_BASE_URL"] = self.config.base_url
        if self.config.api_key is not None:
            env["DEEPSEEK_API_KEY"] = self.config.api_key

        self._client = HarnessClient(
            HarnessConfig(
                runtime_bin=self.config.runtime_bin,
                launch_args_override=self.config.launch_args_override,
                cwd=runtime_cwd,
                env=env,
                request_timeout_seconds=self.config.request_timeout_seconds,
                shutdown_timeout_seconds=self.config.shutdown_timeout_seconds,
                client_name=self.config.client_name,
                client_version=self.config.client_version,
            )
        )
        self._initialized = False

    def __enter__(self) -> "DeepSeekHarness":
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    @property
    def client(self) -> HarnessClient:
        return self._client

    def start(self) -> None:
        if self._initialized:
            return
        self._client.start()
        self._client.initialize(
            cwd=self.config.cwd or str(Path.cwd()),
            model=self.config.model,
            session_root=self.config.session_root,
            system_prompt=self.config.system_prompt,
        )
        self._initialized = True

    def close(self) -> None:
        self._client.close()
        self._initialized = False

    def _inject_bundled_default_config(self, env: dict[str, str]) -> None:
        """Restore the zero-config experience over the config-mandatory bundled runtime.

        The bundled runtime (single-file exe or the dev-only node closure)
        always demands an explicit config. When the caller neither provided
        ``cordis`` nor selected a runtime explicitly (``runtime_bin`` /
        ``launch_args_override``), and no ambient ``DSH_CORDIS_CONFIG`` exists,
        inject the runtime package's checked-in default cordis.yml. With an
        explicit runtime or config channel the SDK stays out of the way.
        """
        uses_bundled_runtime = self.config.runtime_bin is None and self.config.launch_args_override is None
        if not uses_bundled_runtime or "DSH_CORDIS_CONFIG" in env or "DSH_CORDIS_CONFIG" in os.environ:
            return
        try:
            from deepseek_harness_runtime import bundled_default_config_path
        except ImportError:
            # Only the runtime package's absence reaches here; swallow it so
            # HarnessClient.start() reports the actionable install error.
            return
        env["DSH_CORDIS_CONFIG"] = str(bundled_default_config_path())

    def start_session(self, session_id: str | None = None) -> "Session":
        self.start()
        return Session(self, session_id or f"session-{uuid.uuid4().hex}")

    def run(
        self,
        input: str | list[JsonObject],
        *,
        session_id: str | None = None,
        profile: str | None = None,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> TurnResult:
        return self.start_session(session_id).run(input, profile=profile, on_notification=on_notification)


class Session:
    def __init__(self, harness: DeepSeekHarness, session_id: str) -> None:
        self.harness = harness
        self.id = session_id

    def run(
        self,
        input: str | list[JsonObject],
        *,
        profile: str | None = None,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> TurnResult:
        content_blocks = normalize_input(input)
        notifications: list[Notification] = []
        events: list[JsonObject] = []
        status = "error"
        finished = False

        def collect(notification: Notification) -> None:
            nonlocal finished, status
            notifications.append(notification)
            if on_notification is not None:
                on_notification(notification)
            if notification.method == "session.event":
                event = notification.payload.get("event")
                if isinstance(event, dict):
                    events.append(event)
            if notification.method == "session.finished" and notification.payload.get("sessionId") == self.id:
                status = str(notification.payload.get("status") or "ok")
                finished = True

        with self.harness.client.subscribe_session_notifications(self.id) as subscription:
            self.harness.client.session_prompt(
                self.id,
                content_blocks,
                profile=profile,
                on_notification=collect,
                notification_subscription=subscription,
            )

            while not finished:
                notification = subscription.next()
                collect(notification)

        return TurnResult(
            session_id=self.id,
            status=status,
            final_response=final_response(events),
            events=events,
            notifications=notifications,
            session_root=self.harness.config.session_root,
        )


def normalize_input(input: str | list[JsonObject]) -> list[JsonObject]:
    if isinstance(input, str):
        return [{"type": "text", "text": input}]
    return input


def final_response(events: list[JsonObject]) -> str:
    for event in reversed(events):
        if event.get("type") != "assistant/message":
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        content = data.get("content")
        if not isinstance(content, list):
            continue
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return "".join(parts)
    return ""
