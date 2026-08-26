"""Minimal stdlib-only URL shortener.

Public surface:
    shortener.store.Store           -- in-memory bidirectional URL <-> code map
    shortener.handlers.make_handler -- build a request handler bound to a Store
"""

from .store import Store

__all__ = ["Store"]
