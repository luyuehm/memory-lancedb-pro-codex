#!/usr/bin/env python3
"""Fetch FX rates from open.er-api.com and write a unified PARA JSON record."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


PROVIDER = "er-api"
DEFAULT_BASE_URL = "https://open.er-api.com/v6/latest/{base}"
DEFAULT_OUTPUT_DIR = Path(".openclaw/para/research/finance/fx")

_rate_lock = time.monotonic_ns if hasattr(time, "monotonic_ns") else time.time_ns
_last_request_at_ns = 0


class ErapilError(RuntimeError):
    pass


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize_symbols(symbols: Iterable[str]) -> List[str]:
    cleaned = [symbol.strip().upper() for symbol in symbols if symbol and symbol.strip()]
    return sorted(dict.fromkeys(cleaned))


def validate_currency(code: str, label: str) -> str:
    if not code or not isinstance(code, str):
        raise ErapilError(f"{label} is required")

    currency = code.strip().upper()
    if not currency:
        raise ErapilError(f"{label} is empty")
    if len(currency) != 3 or not currency.isalpha():
        raise ErapilError(f"{label} must be a 3-letter currency code: {code}")
    return currency


def build_url(base: str, base_url: str = DEFAULT_BASE_URL) -> str:
    return base_url.format(base=quote(validate_currency(base, "base"), safe=""))


def parse_rates(payload: Dict[str, Any], symbols: List[str], base: str) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ErapilError("response root must be an object")

    if payload.get("result") != "success":
        raise ErapilError(f"unexpected provider result: {payload.get('result')!r}")

    raw_rates = payload.get("rates")
    if not isinstance(raw_rates, dict):
        raise ErapilError("missing rates object")

    requested_base = validate_currency(base, "base")
    missing: List[str] = []
    rates: Dict[str, float] = {requested_base: 1.0}

    for symbol in symbols:
        code = validate_currency(symbol, "symbol")
        if code not in raw_rates:
            missing.append(code)
            continue

        rate = raw_rates[code]
        if not isinstance(rate, (int, float)) or rate <= 0:
            raise ErapilError(f"invalid rate for {code}: {rate!r}")
        rates[code] = float(rate)

    if missing:
        raise ErapilError("missing requested rates: " + ", ".join(missing))

    return {
        "base": requested_base,
        "symbols": symbols,
        "rates": rates,
        "time_last_update_utc": payload.get("time_last_update_utc"),
        "time_next_update_utc": payload.get("time_next_update_utc"),
        "timezone": payload.get("timezone"),
        "source_url": payload.get("source_url"),
    }


def throttle(min_interval_seconds: float) -> None:
    if min_interval_seconds <= 0:
        return

    global _last_request_at_ns
    due_at_ns = _last_request_at_ns + int(min_interval_seconds * 1_000_000_000)
    now_ns = _rate_lock()
    if due_at_ns > now_ns:
        time.sleep((due_at_ns - now_ns) / 1_000_000_000)
    _last_request_at_ns = _rate_lock()


def fetch_json(
    url: str,
    *,
    timeout: float = 10.0,
    max_attempts: int = 3,
    backoff_seconds: float = 0.5,
    min_interval_seconds: float = 1.0,
    opener: Optional[Callable[..., Any]] = None,
) -> Dict[str, Any]:
    if max_attempts < 1:
        raise ErapilError("max_attempts must be at least 1")
    if timeout <= 0:
        raise ErapilError("timeout must be positive")

    open_response = opener or urlopen
    last_error: Optional[Exception] = None

    for attempt in range(1, max_attempts + 1):
        throttle(min_interval_seconds)
        request = Request(url, headers={"User-Agent": "erapi-fin-datasource/1.0"})
        try:
            with open_response(request, timeout=timeout) as response:
                status = int(getattr(response, "status", getattr(response, "getcode", lambda: 0)()))
                if status != 200:
                    raise ErapilError(f"unexpected HTTP status {status}")
                body = response.read()
            try:
                payload = json.loads(body.decode("utf-8"))
            except UnicodeDecodeError as exc:
                raise ErapilError("response body is not valid UTF-8") from exc
            except json.JSONDecodeError as exc:
                raise ErapilError(f"response body is not valid JSON: {exc}") from exc
            if not isinstance(payload, dict):
                raise ErapilError("response JSON root must be an object")
            return payload
        except HTTPError as exc:
            status = int(getattr(exc, "code", 0))
            last_error = exc
            if status == 429 and attempt < max_attempts:
                time.sleep(backoff_seconds * attempt)
                continue
            raise ErapilError(f"HTTP {status} from er-api") from exc
        except URLError as exc:
            last_error = exc
            if attempt < max_attempts:
                time.sleep(backoff_seconds * attempt)
                continue
            raise ErapilError(f"network error from er-api: {exc}") from exc
        except TimeoutError as exc:
            last_error = exc
            if attempt < max_attempts:
                time.sleep(backoff_seconds * attempt)
                continue
            raise ErapilError("request timed out while calling er-api") from exc

    raise ErapilError("unable to fetch er-api response") from last_error


def get_fx_rate(
    base: str,
    symbols: Iterable[str],
    *,
    base_url: str = DEFAULT_BASE_URL,
    timeout: float = 10.0,
    max_attempts: int = 3,
    backoff_seconds: float = 0.5,
    min_interval_seconds: float = 1.0,
    opener: Optional[Callable[..., Any]] = None,
) -> tuple[Dict[str, Any], List[str]]:
    currency_base = validate_currency(base, "base")
    requested = normalize_symbols(symbols)
    if not requested:
        raise ErapilError("at least one target symbol is required")

    payload = fetch_json(
        build_url(currency_base, base_url),
        timeout=timeout,
        max_attempts=max_attempts,
        backoff_seconds=backoff_seconds,
        min_interval_seconds=min_interval_seconds,
        opener=opener,
    )
    data = parse_rates(payload, requested, currency_base)
    return {
        "provider": PROVIDER,
        "ts": utc_now_iso(),
        "data": data,
        "error": None,
    }, requested


def error_record(message: str) -> Dict[str, Any]:
    return {
        "provider": PROVIDER,
        "ts": utc_now_iso(),
        "data": None,
        "error": message,
    }


def write_json(path: Path, record: Dict[str, Any]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n", "utf-8")
    tmp.replace(path)


def default_output_path(output_dir: Path, base: str, symbols: List[str], ts: str) -> Path:
    stamp = ts.replace(":", "").replace("+", "Z")
    filename = f"{PROVIDER}-{base.upper()}-{'_'.join(symbols)}-{stamp}.json"
    return Path(output_dir) / filename


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch FX rates from open.er-api.com")
    parser.add_argument("--base", default="USD", help="Base currency, default USD")
    parser.add_argument("--symbols", required=True, help="Comma-separated target currencies")
    parser.add_argument("--output", default=None, help="JSON output path")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="PARA finance output directory")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--backoff-seconds", type=float, default=0.5)
    parser.add_argument("--min-interval-seconds", type=float, default=1.0)
    args = parser.parse_args(argv)

    symbols = normalize_symbols(args.symbols.split(","))
    try:
        record, requested = get_fx_rate(
            args.base,
            symbols,
            timeout=args.timeout,
            max_attempts=args.max_attempts,
            backoff_seconds=args.backoff_seconds,
            min_interval_seconds=args.min_interval_seconds,
        )
        output = Path(args.output) if args.output else default_output_path(Path(args.output_dir), args.base, requested, record["ts"])
        write_json(output, record)
        print(json.dumps({"ok": True, "path": str(output)}, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        record = error_record(str(exc))
        output = Path(args.output) if args.output else None
        if output:
            write_json(output, record)
        print(json.dumps({"ok": False, "path": str(output) if output else None, "error": str(exc)}, ensure_ascii=False, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

