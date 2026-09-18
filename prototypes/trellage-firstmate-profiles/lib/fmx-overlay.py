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
import re
import stat
import subprocess
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


def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise OverlayError("duplicate overlay field: " + key)
        result[key] = value
    return result


def validate_entry(entry, layered=False):
    keys = {"path", "patch", "base", "result"} | ({"mode"} if layered else set())
    if not isinstance(entry, dict) or set(entry) != keys:
        raise OverlayError("incomplete or unsupported overlay entry")
    for key in ("path", "patch"):
        value = entry[key]
        if (not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)*", value)
            or any(part in (".", "..") for part in value.split("/"))):
            raise OverlayError("invalid runtime overlay path")
    for key in ("base", "result"):
        if not isinstance(entry[key], str) or not re.fullmatch(r"[a-f0-9]{64}", entry[key]):
            raise OverlayError("invalid runtime overlay digest")
    if layered and entry["mode"] not in ("100644", "100755"):
        raise OverlayError("instance supplement must preserve an explicit Git file mode")


def variant_manifest(path, commit, layered=False):
    value = json.loads(read_regular(path, MAX_PATCH_BYTES), object_pairs_hook=unique_fields)
    keys = {"schemaVersion", "commit", "files"} | ({"variant"} if layered else set())
    if (not isinstance(value, dict) or set(value) != keys or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 1 or value["commit"] != commit):
        raise OverlayError("invalid named runtime overlay schema or source pin")
    if layered and value["variant"] != "firstmate-instance-v1":
        raise OverlayError("unsupported instance runtime variant")
    entries = value["files"]
    if not isinstance(entries, list) or not 1 <= len(entries) <= 64:
        raise OverlayError("overlay must contain 1 through 64 files")
    paths, patches = set(), set()
    for entry in entries:
        validate_entry(entry, layered)
        if entry["path"] in paths or entry["patch"] in patches:
            raise OverlayError("duplicate runtime overlay path or patch")
        paths.add(entry["path"])
        patches.add(entry["patch"])
    return value


def variant_manifests(base, supplement, commit):
    original = variant_manifest(base, commit)
    extra = variant_manifest(supplement, commit, True)
    union = {entry["path"]: entry for entry in original["files"]}
    for entry in extra["files"]:
        path = entry["path"]
        if path in union and entry["base"] != union[path]["result"]:
            raise OverlayError("instance supplement does not consume the base overlay result")
        union[path] = entry
    return original, extra, union


def variant_requirement(base, supplement, commit):
    _, _, union = variant_manifests(base, supplement, commit)
    closure = "".join(f'{path}:{entry["result"]}\n' for path, entry in sorted(union.items()))
    return {"schemaVersion": 1, "variant": "firstmate-instance-v1", "sourceRevision": commit,
            "baseManifestDigest": digest(read_regular(base, MAX_PATCH_BYTES)),
            "supplementManifestDigest": digest(read_regular(supplement, MAX_PATCH_BYTES)),
            "effectiveContentDigest": digest(closure.encode())}


def checkout_git(root, commit):
    if root.is_symlink() or (root / ".git").is_symlink() or not (root / ".git").is_dir():
        raise OverlayError("instance runtime must be its own real checkout")
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
    def git(*args):
        result = subprocess.run(["git", "-C", str(root), *args], env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30)
        return result.stdout
    if git("rev-parse", "HEAD").decode().strip() != commit:
        raise OverlayError("instance runtime HEAD differs from its source pin")
    return git


def verify_layer_inputs(git, layers):
    # Prove both layer inputs against the local pinned object store, including
    # paths touched only by the supplement. Published bytes alone are not proof.
    prior = {}
    for manifest, directory in layers:
        for entry in manifest["files"]:
            content = prior.get(entry["path"])
            if content is None:
                content = git("show", "HEAD:" + entry["path"])
            if digest(content) != entry["base"]:
                raise OverlayError("instance overlay input digest differs: " + entry["path"])
            patch = read_regular(safe_relative(directory, entry["patch"]), MAX_PATCH_BYTES).decode()
            content = apply_patch(content.decode(), patch, entry["patch"]).encode()
            if digest(content) != entry["result"]:
                raise OverlayError("instance overlay result digest differs: " + entry["path"])
            prior[entry["path"]] = content


def verify_union_files(root, git, union):
    for path, entry in union.items():
        target = safe_relative(root, path)
        if digest(read_regular(target, MAX_TARGET_BYTES)) != entry["result"]:
            raise OverlayError("instance runtime content differs: " + path)
        fields = git("ls-tree", "HEAD", "--", path).decode().split()
        if not fields or fields[0] not in ("100644", "100755"):
            raise OverlayError("instance runtime source file mode is invalid: " + path)
        tree_mode = fields[0]
        expected = 0o755 if tree_mode == "100755" else 0o644
        if stat.S_IMODE(target.stat().st_mode) != expected or entry.get("mode", tree_mode) != tree_mode:
            raise OverlayError("instance runtime file mode differs: " + path)


