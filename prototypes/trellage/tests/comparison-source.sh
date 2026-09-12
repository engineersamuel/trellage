#!/usr/bin/env bash
# Exercise a provisioned comparison_source image without network access or real agents.
set -euo pipefail

[[ "$#" == 1 ]] || {
  printf 'usage: comparison-source.sh SOURCE_STAGE_IMAGE\n' >&2
  exit 2
}
repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
fixture_image="trellage-comparison-source-fixture:contract-${BASHPID:-$$}"
cleanup() {
  docker image rm "$fixture_image" >/dev/null \
    || printf 'comparison source contract: could not remove fixture image %s\n' "$fixture_image" >&2
}
trap cleanup EXIT

docker build --network=none --tag "$fixture_image" \
  --build-arg "COMPARISON_SOURCE_IMAGE=$1" \
  --file "$repo_root/prototypes/trellage/tests/Dockerfile.comparison-source" "$repo_root"
docker run --rm --network=none --entrypoint bash "$fixture_image" \
  /usr/local/bin/comparison-source-contract.sh
