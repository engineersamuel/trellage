#!/usr/bin/env python3
"""Verify exact public test fixtures before excluding them from secret checks."""

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

FIXTURES = Path(".quality/secret-fixtures.json")
SCANNER_CONFIG = Path(".quality/secrets.toml")


def public_fixtures(root: Path) -> set[str]:
    manifest = root / FIXTURES
    if not manifest.exists():
        return set()
    entries = json.loads(manifest.read_text())
    allowed = set()
    for name, entry in entries.items():
        path = root / name
        if Path(name).is_absolute() or ".." in Path(name).parts or path.is_symlink():
            raise ValueError(f"Unsafe public fixture path: {name}")
        if not entry.get("reason") or not re.fullmatch(r"[a-f0-9]{64}", entry.get("sha256", "")):
            raise ValueError(f"Invalid public fixture exception: {name}")
        if not path.exists():
            continue
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"Public secret fixture changed; explicit review required: {name}")
        allowed.add(name)
    return allowed


def check_publication(root: Path) -> bool:
    fixtures = public_fixtures(root)
    pattern = (
        r"ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY"
    )
    ignored = fixtures | {"tests/publication_contract.sh", "tests/publication_contract_self_test.sh"}
    result = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "grep",
            "-l",
            "-I",
            "-E",
            pattern,
            "--",
            ".",
            *[f":(exclude,literal){path}" for path in sorted(ignored)],
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode not in {0, 1}:
        raise RuntimeError(result.stderr)
    if result.returncode == 0:
        print(f"Obvious secret material is tracked in:\n{result.stdout}", file=sys.stderr)
        return False
    return True


if __name__ == "__main__":
    try:
        raise SystemExit(0 if check_publication(Path(__file__).resolve().parents[1]) else 1)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"publication secrets: {error}", file=sys.stderr)
        raise SystemExit(1) from error
