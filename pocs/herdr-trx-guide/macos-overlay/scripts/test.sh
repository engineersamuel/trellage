#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

output="$(mktemp "${TMPDIR:-/tmp}/trx-swift-tests.XXXXXX")"
trap 'rm -f -- "$output"' EXIT

# The generated test runner also needs the CLT Testing framework search path.
swift test --build-system native --enable-swift-testing \
  -Xswiftc -F -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  "$@" 2>&1 | tee "$output"
if ! grep -Eq 'Test run with [1-9][0-9]* tests?' "$output"; then
  echo "Swift Testing did not report any executed test cases." >&2
  exit 1
fi
swift run --build-system native "$@" OverlayCoreTestRunner
