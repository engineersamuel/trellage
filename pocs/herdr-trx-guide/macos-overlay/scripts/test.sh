#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The native SwiftPM backend locates the CLT installation's Testing macros.
swift test --build-system native "$@"
swift run --build-system native "$@" OverlayCoreTestRunner
