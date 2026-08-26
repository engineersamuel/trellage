# URL Shortener — Specification (T001)

Stdlib only. No pip, no third-party packages. Python 3.13.

## Layout

```
shortener/
  __init__.py
  store.py      # in-memory store + code generation
  handlers.py   # BaseHTTPRequestHandler
  server.py     # entrypoint (T004)
tests/
  test_shortener.py
```

## Module: `shortener.store`

```python
class Store:
    def shorten(self, url: str) -> str: ...
    def resolve(self, code: str) -> str | None: ...
```

- `shorten(url)` returns a 6-character code drawn from `[0-9a-z]`.
- `shorten` is **idempotent**: calling it twice with the same URL string
  returns the same code, within one `Store` instance.
- Different URLs get different codes (collisions are resolved, not ignored).
- `resolve(code)` returns the original URL, or `None` if the code is unknown.
- The store holds everything in memory; nothing is persisted.

Code derivation is deterministic — a hash of the URL truncated to 6
characters — so the same URL yields the same code even across `Store`
instances. On collision between two distinct URLs, the implementation must
probe for a free code rather than overwrite.

## HTTP API

### `POST /shorten`

Request body: JSON object with a `url` key.

```json
{"url": "https://example.com"}
```

Responses:

| Condition | Status | Body |
|-----------|--------|------|
| Valid URL | `200` | `{"code": "a1b2c3"}` |
| Body is not valid JSON | `400` | `{"error": "..."}` |
| `url` key missing or empty | `400` | `{"error": "..."}` |

`Content-Type: application/json` on every response with a body.
Posting the same URL twice returns the same `code` both times.

### `GET /{code}`

| Condition | Status | Headers |
|-----------|--------|---------|
| Known code | `302` | `Location: <original url>` |
| Unknown code | `404` | — |

`GET /` (empty code) is a `404`.

The redirect must not follow automatically in tests — assert on the status
code and the `Location` header directly.

## Non-goals

- Persistence, authentication, rate limiting, custom aliases, analytics.
- URL validation beyond "non-empty string".
