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

Code derivation has two parts, and only one of them is deterministic across
instances:

- The **first candidate code** for a URL is a hash of the URL alone, truncated
  to 6 characters. That candidate is the same for the same URL in any `Store`
  instance, because it depends only on the URL string.
- If that candidate is already taken by a *different* URL in this instance,
  the implementation must **probe** for a free code (deterministically, e.g.
  by re-hashing with an attempt counter) rather than overwrite the existing
  mapping. Probing depends on what this particular instance already holds, so
  the *final* code assigned to a URL can differ from instance to instance once
  a collision has occurred here. This is why the idempotence guarantee above
  is scoped to "within one `Store` instance": that is the only scope in which
  no collision-driven divergence is possible.

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
| Body exceeds 64 KiB (65536 bytes) | `413` | `{"error": "..."}` |

The 64 KiB cap is checked against the (attacker-controlled) `Content-Length`
header *before* any body bytes are read, so an oversized request cannot pin a
server thread waiting to read bytes that never arrive, and cannot have its
declared bytes buffered in memory either. `Content-Length` values that are
missing, non-numeric, or negative are a plain `400`, not a `413`.

`Content-Type: application/json` on every response with a body.
Posting the same URL twice returns the same `code` both times.

### `GET /{code}`

| Condition | Status | Headers |
|-----------|--------|---------|
| Known code | `302` | `Location: <safe encoding of the original url>` |
| Unknown code | `404` | — |

`GET /` (empty code) is a `404`.

The redirect must not follow automatically in tests — assert on the status
code and the `Location` header directly.

#### `Location` encoding

`url` is only guaranteed to be a non-empty string (see Non-goals); it need not
be a well-formed URL. `Location` must always be a single-line, ASCII-only
header value, so the stored string is rendered as follows:

1. Escape CR, LF, and TAB in the stored string to `%0D`, `%0A`, and `%09`
   respectively. (`urlsplit` silently deletes these controls; escaping first
   turns that into visible percent-encoding instead of silent data loss.)
   Preserve existing percent escapes such as `%20`; `%` remains safe in the
   component encoding below.
2. Split the escaped string into `scheme://authority/path?query#fragment`.
   If it has no authority (no `scheme://host` part) — or if that authority
   cannot be made ASCII-safe, for example a non-numeric port or a malformed
   IPv6 literal — treat the whole escaped string as one opaque value and
   UTF-8 percent-encode it (step 4's rules), and stop.
3. Make the authority ASCII-safe:
   - Non-ASCII hostname labels are IDNA-encoded (e.g. `例え.test` →
     `xn--r8jz45g.test`). ASCII hostnames, including bracketed IPv6 literals
     (`[::1]`), pass through unchanged (case-folded, as `urlsplit` already
     does). A hostname that cannot be IDNA-encoded falls back to step 2's
     whole-value handling.
   - `userinfo` (if present) and the numeric port (if present) are kept;
     `userinfo` is UTF-8 percent-encoded against RFC 3986 sub-delims plus
     `:`.
4. UTF-8 percent-encode `path`, `query`, and `fragment` independently, each
   keeping its own RFC 3986 structural characters literal (`/` and `:` in the
   path; additionally `?` in the query and fragment) plus sub-delimiters
   (`!$&'()*+,;=`) and `%` (so the escaping from step 1, and any
   percent-encoding already present in the input, is not re-escaped).
5. Reassemble the components. A URL that was already header-safe (ASCII
   authority, no CR/LF/TAB, reserved characters only where structurally
   valid) round-trips unchanged.

This never validates what the URL *means* — only what is necessary to write
it into a header safely, consistent with "URL validation beyond non-empty
string" being a non-goal.

## Non-goals

- Persistence, authentication, rate limiting, custom aliases, analytics.
- URL validation beyond "non-empty string".