def verify_variant(root, base, supplement, commit):
    original, extra, union = variant_manifests(base, supplement, commit)
    git = checkout_git(root, commit)
    verify_layer_inputs(git, ((original, base.parent), (extra, supplement.parent)))
    verify_union_files(root, git, union)
    expected = {(" M " + path).encode() for path in union}
    actual = set(git("status", "--porcelain", "-z", "--untracked-files=all", "--ignored=matching").rstrip(b"\0").split(b"\0"))
    if actual != expected or git("diff", "--cached", "--name-only").strip():
        raise OverlayError("instance runtime has changes outside the verified overlay union")
    return variant_requirement(base, supplement, commit)


def variant_evidence(root, base, supplement, commit, mode):
    value = {"commit": commit, "digestAlgorithm": "sha256", "manifestDigest": None,
             "contentDigest": None, "fileCount": None, "verified": False}
    try:
        required = variant_requirement(base, supplement, commit)
        _, _, union = variant_manifests(base, supplement, commit)
        value.update(manifestDigest=digest(json.dumps(required, sort_keys=True, separators=(",", ":")).encode()),
                     contentDigest=required["effectiveContentDigest"], fileCount=len(union))
        if mode == "verify":
            verify_variant(root, base, supplement, commit)
            value["verified"] = True
    except (OverlayError, OSError, ValueError, subprocess.SubprocessError):
        pass
    return value


def verify_input_mode(target, entry):
    if "mode" in entry:
        if entry["mode"] not in ("100644", "100755"):
            raise OverlayError("invalid supplement input mode: " + entry["path"])
        expected_mode = 0o755 if entry["mode"] == "100755" else 0o644
        if stat.S_IMODE(target.stat().st_mode) != expected_mode:
            raise OverlayError("supplement input mode differs: " + entry["path"])


def prepare_entry(root, manifest_path, entry, verify_only):
    for key in ("path", "patch", "base", "result"):
        if not isinstance(entry.get(key), str) or not entry[key]:
            raise OverlayError(f"overlay manifest entry is incomplete: {entry!r}")
    target = safe_relative(root, entry["path"])
    patch_file = safe_relative(manifest_path.parent, entry["patch"])
    original = read_regular(target, MAX_TARGET_BYTES)
    actual = digest(original)
    verify_input_mode(target, entry)
    if verify_only:
        if actual != entry["result"]:
            raise OverlayError(f"overlaid runtime mismatch for {entry['path']}: expected {entry['result']}, found {actual}")
        return None
    if actual != entry["base"]:
        raise OverlayError(f"pinned source mismatch for {entry['path']}: expected {entry['base']}, found {actual}")
    patch_text = read_regular(patch_file, MAX_PATCH_BYTES).decode("utf-8")
    patched = apply_patch(original.decode("utf-8"), patch_text, entry["patch"])
    produced = digest(patched.encode("utf-8"))
    if produced != entry["result"]:
        raise OverlayError(f"overlay result mismatch for {entry['path']}: expected {entry['result']}, produced {produced}")
    return target, patched, entry["path"]


def apply_manifest(root, manifest_path, commit, verify_only):
    if not root.is_dir() or root.is_symlink():
        raise OverlayError(f"staged checkout is not a directory: {root}")
    manifest = json.loads(read_regular(manifest_path, MAX_PATCH_BYTES).decode("utf-8"), object_pairs_hook=unique_fields)
    if manifest.get("schemaVersion") != 1 or manifest.get("commit") != commit:
        raise OverlayError("overlay manifest schema or source pin differs")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise OverlayError("overlay manifest declares no files")
    staged = [prepare_entry(root, manifest_path, entry, verify_only) for entry in entries]
    if verify_only:
        print(f"overlay: verified {len(entries)} managed file(s) for {commit}")
        return
    for target, patched, relative in staged:
        mode = target.stat().st_mode & 0o777
        temporary = target.with_name(f".{target.name}.fmx-overlay")
        with open(temporary, "w", encoding="utf-8", newline="") as handle:
            handle.write(patched)
        os.chmod(temporary, mode)
        os.replace(temporary, target)
        print(f"overlay: applied {relative}")


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True, allow_abbrev=False)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--supplement")
    parser.add_argument("--variant-json", action="store_true")
    parser.add_argument("--evidence", choices=("static", "verify"))
    arguments = parser.parse_args()
    manifest_path, root = Path(arguments.manifest), Path(arguments.root)
    try:
        if arguments.supplement:
            supplement = Path(arguments.supplement)
            if arguments.evidence:
                result = variant_evidence(root, manifest_path, supplement, arguments.commit, arguments.evidence)
            elif arguments.variant_json:
                result = variant_requirement(manifest_path, supplement, arguments.commit)
            elif arguments.verify_only:
                result = verify_variant(root, manifest_path, supplement, arguments.commit)
            else:
                raise OverlayError("--supplement requires verification or evidence mode")
            print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        else:
            apply_manifest(root, manifest_path, arguments.commit, arguments.verify_only)
    except (OverlayError, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print(f"fmx overlay: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
