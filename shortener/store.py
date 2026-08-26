"""In-memory URL store with deterministic short-code generation."""

from __future__ import annotations

import hashlib
import threading

__all__ = ["Store", "ALPHABET", "CODE_LENGTH"]

ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
CODE_LENGTH = 6


def _encode(value: int) -> str:
    """Render ``value`` as a fixed-width CODE_LENGTH string over ALPHABET."""
    base = len(ALPHABET)
    chars = []
    for _ in range(CODE_LENGTH):
        value, remainder = divmod(value, base)
        chars.append(ALPHABET[remainder])
    return "".join(reversed(chars))


def _derive(url: str, attempt: int) -> str:
    """Derive a code for ``url``.

    ``attempt`` 0 hashes the URL alone, so the same URL yields the same code
    across separate Store instances. Later attempts salt the material, giving
    a deterministic probe sequence for collision resolution.
    """
    material = url if attempt == 0 else f"{url}\x00{attempt}"
    digest = hashlib.sha256(material.encode("utf-8")).digest()
    return _encode(int.from_bytes(digest, "big"))


class Store:
    """Bidirectional, in-memory mapping between URLs and short codes."""

    def __init__(self) -> None:
        self._code_to_url: dict[str, str] = {}
        self._url_to_code: dict[str, str] = {}
        # shorten() does a check-then-set while probing for a free code.
        # ThreadingHTTPServer calls it from several threads at once, so the
        # probe has to be serialized or two URLs can claim the same code.
        self._lock = threading.Lock()

    def shorten(self, url: str) -> str:
        """Return the 6-character code for ``url``, creating one if needed.

        Idempotent per URL within an instance. Raises ValueError when ``url``
        is not a non-empty string.
        """
        if not isinstance(url, str):
            raise ValueError("url must be a string")
        if not url:
            raise ValueError("url must not be empty")

        with self._lock:
            existing = self._url_to_code.get(url)
            if existing is not None:
                return existing

            attempt = 0
            while True:
                code = _derive(url, attempt)
                owner = self._code_to_url.get(code)
                if owner is None:
                    self._code_to_url[code] = url
                    self._url_to_code[url] = code
                    return code
                if owner == url:  # pragma: no cover - guarded by the lookup above
                    return code
                attempt += 1

    def resolve(self, code: str) -> str | None:
        """Return the URL for ``code``, or None when the code is unknown."""
        if not isinstance(code, str):
            return None
        return self._code_to_url.get(code)

    def __len__(self) -> int:
        return len(self._code_to_url)
