#!/usr/bin/env python3
"""Verify Firstmate base and instance overlay digest chains offline."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True

REPOSITORY = Path(__file__).resolve().parent.parent
PACKAGE = REPOSITORY / "prototypes/trellage-firstmate-profiles"
COMMITS = (
    "527aa7c12d25aadbdf3cc56791f87ae71fca5280",
    "4ad8cbaeafc109a17c1af3911867b7fe9e04e801",
)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def load_overlay():
    source = PACKAGE / "lib/firstmate-overlay.py"
    spec = importlib.util.spec_from_file_location("firstmate_overlay_contract", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load overlay engine: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify() -> None:
    overlay = load_overlay()
    for commit in COMMITS:
        fixture = PACKAGE / "tests/fixtures/firstmate" / commit
        manifest_path = PACKAGE / "overlay" / commit / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        outputs: dict[str, str] = {}
        for entry in manifest["files"]:
            original = (fixture / entry["path"]).read_text()
            patch = (manifest_path.parent / entry["patch"]).read_text()
            patched = overlay.apply_patch(original, patch, entry["patch"])
            if digest(original) != entry["base"] or digest(patched) != entry["result"]:
                raise AssertionError(f"base overlay digest differs: {commit}:{entry['path']}")
            outputs[entry["path"]] = patched

        supplement_path = PACKAGE / "instance-overlay" / commit / "manifest.json"
        if not supplement_path.exists():
            continue
        supplement = json.loads(supplement_path.read_text())
        for entry in supplement["files"]:
            original = outputs.get(entry["path"], (fixture / entry["path"]).read_text())
            patch = (supplement_path.parent / entry["patch"]).read_text()
            patched = overlay.apply_patch(original, patch, entry["patch"])
            if digest(original) != entry["base"] or digest(patched) != entry["result"]:
                raise AssertionError(f"instance overlay digest differs: {commit}:{entry['path']}")


if __name__ == "__main__":
    verify()
    print("firstmate overlay contract: PASS")
