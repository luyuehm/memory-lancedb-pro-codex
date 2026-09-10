import json
import time
import unittest
from contextlib import contextmanager
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request


from scripts.finance_datasource.erapi import ErapilError, get_fx_rate, throttle


ERAPI_PAYLOAD = {
    "result": "success",
    "provider": "exchangerate-api.com",
    "terms": "https://open.er-api.com/terms",
    "time_last_update_utc": "2026-09-10 00:00:00 +0000",
    "time_next_update_utc": "2026-09-11 00:00:00 +0000",
    "timezone": "Etc/UTC",
    "rates": {"USD": 1.0, "CNY": 7.12, "EUR": 0.92, "JPY": 150.0},
}


class FakeResponse:
    def __init__(self, payload: dict, status: int = 200):
        self.payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class ErapilTests(unittest.TestCase):
    def fake_opener(self, response=None, error=None):
        calls = []

        def opener(request: Request, timeout: float):
            calls.append((request, timeout))
            if error is not None:
                raise error
            return response or FakeResponse(ERAPI_PAYLOAD)

        return opener, calls

    def test_get_fx_rate_filters_requested_symbols_and_metadata(self):
        opener, calls = self.fake_opener()

        record, requested = get_fx_rate(
            "usd",
            ["cny", "eur"],
            backoff_seconds=0,
            min_interval_seconds=0,
            opener=opener,
        )

        self.assertEqual(requested, ["CNY", "EUR"])
        self.assertEqual(record["provider"], "er-api")
        self.assertIsNone(record["error"])
        self.assertEqual(record["data"]["base"], "USD")
        self.assertEqual(record["data"]["rates"], {"USD": 1.0, "CNY": 7.12, "EUR": 0.92})
        self.assertEqual(urlparse(str(calls[0][0].full_url)).path, "/v6/latest/USD")

    def test_timeout_retries_then_returns_unified_error(self):
        opener, calls = self.fake_opener(error=TimeoutError("slow upstream"))

        with self.assertRaises(ErapilError) as caught:
            get_fx_rate(
                "USD",
                ["CNY"],
                timeout=0.25,
                max_attempts=2,
                backoff_seconds=0,
                min_interval_seconds=0,
                opener=opener,
            )

        self.assertIn("timed out", str(caught.exception))
        self.assertEqual(len(calls), 2)
        self.assertEqual([call[1] for call in calls], [0.25, 0.25])

    def test_http_429_backs_off_then_succeeds(self):
        calls = []
        sleeps = []

        def opener(request: Request, timeout: float):
            calls.append((request, timeout))
            if len(calls) == 1:
                raise HTTPError("rate limited", 429, "blocked", {}, None)
            return FakeResponse(ERAPI_PAYLOAD)

        with patch_time_sleep(sleeps):
            record, _ = get_fx_rate(
                "USD",
                ["CNY"],
                max_attempts=2,
                backoff_seconds=1.25,
                min_interval_seconds=0,
                opener=opener,
            )

        self.assertIsNone(record["error"])
        self.assertEqual(sleeps, [1.25])

    def test_non_200_response_is_not_retried(self):
        calls = []

        def opener(request: Request, timeout: float):
            calls.append((request, timeout))
            raise HTTPError("server error", 500, "bad", {}, None)

        with self.assertRaises(ErapilError) as caught:
            get_fx_rate("USD", ["CNY"], max_attempts=3, backoff_seconds=0, min_interval_seconds=0, opener=opener)

        self.assertIn("HTTP 500", str(caught.exception))
        self.assertEqual(len(calls), 1)

    def test_missing_required_rate_is_field_error(self):
        payload = {
            "result": "success",
            "rates": {"USD": 1.0, "CNY": 7.12},
        }

        with self.assertRaises(ErapilError) as caught:
            get_fx_rate("USD", ["EUR"], min_interval_seconds=0, opener=lambda request, timeout: FakeResponse(payload))

        self.assertIn("missing requested rates: EUR", str(caught.exception))

    def test_throttle_enforces_minimum_interval(self):
        sleeps = []

        with patch_time_sleep(sleeps):
            throttle(0.25)
            throttle(0.25)

        self.assertEqual(len(sleeps), 1)
        self.assertAlmostEqual(sleeps[0], 0.25, delta=0.02)


@contextmanager
def patch_time_sleep(sleeps: list[float]):
    original_sleep = time.sleep
    time.sleep = sleeps.append
    try:
        yield
    finally:
        time.sleep = original_sleep


if __name__ == "__main__":
    unittest.main()
