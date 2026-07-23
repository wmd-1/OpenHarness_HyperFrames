"""OpenTelemetry tracing setup — OPTIONAL and defensive (mirrors service/).

If the ``opentelemetry`` packages are missing or misconfigured, this is a
silent no-op so the service always boots with OTLP off.
"""

from __future__ import annotations

import os


def setup_tracing(app=None, *, otlp_endpoint: str | None = None) -> bool:
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (  # noqa: F401
            OTLPSpanExporter,
        )
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.redis import RedisInstrumentor
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except Exception:
        return False

    try:
        endpoint = otlp_endpoint or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
        resource = Resource.create({"service.name": "openharness-session-service"})
        provider = TracerProvider(resource=resource)
        if endpoint:
            provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
        trace.set_tracer_provider(provider)
        if app is not None:
            FastAPIInstrumentor.instrument_app(app)
        for instrument in (SQLAlchemyInstrumentor, RedisInstrumentor):
            try:
                instrument().instrument()
            except Exception:
                pass
        return True
    except Exception:
        return False
