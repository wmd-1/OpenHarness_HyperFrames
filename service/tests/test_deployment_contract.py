"""Deployment contract test for the oh-serve (supervisord) entrypoint (R13).

Asserts against the *actual deployment artifact* baked into the image
(``/etc/supervisor/conf.d/oh-service.conf``) rather than the repo copy, so
either side drifting — image conf vs. code expectations — turns the suite red:

1. the worker's subscribed queue set covers ``settings.worker_queues``;
2. ``[program:beat]`` exists (periodic cleanup depends on it);
3. ``queue_for_priority()``'s full range is consumed by the worker
   (producer/consumer contract closes the loop).

The conf path is overridable via ``OH_SUPERVISORD_CONF``; when the file is
absent (non-image environment, e.g. bare checkout) the module is skipped to
avoid false negatives.
"""

import configparser
import os
import re
from pathlib import Path

import pytest

from app.config import settings
from app.workers.scheduler import queue_for_priority

CONF_PATH = Path(os.environ.get("OH_SUPERVISORD_CONF", "/etc/supervisor/conf.d/oh-service.conf"))

pytestmark = pytest.mark.skipif(
    not CONF_PATH.is_file(),
    reason=f"supervisord conf not found at {CONF_PATH} (not running inside the image)",
)


def _load_conf() -> configparser.RawConfigParser:
    parser = configparser.RawConfigParser(strict=False)
    parser.read(CONF_PATH)
    return parser


def _worker_queue_set(command: str) -> set[str]:
    """Extract the queue set the worker subscribes to from its command line.

    Mirrors shell semantics for the env-fallback form
    ``-Q "${OH_WORKER_QUEUES:-high,normal,low}"`` (design D1): a runtime
    ``OH_WORKER_QUEUES`` wins, otherwise the inline default applies. A plain
    ``-Q high,normal,low`` is also accepted.
    """
    m = re.search(r"-Q\s+['\"]?\$\{OH_WORKER_QUEUES:-([^}]+)\}['\"]?", command)
    if m:
        raw = os.environ.get("OH_WORKER_QUEUES") or m.group(1)
    else:
        m = re.search(r"-Q\s+['\"]?([\w,\-]+)['\"]?", command)
        if not m:
            pytest.fail(
                f"[program:worker] command has no -Q queue subscription "
                f"(worker would only consume the default 'celery' queue): {command}"
            )
        raw = m.group(1)
    return {q.strip() for q in raw.split(",") if q.strip()}


def test_worker_subscribes_configured_queues():
    conf = _load_conf()
    assert conf.has_section("program:worker"), "[program:worker] missing from supervisord conf"
    subscribed = _worker_queue_set(conf.get("program:worker", "command"))
    expected = {q.strip() for q in settings.worker_queues.split(",") if q.strip()}
    assert subscribed >= expected, (
        f"worker subscribes {sorted(subscribed)} but settings.worker_queues "
        f"requires {sorted(expected)} — tasks routed to the missing queues would "
        f"stay 'queued' forever"
    )


def test_beat_program_present():
    conf = _load_conf()
    assert conf.has_section("program:beat"), (
        "[program:beat] missing from supervisord conf — periodic cleanup "
        "(cleanup_retention_days) would never run under oh-serve"
    )


def test_scheduler_range_within_worker_subscription():
    conf = _load_conf()
    subscribed = _worker_queue_set(conf.get("program:worker", "command"))
    routed = {queue_for_priority(p) for p in range(1, 11)}
    assert routed <= subscribed, (
        f"queue_for_priority() may route to {sorted(routed - subscribed)} "
        f"which the worker does not consume (subscribed: {sorted(subscribed)})"
    )
