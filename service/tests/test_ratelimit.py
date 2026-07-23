"""Tests for the Redis token-bucket rate limiter (S3)."""

import time
from unittest.mock import patch

import fakeredis
import pytest

from app.config import settings
from app.ratelimit import check_rate_limit, _client_ip


@pytest.fixture(autouse=True)
def _reset_pool():
    """Reset the Redis connection pool between tests."""
    import app.ratelimit as rl
    rl._pool = None
    yield
    rl._pool = None


@pytest.fixture
def small_bucket():
    """Set capacity=2, refill=1/s (matches spec scenario)."""
    orig_cap = settings.rate_limit_capacity
    orig_ref = settings.rate_limit_refill
    settings.rate_limit_capacity = 2
    settings.rate_limit_refill = 1.0
    yield
    settings.rate_limit_capacity = orig_cap
    settings.rate_limit_refill = orig_ref


# ---- Unit tests ----


def test_burst_within_capacity_is_allowed(small_bucket):
    """Requests within bucket capacity are allowed."""
    fake = fakeredis.FakeStrictRedis()
    with patch("app.ratelimit._get_redis", return_value=fake):
        assert check_rate_limit("1.2.3.4") is True
        assert check_rate_limit("1.2.3.4") is True


def test_burst_exceeds_bucket_is_rejected(small_bucket):
    """Burst beyond capacity: third request is rejected (spec scenario).

    GIVEN a bucket capacity of 2 and refill of 1/s
    WHEN 3 submissions arrive within the same second
    THEN the third is rejected (429 at the API layer)
    """
    fake = fakeredis.FakeStrictRedis()
    with patch("app.ratelimit._get_redis", return_value=fake):
        assert check_rate_limit("1.2.3.4") is True   # token 1
        assert check_rate_limit("1.2.3.4") is True   # token 2
        assert check_rate_limit("1.2.3.4") is False  # bucket empty


def test_refill_restores_token(small_bucket):
    """After refill period, a token is available again."""
    fake = fakeredis.FakeStrictRedis()
    with patch("app.ratelimit._get_redis", return_value=fake):
        with patch.object(settings, "rate_limit_capacity", 1):
            with patch.object(settings, "rate_limit_refill", 10.0):
                assert check_rate_limit("1.2.3.4") is True   # consume token
                assert check_rate_limit("1.2.3.4") is False  # empty
                # Wait 0.2s → 10 tokens/s × 0.2s = 2 tokens refilled
                time.sleep(0.2)
                assert check_rate_limit("1.2.3.4") is True   # refilled


def test_separate_ips_have_separate_buckets(small_bucket):
    """Different clients have independent buckets."""
    fake = fakeredis.FakeStrictRedis()
    with patch("app.ratelimit._get_redis", return_value=fake):
        # Exhaust IP A's bucket
        assert check_rate_limit("1.2.3.4") is True
        assert check_rate_limit("1.2.3.4") is True
        assert check_rate_limit("1.2.3.4") is False
        # IP B still has a full bucket
        assert check_rate_limit("5.6.7.8") is True


def test_fails_open_when_redis_down(small_bucket):
    """When Redis is unreachable, the limiter fails open (allows)."""
    with patch("app.ratelimit._get_redis", side_effect=Exception("redis down")):
        assert check_rate_limit("1.2.3.4") is True
        assert check_rate_limit("1.2.3.4") is True
        assert check_rate_limit("1.2.3.4") is True


def test_client_ip_extracts_x_forwarded_for():
    """_client_ip honors X-Forwarded-For header."""

    class FakeRequest:
        headers = {"X-Forwarded-For": "1.2.3.4, 5.6.7.8"}
        client = None

    assert _client_ip(FakeRequest()) == "1.2.3.4"


def test_client_ip_fallbacks_to_client_host():
    """_client_ip falls back to request.client.host when no proxy header."""

    class FakeClient:
        host = "9.9.9.9"

    class FakeRequest:
        headers = {}
        client = FakeClient()

    assert _client_ip(FakeRequest()) == "9.9.9.9"


def test_client_ip_unknown_when_no_client():
    """_client_ip returns 'unknown' when request has no client info."""

    class FakeRequest:
        headers = {}
        client = None

    assert _client_ip(FakeRequest()) == "unknown"
