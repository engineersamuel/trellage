"""Regression tests for the T005 review findings.

The spec lists "URL validation beyond non-empty string" as a non-goal, so
these tests do not police what a URL *means*. They pin down what the server
must do when a stored URL cannot be written into a response header as-is,
how much request body it is willing to buffer, and the exact component-aware
encoding described in docs/url-shortener-spec.md ("Location encoding").
"""

import http.client
import json
import socket
import unittest
from urllib.parse import unquote, urlsplit

from tests.test_shortener import HTTPFixture


class ReviewFindingsTest(HTTPFixture):
    """Drives a real HTTPServer bound to an ephemeral port."""

    # -- helpers ---------------------------------------------------------

    def raw_get(self, path):
        """Return the raw bytes of a GET response, headers included."""
        sock = socket.create_connection((self.host, self.port), timeout=5)
        try:
            request = (
                f"GET {path} HTTP/1.1\r\nHost: {self.host}\r\nConnection: close\r\n\r\n"
            )
            sock.sendall(request.encode("ascii"))
            chunks = []
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            sock.close()

    def location_of(self, url):
        """Shorten `url`, GET its code, and return the raw Location value."""
        code = self.shorten_url(url)
        raw = self.raw_get(f"/{code}")
        _, _, header_block = raw.partition(b"\r\n")
        for line in header_block.split(b"\r\n"):
            name, sep, value = line.partition(b":")
            if sep and name.strip().lower() == b"location":
                return value.strip()
        self.fail(f"no Location header in response: {raw!r}")

    # -- findings --------------------------------------------------------

    def test_crlf_in_stored_url_cannot_inject_a_response_header(self):
        """A URL carrying CRLF must not split the redirect into extra headers."""
        code = self.shorten_url("https://evil.test/\r\nX-Injected: yes")
        raw = self.raw_get(f"/{code}")

        status_line, _, header_block = raw.partition(b"\r\n")
        header_names = {
            line.split(b":", 1)[0].strip().lower()
            for line in header_block.split(b"\r\n")
            if b":" in line
        }
        self.assertIn(b" 302 ", status_line)
        # The text may survive percent-encoded inside Location; what must not
        # survive is a header of its own.
        self.assertNotIn(b"x-injected", header_names)

    def test_non_latin1_url_still_redirects(self):
        """A non-Latin-1 URL must redirect, not crash the response writer.

        ``send_header`` encodes as Latin-1 with ``strict``, so a character
        outside that range (not ``ä``, which *is* Latin-1) raises mid-response
        and drops the connection with nothing written.
        """
        code = self.shorten_url("https://例え.test/ドキュメント")
        raw = self.raw_get(f"/{code}")

        self.assertIn(b" 302 ", raw.split(b"\r\n", 1)[0])
        self.assertIn(b"Location:", raw)

    def test_ordinary_url_survives_the_location_header_untouched(self):
        """Escaping must not disturb URLs that were already header-safe."""
        url = "https://example.com/already%20encoded?a=1&b=%2F#frag"
        code = self.shorten_url(url)
        raw = self.raw_get(f"/{code}")

        self.assertIn(f"Location: {url}\r\n".encode("ascii"), raw)

    def test_non_ascii_hostname_is_idna_encoded(self):
        """A non-ASCII hostname must become an ASCII, resolvable xn-- label."""
        location = self.location_of("https://例え.test/path")

        # The whole value must be plain ASCII (a hard requirement for an
        # HTTP header), and the hostname specifically must be the IDNA
        # (punycode) form of "例え.test", not just percent-escaped bytes.
        location.decode("ascii")  # raises if any byte is non-ASCII
        self.assertIn(b"xn--r8jz45g.test", location)

    def test_unicode_path_and_query_are_utf8_percent_encoded(self):
        """Non-ASCII path/query characters round-trip through percent-encoding."""
        url = "https://example.com/café?q=résumé"
        location = self.location_of(url).decode("ascii")

        parts = urlsplit(location)
        self.assertEqual(parts.scheme, "https")
        self.assertEqual(parts.netloc, "example.com")
        self.assertEqual(unquote(parts.path, encoding="utf-8"), "/café")
        self.assertEqual(unquote(parts.query, encoding="utf-8"), "q=résumé")

    def test_reserved_characters_in_authority_and_path_are_preserved(self):
        """Structurally meaningful reserved characters stay literal, not escaped."""
        url = "https://example.com:8080/a/b;c=d,e/f?x=1&y=2;z=3#top"
        location = self.location_of(url).decode("ascii")

        self.assertEqual(location, url)

    def test_malformed_non_url_value_is_percent_encoded_whole(self):
        """A non-empty string with no parseable authority must not crash.

        The spec only guarantees "non-empty string", so a value with no
        `scheme://host` falls back to whole-string UTF-8 percent-encoding
        rather than being treated as a URL.
        """
        location = self.location_of("not a url at all, just text").decode("ascii")

        self.assertEqual(location, "not%20a%20url%20at%20all,%20just%20text")

    def test_malformed_authority_falls_back_to_whole_string_encoding(self):
        """A syntactically-invalid authority (non-numeric port) still redirects."""
        url = "http://host:not-a-port/path"
        location = self.location_of(url).decode("ascii")

        # Falls back to opaque whole-string encoding rather than raising;
        # this particular string has nothing that needs escaping.
        self.assertEqual(location, url)

    def test_oversized_body_is_rejected_without_being_buffered(self):
        """An absurd Content-Length must be refused, not allocated."""
        conn = http.client.HTTPConnection(self.host, self.port, timeout=5)
        try:
            conn.putrequest("POST", "/shorten")
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(64 * 1024 * 1024))
            conn.endheaders()
            # Deliberately send nothing: a server that trusts Content-Length
            # blocks here waiting for 64 MiB that never arrives.
            response = conn.getresponse()
            self.assertEqual(response.status, 413)
            self.assertIn("error", json.loads(response.read()))
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
