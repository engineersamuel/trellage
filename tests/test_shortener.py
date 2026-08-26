"""Contract tests for the stdlib URL shortener (T002).

These tests define the contract described in docs/url-shortener-spec.md:

    from shortener.store import Store          # Store().shorten(url) / .resolve(code)
    from shortener.handlers import make_handler  # make_handler(store) -> handler class

They are written before the implementation exists, so importing ``shortener``
fails until T003 lands. That is the intended RED state.
"""

import http.client
import json
import re
import threading
import unittest
from http.server import HTTPServer

from shortener.handlers import make_handler
from shortener.store import Store

CODE_PATTERN = re.compile(r"^[0-9a-z]{6}$")


class ShortenerHTTPTest(unittest.TestCase):
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

    def request(self, method, path, body=None, headers=None):
        """Return (status, headers, body_bytes). Redirects are never followed."""
        conn = http.client.HTTPConnection(self.host, self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            payload = response.read()
            return response.status, response.headers, payload
        finally:
            conn.close()

    def post_shorten(self, raw_body):
        return self.request(
            "POST",
            "/shorten",
            body=raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body,
            headers={"Content-Type": "application/json"},
        )

    def shorten_url(self, url):
        """POST /shorten for `url`, assert 200, return the code."""
        status, _, payload = self.post_shorten(json.dumps({"url": url}))
        self.assertEqual(status, 200, payload)
        return json.loads(payload.decode("utf-8"))["code"]

    # -- tests -----------------------------------------------------------

    def test_post_shorten_returns_200_and_six_character_code(self):
        status, headers, payload = self.post_shorten(
            json.dumps({"url": "https://example.com"})
        )

        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "application/json")
        body = json.loads(payload.decode("utf-8"))
        self.assertIn("code", body)
        self.assertIsInstance(body["code"], str)
        self.assertEqual(len(body["code"]), 6)
        self.assertRegex(body["code"], CODE_PATTERN)

    def test_get_known_code_redirects_to_original_url(self):
        url = "https://example.com/redirect-target"
        code = self.shorten_url(url)

        status, headers, _ = self.request("GET", "/" + code)

        self.assertEqual(status, 302)
        self.assertEqual(headers.get("Location"), url)

    def test_shortening_same_url_twice_returns_same_code(self):
        url = "https://example.com/idempotent"

        first = self.shorten_url(url)
        second = self.shorten_url(url)

        self.assertEqual(first, second)

    def test_shortening_different_urls_returns_different_codes(self):
        first = self.shorten_url("https://example.com/one")
        second = self.shorten_url("https://example.com/two")

        self.assertNotEqual(first, second)

    def test_get_unknown_code_returns_404(self):
        status, _, _ = self.request("GET", "/zzzzzz")

        self.assertEqual(status, 404)

    def test_post_shorten_with_malformed_json_returns_400(self):
        status, _, _ = self.post_shorten("{not json at all")

        self.assertEqual(status, 400)

    def test_post_shorten_with_missing_or_empty_url_returns_400(self):
        for label, body in (("missing", {}), ("empty", {"url": ""})):
            with self.subTest(url=label):
                status, _, _ = self.post_shorten(json.dumps(body))

                self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
