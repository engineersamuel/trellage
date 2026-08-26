"""Concurrency tests for Store (T005 review finding)."""

import threading
import unittest
from unittest import mock

from shortener import store as store_module
from shortener.store import Store


class ConcurrentShortenTest(unittest.TestCase):
    """Two colliding URLs shortened at once must not corrupt the mapping.

    ``server.build_server`` serves on a ThreadingHTTPServer, so ``shorten``
    is reachable from several threads at once. The collision-probe loop does
    a check-then-set on ``_code_to_url``; if two threads clear the check for
    the same code, both claim it and one URL's mapping is silently lost.
    """

    def test_colliding_urls_shortened_concurrently_keep_distinct_codes(self):
        url_a = "https://example.com/a"
        url_b = "https://example.com/b"
        collision = "cccccc"
        fallbacks = {url_a: "aaaaaa", url_b: "bbbbbb"}

        def fake_derive(url, attempt):
            return collision if attempt == 0 else fallbacks[url]

        # Line both threads up *inside* the code-ownership lookup, which is
        # the exact window between the check and the set. A barrier anywhere
        # earlier is too coarse: the interpreter will not switch threads
        # across those few bytecodes on its own.
        barrier = threading.Barrier(2)

        class SyncedDict(dict):
            def get(self, key, default=None):
                value = super().get(key, default)
                if key == collision:
                    # Sync *after* the read, so both threads carry away the
                    # same "nobody owns this code" answer. Syncing before the
                    # read lets the loser observe the winner's write and
                    # quietly probe on, hiding the bug.
                    try:
                        barrier.wait(timeout=0.5)
                    except threading.BrokenBarrierError:
                        # Serialized by a lock — the peer never arrives.
                        pass
                return value

        shared = Store()
        shared._code_to_url = SyncedDict()

        results = {}

        def run(url):
            results[url] = shared.shorten(url)

        with mock.patch.object(store_module, "_derive", fake_derive):
            threads = [
                threading.Thread(target=run, args=(url,))
                for url in (url_a, url_b)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)

        self.assertEqual(len(results), 2, "both threads must finish")
        self.assertNotEqual(
            results[url_a],
            results[url_b],
            "distinct URLs must not share a code",
        )
        self.assertEqual(shared.resolve(results[url_a]), url_a)
        self.assertEqual(shared.resolve(results[url_b]), url_b)


if __name__ == "__main__":
    unittest.main()
