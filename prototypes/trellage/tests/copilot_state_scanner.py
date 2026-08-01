#!/usr/bin/env python3
"""Binary-safe exact-pattern scan for an immutable owned Copilot home."""

import os
import stat
import sys
from pathlib import Path


CHUNK_BYTES = 64 * 1024
IMMUTABLE_COPILOT_PATHS = {
    "managed-files.txt",
    "managed-lock.json",
    "managed-settings.json",
    "managed.sha256",
}


def file_contains(path: Path, patterns: tuple[bytes, ...]) -> bool:
    carries = [b""] * len(patterns)
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_BYTES):
            for index, pattern in enumerate(patterns):
                candidate = carries[index] + chunk
                if pattern in candidate:
                    return True
                keep = len(pattern) - 1
                carries[index] = candidate[-keep:] if keep > 0 else b""
    return False


def contained_files(root: Path, mutable_copilot_home: bool = False):
    resolved_root = root.resolve(strict=True)
    for directory, names, files in os.walk(resolved_root, followlinks=False):
        names.sort()
        files.sort()
        for name in files:
            candidate = Path(directory, name)
            relative = candidate.relative_to(resolved_root)
            mutable_parts = relative.parts[1:] if relative.parts[0] == ".copilot" else relative.parts
            if mutable_copilot_home and (
                relative.parts[:3] == (".cache", "copilot", "pkg")
                or relative.parts[:2] == (".copilot", "logs")
                or mutable_parts[0] == "installed-plugins"
                or (len(mutable_parts) == 1 and mutable_parts[0] in IMMUTABLE_COPILOT_PATHS)
            ):
                continue
            status = candidate.lstat()
            if stat.S_ISREG(status.st_mode):
                yield candidate
                continue
            if not stat.S_ISLNK(status.st_mode):
                continue
            resolved = candidate.resolve(strict=True)
            if resolved.is_relative_to(resolved_root) and resolved.is_file():
                yield resolved


def main() -> int:
    if len(sys.argv) not in {2, 3} or (
        len(sys.argv) == 3 and sys.argv[2] != "--mutable-copilot-home"
    ):
        print("Copilot state scanner: expected an owned root and optional mutable-home mode", file=sys.stderr)
        return 2
    patterns = tuple(line for line in sys.stdin.buffer.read().splitlines() if line)
    if not patterns:
        print("Copilot state scanner: no patterns supplied on stdin", file=sys.stderr)
        return 2
    try:
        for path in contained_files(Path(sys.argv[1]), len(sys.argv) == 3):
            if file_contains(path, patterns):
                relative = path.resolve().relative_to(Path(sys.argv[1]).resolve(strict=True))
                print(
                    f"Copilot state scanner: credential or path material detected in {relative}",
                    file=sys.stderr,
                )
                return 1
    except (OSError, RuntimeError):
        print("Copilot state scanner: immutable state scan failed", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
