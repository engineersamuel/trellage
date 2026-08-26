"""Entrypoint: wire a Store to the HTTP handlers and serve."""

from http.server import ThreadingHTTPServer

from .handlers import make_handler
from .store import Store

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000


class ShortenerServer(ThreadingHTTPServer):
    """An HTTP server that owns the Store its handlers are bound to."""

    def __init__(self, address, handler_cls, store):
        super().__init__(address, handler_cls)
        self.store = store


def build_server(host=DEFAULT_HOST, port=DEFAULT_PORT, store=None):
    """Return a server bound to (host, port), backed by its own Store.

    Pass port=0 to bind an ephemeral port; the caller can then read the
    chosen port back off the returned server as `server.server_port`.
    """
    store = Store() if store is None else store
    return ShortenerServer((host, port), make_handler(store), store)


def main(argv=None):
    argv = [] if argv is None else argv
    port = int(argv[0]) if argv else DEFAULT_PORT
    server = build_server(port=port)
    print(f"serving on http://{DEFAULT_HOST}:{server.server_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv[1:]))
