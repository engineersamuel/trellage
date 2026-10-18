#!/usr/bin/env bash

omp_fixture_wait() {
  local ready="$1" label="$2" deadline=$((SECONDS + ${OMP_FIXTURE_WAIT_SECONDS:-30}))
  while [[ ! -e "$ready" ]]; do
    if ((SECONDS >= deadline)); then
      printf 'OMP fixture timed out waiting for %s: %s\n' "$label" "$ready" >&2
      return 124
    fi
    sleep 0.01
  done
}
