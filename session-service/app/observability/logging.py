"""Structured JSON logging via structlog (mirrors service/app/observability/logging.py)."""

from __future__ import annotations

import logging
import re
import sys

import structlog

_CONFIGURED = False

# Mask API keys wherever they appear in log output (SS-11): WS clients pass
# ``?api_key=...`` as a query param (browsers cannot set WS headers), so any
# logged URL/query would otherwise leak the credential.
_API_KEY_RE = re.compile(r"(api[_-]?key['\"]?\s*[=:]\s*['\"]?)([^&'\"\s]+)", re.IGNORECASE)


def mask_api_key(text: str) -> str:
    """Replace any ``api_key=<value>`` occurrence with ``api_key=***``."""
    return _API_KEY_RE.sub(r"\1***", text)


def _mask_secrets_processor(logger, method_name, event_dict):
    """structlog processor: scrub api_key values from every string field."""
    for key, value in event_dict.items():
        if isinstance(value, str):
            event_dict[key] = mask_api_key(value)
    return event_dict


class _MaskSecretsFilter(logging.Filter):
    """stdlib logging filter: scrub api_key values from formatted messages."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
            if "api" in msg.lower():
                record.msg = mask_api_key(msg)
                record.args = ()
        except Exception:
            pass
        return True


def configure_logging(level: str = "INFO") -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    log_level = getattr(logging, level, logging.INFO)
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=log_level)
    logging.getLogger().addFilter(_MaskSecretsFilter())
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            _mask_secrets_processor,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
    _CONFIGURED = True


def get_logger(name: str | None = None):
    return structlog.get_logger(name) if name else structlog.get_logger()


def bind_session_context(session_id: str | None = None, tenant_id: str | None = None) -> None:
    ctx: dict[str, object] = {}
    if session_id is not None:
        ctx["session_id"] = str(session_id)
    if tenant_id is not None:
        ctx["tenant_id"] = tenant_id
    if ctx:
        structlog.contextvars.bind_contextvars(**ctx)
