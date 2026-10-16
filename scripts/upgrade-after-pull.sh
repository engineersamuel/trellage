#!/usr/bin/env bash
# Run by the post-merge and post-rewrite hooks after `git pull` (with or without --rebase),
# once the Native runtime has been refreshed. Launches never update, so pulling is the
# moment harnesses, skills, and harness plugins catch up with upstream.
set -uo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
router="$repo_root/prototypes/trellage-router/bin/trx"
[[ -x "$router" ]] || {
  printf 'upgrade-after-pull: trx router is missing or not executable: %s\n' "$router" >&2
  exit 1
}

trx() {
  TRELLAGE_TRX_SOURCE_ROOT="$repo_root/prototypes/trellage-router" "$router" "$@"
}

status=0
printf 'upgrade-after-pull: updating Native harnesses and skills\n' >&2
trx upgrade all --native --yes || status=1
# `upgrade all` updates harness binaries and skills only; Codex and Copilot plugins update per profile.
for harness in codex copilot; do
  printf 'upgrade-after-pull: updating %s plugins\n' "$harness" >&2
  trx upgrade "$harness" --all || status=1
done
((status == 0)) || printf 'upgrade-after-pull: some updates failed; rerun %s\n' "$0" >&2
exit "$status"
