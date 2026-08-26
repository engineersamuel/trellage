"""HTTP request handling for the URL shortener.

`make_handler` binds a handler class to a specific Store instance so a fresh
store can be injected per server.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

from .store import Store

__all__ = ["make_handler"]


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
            self.send_header("Location", url)
            self.send_header("Content-Length", "0")
            self.end_headers()

    return ShortenerHandler
