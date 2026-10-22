#!/usr/bin/env bash
# Run by the post-merge and post-rewrite hooks after `git pull` (with or without --rebase),
# refreshing the Native runtime first. Launches never update, so pulling is the
# moment harnesses, skills, and harness plugins catch up with upstream.
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
status=0
refresh="$repo_root/scripts/refresh-native-if-stale.sh"
if [[ ! -x "$refresh" ]]; then
  printf 'upgrade-after-pull: native freshness script is missing or not executable: %s\n' "$refresh" >&2
  status=1
elif ! "$refresh"; then
  printf 'upgrade-after-pull: Native runtime refresh failed; continuing with upgrades\n' >&2
  status=1
fi

router="$repo_root/prototypes/trellage-router/bin/trx"
[[ -x "$router" ]] || {
  printf 'upgrade-after-pull: trx router is missing or not executable: %s\n' "$router" >&2
  exit 1
}

# Git exports GIT_DIR, GIT_INDEX_FILE, and GIT_REFLOG_ACTION to hooks. Upgrades run git in skill
# and plugin caches; inheriting them would rebase this repository onto those caches instead.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars) GIT_REFLOG_ACTION

trx() {
  TRELLAGE_TRX_SOURCE_ROOT="$repo_root/prototypes/trellage-router" "$router" "$@"
}

printf 'upgrade-after-pull: updating Native harnesses and skills\n' >&2
trx upgrade all --yes || status=1
# `upgrade all` updates harness binaries and skills only; Copilot plugins update per profile.
printf 'upgrade-after-pull: updating copilot plugins\n' >&2
trx upgrade copilot --all || status=1
((status == 0)) || printf 'upgrade-after-pull: some refresh or update steps failed; rerun %s\n' "$0" >&2
exit "$status"
