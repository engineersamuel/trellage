#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/trx-run-list-contract.XXXXXX")"
work="$(CDPATH= cd -- "$work" && pwd -P)"
trap 'rm -rf -- "$work"' EXIT
real_bun="$(command -v bun)"
# Explicit fixture preparation is outside the command under test.
"$root/scripts/install-source-runtime.sh" --stage "$work/source" >"$work/prepare.log" 2>&1 \
  || { tail -40 "$work/prepare.log" >&2; exit 1; }
mkdir -p "$work/home/.config/trellage" "$work/bin"
cat >"$work/home/.config/trellage/config.toml" <<'TOML'
[native.profiles.review]
harnesses = ["pi"]
[native.profiles.review.selection]
description = "Local patch review"
best_for = ["Review a patch"]
[native.profiles.undocumented]
harnesses = ["pi"]
[native.profiles.blocked]
harnesses = ["pi"]
prerequisites = [{ command = "nonexistent-review-tool", install = "DO NOT RUN" }]
TOML
chmod 0600 "$work/home/.config/trellage/config.toml"
for command in pi curl git; do
  printf '#!/bin/sh\necho invoked >> "%s"\nexit 99\n' "$work/invocations" >"$work/bin/$command"
  chmod 0755 "$work/bin/$command"
done
router="$work/source/prototypes/trellage-router/bin/trx"
run() {
  env HOME="$work/home" XDG_CACHE_HOME="$work/home/.cache" TRELLAGE_READINESS_MEMO=1 PATH="$work/bin:/usr/bin:/bin" TRELLAGE_BUN_EXECUTABLE="$real_bun" \
    TRELLAGE_TRX_SOURCE_ROOT="$work/source/prototypes/trellage-router" \
    TRELLAGE_CONFIG="$work/home/.config/trellage/config.toml" "$router" "$@"
}
snapshot() {
  find "$work/home" "$work/source" -type f -not -path '*/node_modules/*' -exec shasum -a 256 {} + | LC_ALL=C sort
}
snapshot >"$work/before"
run run list --json >"$work/list.json"
run run list >"$work/list.txt"
snapshot >"$work/after"
cmp "$work/before" "$work/after"
test ! -e "$work/invocations"
python3 - "$work/list.json" "$work/list.txt" <<'PY'
import json,sys
with open(sys.argv[1]) as f: result=json.load(f)
assert result['schemaVersion']==2
pi=next(h for h in result['harnesses'] if h['id']=='pi')
assert 'profiles' not in pi
review=next(p for p in result['profiles'] if p['id']=='review')
assert review['argument']=='review' and review['harnesses']==['pi']
assert len({p['id'] for p in result['profiles']})==len(result['profiles'])
assert review['guideEligibility']['eligible']
assert next(p for p in result['profiles'] if p['id']=='undocumented')['metadataStatus']=='incomplete'
assert any(p['id']=='blocked' for p in result['unavailable']['profiles'])
with open(sys.argv[2]) as f: text=f.read()
assert 'Local patch review' in text and 'Unavailable' in text
PY
if run list --json >"$work/retired.out" 2>"$work/retired.err"; then echo 'retired list unexpectedly succeeded' >&2; exit 1; fi
test ! -s "$work/retired.out"
grep -Fq 'mise run trx -- run list' "$work/retired.err"
if run run list --json --json >"$work/invalid.out" 2>"$work/invalid.err"; then exit 1; fi
test ! -s "$work/invalid.out"
# No automatic dependency preparation, even in source mode.
rm "$work/source/.trellage-source-ready.json"
if run run list --json >"$work/unprepared.out" 2>"$work/unprepared.err"; then exit 1; fi
test ! -e "$work/source/.trellage-source-ready.json"
test ! -s "$work/unprepared.out"
printf 'run list contract: PASS\n'
