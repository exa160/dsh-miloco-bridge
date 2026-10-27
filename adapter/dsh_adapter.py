"""DSH agent_platform adapter for Xiaomi Miloco.

Miloco loads this file from ``$MILOCO_HOME/agent_platform/dsh/adapter.py`` and
calls it with duck-typed turn contexts. It does not import Miloco internals:
the only optional import is the public ``AdapterTransportError`` class when
running inside the backend process, so the dispatcher can classify transport
failures. Standalone use falls back to a local class with the same name.

Configuration is read from ``$MILOCO_HOME/agent_platform/dsh/config.yaml``
(flat ``key: value`` lines) or environment variables:

    webhook_url: "http://127.0.0.1:3080/miloco/webhook"
    auth_bearer: "same token as the DSH plugin push token"
    include_home_profile: true
    home_profile_max_chars: 4000
    # optional explicit backend endpoint for reading the rendered profile
    backend_url: "http://127.0.0.1:1810"
    backend_token: "..."

Environment overrides:

    DSH_MILOCO_WEBHOOK_URL
    DSH_MILOCO_WEBHOOK_TOKEN
    DSH_MILOCO_INCLUDE_HOME_PROFILE
    DSH_MILOCO_BACKEND_URL
    DSH_MILOCO_BACKEND_TOKEN

The protocol is the one Miloco already uses for webhook agents::

    POST {webhook_url}
    {"action": "agent", "payload": {
        "message": "...", "sessionKey": "...", "lane": "...",
        "traceId": "...", "idempotencyKey": "...", "timeoutMs": 120000,
        "urgency": "high|medium|low"
    }}

DSH replies ``{"code": 0, "data": {runId, status, sessionId, reply}}``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

try:  # Available when this adapter runs inside the Miloco backend.
    from miloco.agent_platform.base import AdapterTransportError
except Exception:  # pragma: no cover - standalone / tests
    class AdapterTransportError(Exception):
        """Transport-level failure (connect, timeout, 5xx)."""


try:
    import httpx
except ImportError:  # pragma: no cover - dependency is provided by backend
    httpx = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

_HTTP_BUFFER_S = 20.0
_DEFAULT_WAIT_MS = 120_000
_URGENCY_RE = re.compile(r"(?:事件优先级|urgency)\s*[：:=]\s*(high|medium|low|ignore)", re.I)
_URGENCY_RANK = {"low": 1, "medium": 2, "high": 3}


def _extract_urgency(text: str) -> str:
    """Return the highest urgency mentioned by a perception event batch.

    Miloco's event text uses ``事件优先级：high|medium|low``. A batch may
    contain several suggestions; the highest one decides the batch priority.
    Returns an empty string for non-perception events (rules/tasks/etc.).
    """
    best = ""
    best_rank = 0
    saw_ignore = False
    for match in _URGENCY_RE.finditer(text or ""):
        value = match.group(1).lower()
        if value == "ignore":
            saw_ignore = True
            continue
        rank = _URGENCY_RANK.get(value, 0)
        if rank > best_rank:
            best = value
            best_rank = rank
    return best or ("ignore" if saw_ignore else "")


def _miloco_home() -> Path:
    raw = os.environ.get("MILOCO_HOME", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".miloco"


def _read_flat_yaml(path: Path) -> dict[str, str]:
    """Read simple ``key: value`` YAML without adding a dependency."""
    data: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return data
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        data[key.strip()] = value
    return data


def _truthy(value: Any, default: bool = True) -> bool:
    if value is None or value == "":
        return default
    return str(value).strip().lower() not in ("0", "false", "no", "off")


def _read_backend_connection() -> tuple[str, str]:
    """Read Miloco's own server URL/token from ``$MILOCO_HOME/config.json``."""
    try:
        payload = json.loads((_miloco_home() / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "", ""
    server = payload.get("server") if isinstance(payload, dict) else {}
    if not isinstance(server, dict):
        return "", ""
    url = str(server.get("url") or "").strip()
    if not url:
        host = str(server.get("host") or "127.0.0.1")
        port = str(server.get("port") or "1810")
        url = f"http://{host}:{port}"
    return url.rstrip("/"), str(server.get("token") or "").strip()


class Adapter:
    """Deliver Miloco turns into DeepSeek Harness."""

    name = "dsh"

    def __init__(self) -> None:
        config = _read_flat_yaml(_miloco_home() / "agent_platform" / "dsh" / "config.yaml")
        self.webhook_url = str(
            os.environ.get("DSH_MILOCO_WEBHOOK_URL")
            or config.get("webhook_url")
            or "http://127.0.0.1:3080/miloco/webhook"
        ).strip()
        self.auth_bearer = str(
            os.environ.get("DSH_MILOCO_WEBHOOK_TOKEN")
            or config.get("auth_bearer")
            or ""
        ).strip()
        self.include_home_profile = _truthy(
            os.environ.get("DSH_MILOCO_INCLUDE_HOME_PROFILE", config.get("include_home_profile")),
            default=True,
        )
        try:
            self.home_profile_max_chars = int(config.get("home_profile_max_chars", "4000"))
        except (TypeError, ValueError):
            self.home_profile_max_chars = 4000

        default_backend_url, default_backend_token = _read_backend_connection()
        self.backend_url = str(
            os.environ.get("DSH_MILOCO_BACKEND_URL")
            or config.get("backend_url")
            or default_backend_url
        ).strip().rstrip("/")
        self.backend_token = str(
            os.environ.get("DSH_MILOCO_BACKEND_TOKEN")
            or config.get("backend_token")
            or default_backend_token
        ).strip()

        self._client: Optional[Any] = None
        self._profile_cache: Optional[tuple[float, str]] = None

    # ------------------------------------------------------------------ HTTP

    def _http(self) -> Any:
        if httpx is None:
            raise AdapterTransportError("httpx is not available; cannot reach DSH")
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=180.0)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            try:
                await self._client.aclose()
            finally:
                self._client = None

    # --------------------------------------------------------------- profile

    def build_system(self, profile: str, extra: dict[str, Any]) -> str:
        """Return the optional home-profile block prepended to the message.

        DSH has no public "replace system prompt per turn" hook, so the block
        travels as part of the message text and is clearly delimited. It is
        omitted for lightweight profiles (``minimal`` / ``rule`` /
        ``suggestion``) to save tokens.
        """
        if not self.include_home_profile or profile in ("minimal", "rule", "suggestion"):
            return ""
        rendered = self._load_home_profile()
        if not rendered:
            return ""
        return (
            "【家庭档案 · 由 Miloco 注入】\n"
            f"{rendered}\n"
            "【以上为家庭档案】\n\n"
        )

    def _load_home_profile(self) -> str:
        now = time.monotonic()
        if self._profile_cache is not None and now - self._profile_cache[0] < 300:
            return self._profile_cache[1]
        text = self._fetch_home_profile()
        self._profile_cache = (now, text)
        return text

    def _fetch_home_profile(self) -> str:
        if httpx is None or not self.backend_url:
            return ""
        headers = {"accept": "application/json"}
        if self.backend_token:
            headers["authorization"] = f"Bearer {self.backend_token}"
        try:
            response = httpx.get(
                f"{self.backend_url}/api/home-profile/rendered",
                headers=headers,
                timeout=10.0,
            )
            if response.status_code >= 400:
                return ""
            payload = response.json()
        except Exception as exc:  # noqa: BLE001 - profile injection is best effort
            logger.debug("dsh adapter: home profile unavailable: %s", exc)
            return ""

        data = payload.get("data") if isinstance(payload, dict) else payload
        if isinstance(data, str):
            rendered = data
        elif isinstance(data, dict):
            rendered = (
                data.get("markdown")
                or data.get("rendered")
                or data.get("text")
                or ""
            )
            if not rendered:
                rendered = json.dumps(data, ensure_ascii=False)
        else:
            rendered = ""
        rendered = str(rendered).strip()
        if len(rendered) > self.home_profile_max_chars:
            rendered = rendered[: self.home_profile_max_chars] + "\n…（已截断）"
        return rendered

    # ------------------------------------------------------------------ turn

    async def send_turn(self, ctx: Any) -> Any:
        """Deliver one turn to DSH and wait for its completion."""
        client = self._http()

        text = getattr(ctx, "text", "") or ""
        session_key = getattr(ctx, "session_key", "") or ""
        lane = getattr(ctx, "lane", "") or ""
        trace_id = getattr(ctx, "trace_id", "") or ""
        wait_timeout_ms = int(getattr(ctx, "wait_timeout_ms", _DEFAULT_WAIT_MS) or _DEFAULT_WAIT_MS)
        profile = getattr(ctx, "profile", "full") or "full"
        extra = getattr(ctx, "extra", {}) or {}

        system_block = ""
        try:
            system_block = self.build_system(profile, extra)
        except Exception as exc:  # noqa: BLE001
            logger.warning("dsh adapter: build_system failed: %s", exc)

        payload: dict[str, Any] = {
            "message": f"{system_block}{text}" if system_block else text,
            "sessionKey": session_key,
            "lane": lane,
            "traceId": trace_id,
            "idempotencyKey": trace_id,
            "timeoutMs": wait_timeout_ms,
        }
        urgency = _extract_urgency(text)
        if urgency:
            payload["urgency"] = urgency
        delivery = extra.get("delivery") or {}
        if isinstance(delivery, dict):
            for key in ("deliver", "resolveTarget", "lightContext"):
                if delivery.get(key) is not None:
                    payload[key] = delivery[key]

        headers = {"content-type": "application/json"}
        if self.auth_bearer:
            headers["authorization"] = f"Bearer {self.auth_bearer}"

        started = time.monotonic()
        timeout_s = wait_timeout_ms / 1000 + _HTTP_BUFFER_S
        try:
            response = await client.post(
                self.webhook_url,
                json={"action": "agent", "payload": payload},
                headers=headers,
                timeout=timeout_s,
            )
        except Exception as exc:  # noqa: BLE001 - classified as transport
            raise AdapterTransportError(f"DSH webhook request failed: {exc}") from exc

        rtt_ms = (time.monotonic() - started) * 1000
        if response.status_code >= 400:
            body = response.text[:300]
            raise AdapterTransportError(f"DSH webhook HTTP {response.status_code}: {body}")

        try:
            body = response.json()
        except ValueError as exc:
            raise AdapterTransportError(f"DSH webhook returned non-JSON: {response.text[:200]}") from exc

        code = body.get("code", -1) if isinstance(body, dict) else -1
        if code != 0:
            message = body.get("message", "unknown error") if isinstance(body, dict) else "unknown error"
            logger.warning("dsh adapter: webhook error code=%s message=%s", code, message)
            return SimpleNamespace(
                run_id=None,
                status="error",
                rtt_ms=rtt_ms,
                recovered=None,
                error=str(message),
                reply=None,
                session_id=None,
            )

        data = body.get("data") if isinstance(body, dict) else None
        data = data if isinstance(data, dict) else {}
        status = data.get("status", "ok")
        if status not in ("ok", "timeout", "error"):
            status = "ok"
        return SimpleNamespace(
            run_id=data.get("runId"),
            status=status,
            rtt_ms=rtt_ms,
            recovered=data.get("recovered"),
            error=data.get("error"),
            reply=data.get("reply"),
            session_id=data.get("sessionId"),
        )

    # ----------------------------------------------------------------- trace

    async def read_trace_meta(self, run_id: str) -> Optional[Any]:
        """DSH keeps turn metadata in memory, not as a trace file."""
        return None

    # ----------------------------------------------------------------- reset

    async def reset_sessions(self, routes: list[Any], *, timeout: float = 10.0) -> Optional[Any]:
        """Ask DSH to forget the sessions tied to Miloco session keys."""
        if not routes or not self.webhook_url:
            return None
        keys = []
        for item in routes:
            if isinstance(item, str):
                keys.append(item)
            elif isinstance(item, (tuple, list)) and item:
                keys.append(str(item[0]))
            else:
                value = getattr(item, "session_key", None)
                if value:
                    keys.append(str(value))
        keys = sorted(set(keys))
        if not keys:
            return None

        headers = {"content-type": "application/json"}
        if self.auth_bearer:
            headers["authorization"] = f"Bearer {self.auth_bearer}"
        try:
            client = self._http()
            response = await client.post(
                self.webhook_url,
                json={
                    "action": "reset_sessions",
                    "payload": {"sessionKeys": keys, "deleteTranscript": True},
                },
                headers=headers,
                timeout=timeout,
            )
            return response.json()
        except Exception as exc:  # noqa: BLE001 - cleanup is best effort
            logger.warning("dsh adapter: reset_sessions failed: %s", exc)
            return None
