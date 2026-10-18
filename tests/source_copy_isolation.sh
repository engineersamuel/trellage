#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/trellage-copy-isolation.XXXXXX")"
fixture="$(cd "$fixture" && pwd -P)"
trap 'rm -rf -- "$fixture"' EXIT
export BUN_INSTALL_CACHE_DIR="${TRELLAGE_TEST_PACKAGE_CACHE:?run through scripts/test-offline.sh}"

bash "$root/scripts/install-source-runtime.sh" --stage "$fixture/first"
bash "$root/scripts/install-source-runtime.sh" --stage "$fixture/second"
python3 - "$fixture" <<'PY'
from pathlib import Path
import sys

fixture = Path(sys.argv[1]).resolve()
files = [(fixture / name / "node_modules/smol-toml/package.json").resolve() for name in ("first", "second")]
for name, file in zip(("first", "second"), files):
    assert file.is_relative_to(fixture / name), "dependency escaped its installed workspace"
first, second = files
assert first.stat().st_ino != second.stat().st_ino, "installations share a writable inode"
original = second.read_bytes()
original_mode = second.stat().st_mode
assert first.read_bytes() == original, "installed package contents differ"
first.write_text("fixture mutation\n")
first.chmod(0o600)
assert second.read_bytes() == original, "writing one installation changed another"
assert second.stat().st_mode == original_mode, "chmod changed another installation"
print("source dependency copy isolation: PASS")
PY
