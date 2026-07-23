"""Structured JSON logging via structlog (mirrors service/app/observability/logging.py)."""

from __future__ import annotations

import logging
import sys

import structlog

_CONFIGURED = False


def configure_logging(level: str = "INFO") -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    log_level = getattr(logging, level, logging.INFO)
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=log_level)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
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
