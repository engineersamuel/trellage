#!/usr/bin/env bash
set -euo pipefail

tests_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRELLAGE_HOST_PTY_ONLY=1 "$tests_dir/host_command_contract.sh"
