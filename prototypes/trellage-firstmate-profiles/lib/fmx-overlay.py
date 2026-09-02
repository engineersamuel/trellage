#!/usr/bin/env python3
"""Apply the pinned Firstmate overlay to a staged checkout.

The overlay is deliberately strict and offline. Every managed file must hash to
the recorded base digest before any edit, every hunk must match its recorded
context exactly at its recorded position, and every file must hash to the
recorded result digest afterwards. Any mismatch aborts before a single managed
file is written, so a staged checkout is never left half-patched.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

MAX_PATCH_BYTES = 1 << 20
MAX_TARGET_BYTES = 4 << 20


class OverlayError(Exception):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_regular(path: Path, limit: int) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise OverlayError(f"not a regular file: {path}")
    size = path.stat().st_size
    if size > limit:
        raise OverlayError(f"file exceeds {limit} bytes: {path}")
    return path.read_bytes()


def split_lines(text: str) -> list[str]:
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def parse_hunks(patch_text: str) -> list[tuple[int, list[str]]]:
    """Return (start_line_1_based, body_lines) for every hunk in the patch."""
    hunks: list[tuple[int, list[str]]] = []
    lines = patch_text.split("\n")
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.startswith("@@"):
            index += 1
            continue
        parts = line.split(" ")
        if len(parts) < 4 or not parts[1].startswith("-"):
            raise OverlayError(f"unsupported hunk header: {line}")
        old_range = parts[1][1:]
        start_text, _, _count = old_range.partition(",")
        try:
            start = int(start_text)
        except ValueError as error:
            raise OverlayError(f"unsupported hunk header: {line}") from error
        index += 1
        body: list[str] = []
        while index < len(lines):
            entry = lines[index]
            if entry.startswith("@@") or entry.startswith("--- ") or entry.startswith("+++ "):
                break
            if entry == "" and index == len(lines) - 1:
                index += 1
                break
            if entry[:1] not in (" ", "+", "-", "\\"):
                raise OverlayError(f"unsupported patch line: {entry!r}")
            if entry.startswith("\\"):
                raise OverlayError("patches without a trailing newline are not supported")
            body.append(entry)
            index += 1
        if not body:
            raise OverlayError("empty hunk")
        hunks.append((start, body))
    if not hunks:
        raise OverlayError("patch contains no hunks")
    return hunks


def apply_patch(original: str, patch_text: str, patch_name: str) -> str:
    source = split_lines(original)
    result: list[str] = []
    cursor = 0
    for start, body in parse_hunks(patch_text):
        begin = start - 1
        if begin < cursor or begin > len(source):
            raise OverlayError(f"{patch_name}: hunk at line {start} is out of order or out of range")
        result.extend(source[cursor:begin])
        cursor = begin
        for entry in body:
            marker, text = entry[0], entry[1:]
            if marker == " ":
                if cursor >= len(source) or source[cursor] != text:
                    raise OverlayError(f"{patch_name}: context mismatch at line {cursor + 1}")
                result.append(text)
                cursor += 1
            elif marker == "-":
                if cursor >= len(source) or source[cursor] != text:
                    raise OverlayError(f"{patch_name}: removal mismatch at line {cursor + 1}")
                cursor += 1
            elif marker == "+":
                result.append(text)
            else:
                raise OverlayError(f"{patch_name}: unsupported patch line: {entry!r}")
    result.extend(source[cursor:])
    return "".join(f"{line}\n" for line in result)


def safe_relative(root: Path, relative: str) -> Path:
    if relative.startswith("/") or relative in ("", ".", ".."):
        raise OverlayError(f"unsafe overlay path: {relative}")
    parts = Path(relative).parts
    if any(part in ("..", "") for part in parts):
        raise OverlayError(f"unsafe overlay path: {relative}")
    target = root / relative
    resolved_root = root.resolve(strict=True)
    parent = target.parent
    if parent.is_symlink():
        raise OverlayError(f"unsafe overlay path: {relative}")
    resolved_parent = parent.resolve(strict=True)
    if resolved_parent != resolved_root and resolved_root not in resolved_parent.parents:
        raise OverlayError(f"overlay path escapes the staged checkout: {relative}")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--verify-only", action="store_true")
    arguments = parser.parse_args()

    manifest_path = Path(arguments.manifest)
    root = Path(arguments.root)
    try:
        if not root.is_dir() or root.is_symlink():
            raise OverlayError(f"staged checkout is not a directory: {root}")
        manifest = json.loads(read_regular(manifest_path, MAX_PATCH_BYTES).decode("utf-8"))
        if manifest.get("schemaVersion") != 1:
            raise OverlayError("unsupported overlay manifest schema")
        if manifest.get("commit") != arguments.commit:
            raise OverlayError(
                f"overlay manifest commit {manifest.get('commit')!r} does not match the pin {arguments.commit!r}"
            )
        entries = manifest.get("files")
        if not isinstance(entries, list) or not entries:
            raise OverlayError("overlay manifest declares no files")

        staged: list[tuple[Path, str, str]] = []
        for entry in entries:
            for key in ("path", "patch", "base", "result"):
                if not isinstance(entry.get(key), str) or not entry[key]:
                    raise OverlayError(f"overlay manifest entry is incomplete: {entry!r}")
            target = safe_relative(root, entry["path"])
            patch_file = safe_relative(manifest_path.parent, entry["patch"])
            original = read_regular(target, MAX_TARGET_BYTES)
            actual = digest(original)
            if arguments.verify_only:
                # A published runtime is already overlaid, so it must carry the
                # recorded result digest, not the upstream base digest.
                if actual != entry["result"]:
                    raise OverlayError(
                        f"overlaid runtime mismatch for {entry['path']}: expected {entry['result']}, found {actual}"
                    )
                continue
            if actual != entry["base"]:
                raise OverlayError(
                    f"pinned source mismatch for {entry['path']}: expected {entry['base']}, found {actual}"
                )
            patch_text = read_regular(patch_file, MAX_PATCH_BYTES).decode("utf-8")
            patched = apply_patch(original.decode("utf-8"), patch_text, entry["patch"])
            encoded = patched.encode("utf-8")
            produced = digest(encoded)
            if produced != entry["result"]:
                raise OverlayError(
                    f"overlay result mismatch for {entry['path']}: expected {entry['result']}, produced {produced}"
                )
            staged.append((target, patched, entry["path"]))

        if arguments.verify_only:
            print(f"overlay: verified {len(entries)} managed file(s) for {arguments.commit}")
            return 0

        for target, patched, relative in staged:
            mode = target.stat().st_mode & 0o777
            temporary = target.with_name(f".{target.name}.fmx-overlay")
            with open(temporary, "w", encoding="utf-8", newline="") as handle:
                handle.write(patched)
            os.chmod(temporary, mode)
            os.replace(temporary, target)
            print(f"overlay: applied {relative}")
    except OverlayError as error:
        print(f"fmx overlay: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"fmx overlay: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
