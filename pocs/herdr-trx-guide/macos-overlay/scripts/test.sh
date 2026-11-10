#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

report="$(mktemp "${TMPDIR:-/tmp}/trx-swift-tests.XXXXXX")"
trap 'rm -f -- "$report"' EXIT

# The generated test runner also needs the CLT Testing framework search path.
swift test --build-system native --enable-swift-testing \
  -Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  --xunit-output "$report" "$@"
uv run --offline --no-project python - "$report" <<'PY'
import sys
import xml.etree.ElementTree as ET

if not ET.parse(sys.argv[1]).findall(".//testcase"):
    raise SystemExit("Swift Testing did not execute any test cases")
PY
swift run --build-system native "$@" OverlayCoreTestRunner
