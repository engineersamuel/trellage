# T005 Review — stdlib URL shortener

- **Bead:** `url-t005` (T005 review/fix), blocked by T004 until T004 closed green.
- **Scope reviewed:** `shortener/store.py`, `shortener/handlers.py`, `shortener/server.py`, and the tests under `tests/`.
- **Contract reviewed against:** `docs/url-shortener-spec.md`.
- **Gate at review time:** 11 tests green (`python3 -m unittest discover -s tests -p 'test_*.py' -t .`); 15 green after the fixes below.

## How this review was produced

Codex (`codex exec`, `gpt-5.6-sol`) produced the first pass. Its repository-reading
tool host was unavailable (`failed to spawn code-mode host
/usr/local/bin/codex-code-mode-host`), so the six files were piped in on stdin
with line numbers instead. Codex returned four findings; each was reproduced by
hand against a live server before being accepted or rejected — three reproduced
(findings 1, 2, and 3 below) and one did not hold (finding 5 below). Finding 4
was found independently before Codex ran, so it is not part of that four.

Serena was unavailable for symbol lookup in this environment (its Python language
server could not start: `Could not find 'uvx' or 'uv' in PATH`). Discovery fell
back to `grep` plus targeted line-range reads rather than whole-file reads.

## Findings

### 1. CRLF in a stored URL injected a response header — CONFIRMED, FIXED

`shortener/handlers.py` wrote the stored URL into `Location` verbatim.
`BaseHTTPRequestHandler.send_header` does not strip control characters, so
`POST /shorten {"url": "https://evil.test/\r\nX-Injected: yes"}` followed by a
`GET /{code}` produced:

```
HTTP/1.0 302 Found
Location: https://evil.test/
X-Injected: yes
Content-Length: 0
```

An attacker who can get a victim to follow a shortened link controls arbitrary
response headers on that redirect.

**Fix:** percent-encode the URL on its way into `Location`. CR and LF become
`%0D%0A`; already-safe URLs, including their reserved characters (`?`, `&`,
`#`, `/`, `:`), are unchanged. The encoding is component-aware (see finding 2
and `docs/url-shortener-spec.md`, "Location encoding") rather than a
whole-string `quote()`, but the CRLF outcome is the same either way: the
control characters end up inside the single `Location` value, not as a
header of their own. This deliberately does *not* validate what the URL
means — the spec lists URL validation as a non-goal — it only makes the
value safe to emit.

### 2. Non-Latin-1 URL crashed the response writer — CONFIRMED, FIXED

`send_header` encodes as Latin-1 with `strict`. A URL containing a character
outside that range (`https://例え.test/…`) raised `UnicodeEncodeError` mid-response,
so the client got zero bytes and a dropped connection instead of a redirect.

Note that `ä` and `é` do *not* trigger this — they are Latin-1 — which is why the
first version of the regression test passed against the unfixed code. The test
now uses characters that are genuinely outside Latin-1.

**Fix:** the hostname is IDNA-encoded to ASCII (e.g. `例え.test` →
`xn--r8jz45g.test`), and the rest of the URL is UTF-8 percent-encoded, the
same encoding pass described in finding 1. UTF-8 percent-encoding is the
correct wire form for non-ASCII characters in `Location`; IDNA is what makes
a non-ASCII *hostname* specifically resolvable rather than just escaped.

### 3. Unbounded `Content-Length` was trusted — CONFIRMED, FIXED

`do_POST` read exactly as many bytes as the client's `Content-Length` claimed.
A request announcing 64 MiB and then sending nothing pinned a `ThreadingHTTPServer`
thread until it timed out; a request that actually sent the bytes would have had
them buffered in memory.

**Fix:** `MAX_BODY_BYTES = 64 * 1024`, checked before any read. Oversized requests
get `413` with a JSON error body, consistent with the other error responses.

### 4. Concurrent `shorten()` could hand two URLs the same code — CONFIRMED, FIXED

Found before Codex ran, listed here for completeness. `Store.shorten` did a
check-then-set on `_code_to_url` while probing for a free code. `build_server`
serves on a `ThreadingHTTPServer`, so two threads that clear the ownership check
for the same code both claim it, and one URL's mapping is silently lost.

**Fix:** a `threading.Lock` around the probe in `shortener/store.py`.
`tests/test_store_concurrency.py` pins it by lining both threads up inside the
check-then-set window with a barrier; it fails deterministically without the lock.

### 5. Code assignment depends on insertion order — NOT A DEFECT

Codex flagged that collision probing makes a URL's code depend on what is already
stored, so "same URL always yields the same code" can break across `Store`
instances. That is true of the *final* code once a collision has occurred, but
not of the process as a whole: the first candidate code is a pure hash of the
URL, identical in any instance, and only diverges from instance to instance if
that candidate was already taken by a different URL there. The spec now spells
out that distinction and narrows the idempotence guarantee to *within one
`Store` instance* (`docs/url-shortener-spec.md`, "Code derivation has two
parts"), and persistence is an explicit non-goal. The code matches the spec as
written. No change.

Worth knowing for later: codes are the first 6 characters of a SHA-256-derived
alphabet mapping over a 36-character alphabet, so the code space is
36^6 = 2,176,782,336. The birthday bound for a fixed-size space of `N` is
`sqrt(N)`, which puts the first likely collision around
`sqrt(2,176,782,336) ≈ 46,656` stored URLs — call it ~5×10^4, not 10^5. Below
that, collision probing effectively never fires.

## Verification

Each fix was proven by removing it and watching the tests go red:

- `git stash push shortener/store.py` → `tests.test_store_concurrency` fails with
  `AssertionError: 'cccccc' == 'cccccc' : distinct URLs must not share a code`.
- `git stash push shortener/handlers.py` → `tests.test_review_findings` fails on
  the header-injection, non-Latin-1, and oversized-body cases. The case that
  guards ordinary URLs passing through `Location` untouched passes either way.

Full gate after the fixes:

```
Ran 15 tests in 3.047s

OK
```

## Residual risks (not addressed, deliberately)

- No persistence: restarting the server loses every mapping, and the same URL can
  then receive a different code if collisions resolve differently. Spec non-goal.
- No rate limiting or auth on `POST /shorten`. Spec non-goal.
- The store grows without bound; there is no eviction. Fine for the intended scope.
- Open redirect by design — that is what a URL shortener is.
