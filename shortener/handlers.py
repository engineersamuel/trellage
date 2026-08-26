"""HTTP request handling for the URL shortener.

`make_handler` binds a handler class to a specific Store instance so a fresh
store can be injected per server.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import quote, urlsplit, urlunsplit

from .store import Store

__all__ = ["make_handler"]

# A request body big enough to hold a URL and nothing else. Content-Length is
# attacker-controlled, so it is checked before a single byte is read.
MAX_BODY_BYTES = 64 * 1024

# --- Location header safety --------------------------------------------
#
# The stored value is an arbitrary non-empty string (URL validation beyond
# that is a spec non-goal), so it may not parse as a well-formed URL at all.
# `_safe_location` renders it as a single-line, ASCII-only header value:
#
#   * If it splits into scheme://authority/path?query#fragment, the
#     hostname is IDNA-encoded (non-ASCII labels only; ASCII hosts, including
#     IPv6 literals, pass through unchanged) and the userinfo/path/query/
#     fragment components are UTF-8 percent-encoded, each against the
#     RFC 3986 characters that are structurally meaningful in that
#     component. A URL that was already header-safe round-trips unchanged.
#   * Anything else (no parseable authority, or one `urlsplit`/`.port`
#     rejects, e.g. a malformed IPv6 literal or non-numeric port) falls back
#     to whole-string UTF-8 percent-encoding: still ASCII-safe, just not
#     component-split.
#
# `urlsplit` itself silently deletes bare CR/LF/TAB from its input (a
# hardening fix against header-injection-by-newline). That is a safe outcome
# but a silent one, so those controls are percent-escaped first. Existing
# percent escapes remain unchanged because "%" is safe in every later quote.
_CONTROL_ESCAPES = (("\r", "%0D"), ("\n", "%0A"), ("\t", "%09"))

_SUB_DELIMS = "!$&'()*+,;="
_HOST_SAFE = "%-._~"
_USERINFO_SAFE = _SUB_DELIMS + "%:"
_PATH_SAFE = _SUB_DELIMS + "%:@/"
_QUERY_SAFE = _PATH_SAFE + "?"
_FRAGMENT_SAFE = _QUERY_SAFE
_OPAQUE_SAFE = _SUB_DELIMS + "%:@/?"


def _escape_controls(value: str) -> str:
    """Percent-encode CR, LF, and TAB before any URL parsing."""
    for char, escape in _CONTROL_ESCAPES:
        value = value.replace(char, escape)
    return value


def _idna_host(hostname: str) -> str | None:
    """Return an ASCII-safe hostname, or None if it cannot be made one."""
    if not hostname:
        return None
    if ":" in hostname:
        return f"[{hostname}]"  # IPv6 literal; urlsplit already validated it.
    if not hostname.isascii():
        try:
            hostname = hostname.encode("idna").decode("ascii")
        except (UnicodeError, UnicodeDecodeError):
            return None
    return quote(hostname, safe=_HOST_SAFE, encoding="utf-8")


def _safe_authority(parts) -> str | None:
    """Return an ASCII-safe 'userinfo@host:port' authority, or None."""
    host = _idna_host(parts.hostname) if parts.hostname else None
    if not host:
        return None

    authority = f"{host}:{parts.port}" if parts.port is not None else host

    if parts.username is not None:
        userinfo = quote(parts.username, safe=_USERINFO_SAFE, encoding="utf-8")
        if parts.password is not None:
            userinfo += ":" + quote(parts.password, safe=_USERINFO_SAFE, encoding="utf-8")
        authority = f"{userinfo}@{authority}"

    return authority


def _safe_location(url: str) -> str:
    """Render `url` as a single-line, ASCII-only `Location` header value."""
    escaped = _escape_controls(url)
    try:
        parts = urlsplit(escaped)
        if not parts.netloc:
            raise ValueError("no authority to anchor component-aware encoding")

        authority = _safe_authority(parts)
        if authority is None or not parts.scheme.isascii():
            raise ValueError("authority could not be made ASCII-safe")

        path = quote(parts.path, safe=_PATH_SAFE, encoding="utf-8")
        query = quote(parts.query, safe=_QUERY_SAFE, encoding="utf-8")
        fragment = quote(parts.fragment, safe=_FRAGMENT_SAFE, encoding="utf-8")
        return urlunsplit((parts.scheme, authority, path, query, fragment))
    except ValueError:
        # Not a URL with a parseable authority (or `urlsplit`/`.port` itself
        # rejected it) — still a non-empty string per the spec, so fall back
        # to treating it as one opaque, whole-string-encoded value.
        return quote(escaped, safe=_OPAQUE_SAFE, encoding="utf-8")


def make_handler(store: Store) -> type[BaseHTTPRequestHandler]:
    """Build a BaseHTTPRequestHandler subclass backed by ``store``."""

    class ShortenerHandler(BaseHTTPRequestHandler):
        server_version = "URLShortener/1.0"
        protocol_version = "HTTP/1.0"

        # Keep test output pristine.
        def log_message(self, format, *args):  # noqa: A002 - stdlib signature
            return

        # --- helpers -------------------------------------------------
        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_error_json(self, status: int, message: str) -> None:
            self._send_json(status, {"error": message})

        def _path(self) -> str:
            return urlsplit(self.path).path

        # --- verbs ---------------------------------------------------
        def do_POST(self) -> None:  # noqa: N802 - stdlib naming
            if self._path() != "/shorten":
                self._send_error_json(404, "not found")
                return

            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                self._send_error_json(400, "invalid Content-Length")
                return
            if length < 0:
                self._send_error_json(400, "invalid Content-Length")
                return
            if length > MAX_BODY_BYTES:
                self._send_error_json(413, "request body too large")
                return

            raw = self.rfile.read(length) if length else b""

            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_error_json(400, "invalid JSON body")
                return

            if not isinstance(payload, dict):
                self._send_error_json(400, "body must be a JSON object")
                return

            url = payload.get("url")
            if not isinstance(url, str) or not url:
                self._send_error_json(400, "missing or empty 'url'")
                return

            try:
                code = store.shorten(url)
            except ValueError as exc:
                self._send_error_json(400, str(exc))
                return

            self._send_json(200, {"code": code})

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            code = self._path().lstrip("/")
            url = store.resolve(code) if code else None
            if url is None:
                self._send_error_json(404, "unknown code")
                return

            self.send_response(302)
            self.send_header("Location", _safe_location(url))
            self.send_header("Content-Length", "0")
            self.end_headers()

    return ShortenerHandler
