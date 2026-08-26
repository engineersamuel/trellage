"""Regression tests for the T005 review findings.

The spec lists "URL validation beyond non-empty string" as a non-goal, so
these tests do not police what a URL *means*. They pin down what the server
must do when a stored URL cannot be written into a response header as-is,
and how much request body it is willing to buffer.
"""

import http.client
import json
import socket
import threading
import unittest
from http.server import HTTPServer

from shortener.handlers import make_handler
from shortener.store import Store


class ReviewFindingsTest(unittest.TestCase):
    """Drives a real HTTPServer bound to an ephemeral port."""

    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        cls.server = HTTPServer(("127.0.0.1", 0), make_handler(cls.store))
        cls.host, cls.port = cls.server.server_address[0], cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    # -- helpers ---------------------------------------------------------

    def shorten(self, url):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=5)
        try:
            conn.request(
                "POST",
                "/shorten",
                body=json.dumps({"url": url}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            response = conn.getresponse()
            payload = json.loads(response.read())
            self.assertEqual(response.status, 200, payload)
            return payload["code"]
        finally:
            conn.close()

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

    # -- findings --------------------------------------------------------

    def test_crlf_in_stored_url_cannot_inject_a_response_header(self):
        """A URL carrying CRLF must not split the redirect into extra headers."""
        code = self.shorten("https://evil.test/\r\nX-Injected: yes")
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
        code = self.shorten("https://例え.test/ドキュメント")
        raw = self.raw_get(f"/{code}")

        self.assertIn(b" 302 ", raw.split(b"\r\n", 1)[0])
        self.assertIn(b"Location:", raw)

    def test_ordinary_url_survives_the_location_header_untouched(self):
        """Escaping must not disturb URLs that were already header-safe."""
        url = "https://example.com/path?a=1&b=2#frag"
        code = self.shorten(url)
        raw = self.raw_get(f"/{code}")

        self.assertIn(f"Location: {url}\r\n".encode("ascii"), raw)

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
