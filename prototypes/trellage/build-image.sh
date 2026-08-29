#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
profile="$prototype_dir/../../profiles/codex-superpowers/profile.toml"

exec "$prototype_dir/trellage" build "$profile"
