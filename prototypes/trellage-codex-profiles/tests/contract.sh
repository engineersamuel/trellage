#!/usr/bin/env bash

# Runs the whole trellage Codex contract serially.
#
# The contract is split into four blocks under tests/blocks/, each building its
# own fixture so `make` can schedule them concurrently. This script keeps the
# single-command entry point working and preserves the original block order.

set -u
set -o pipefail

tests_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"

for block in auth-config-launch lifecycle catalog installation; do
  bash "$tests_dir/blocks/$block.sh" || exit 1
done

printf 'trellage Codex profiles contract: PASS\n'
