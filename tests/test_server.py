"""Tests for the server entrypoint (T004)."""

import http.client
import json
import threading
import unittest

from shortener.server import build_server


class BuildServerTest(unittest.TestCase):
    """The entrypoint must hand back a bound, ready-to-serve HTTP server."""

    def setUp(self):
        self.server = build_server(host="127.0.0.1", port=0)
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()
        self.addCleanup(self._shutdown)

    def _shutdown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _post_shorten(self, url):
        conn = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_port, timeout=5
        )
        body = json.dumps({"url": url})
        conn.request(
            "POST",
            "/shorten",
            body=body,
            headers={"Content-Length": str(len(body))},
        )
        response = conn.getresponse()
        payload = json.loads(response.read())
        conn.close()
        return response.status, payload

    def test_build_server_binds_an_ephemeral_port(self):
        self.assertNotEqual(self.server.server_port, 0)

    def test_built_server_shortens_and_redirects_end_to_end(self):
        status, payload = self._post_shorten("https://example.com")
        self.assertEqual(status, 200)
        code = payload["code"]

        conn = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_port, timeout=5
        )
        conn.request("GET", "/" + code)
        response = conn.getresponse()
        response.read()
        conn.close()

        self.assertEqual(response.status, 302)
        self.assertEqual(response.getheader("Location"), "https://example.com")

    def test_each_built_server_gets_its_own_store(self):
        """A second server must not inherit the first server's mappings."""
        _, payload = self._post_shorten("https://example.com/isolated")
        code = payload["code"]

        other = build_server(host="127.0.0.1", port=0)
        self.addCleanup(other.server_close)

        self.assertIsNone(other.store.resolve(code))


if __name__ == "__main__":
    unittest.main()
