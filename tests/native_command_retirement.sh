#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -P -- "$(dirname "$0")/.." && pwd -P)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/trellage-command-retirement.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT
home="$fixture/home"
runtime="$home/.local/share/trellage/omp"
mkdir -p "$home/.local/bin" "$runtime/bin" "$runtime/mise"
printf 'owned-v1\n' >"$runtime/.owned"
printf '#!/bin/sh\nexit 0\n' >"$runtime/bin/omp"
chmod +x "$runtime/bin/omp"
printf 'runtime\n' >"$runtime/mise/keep"
printf 'session\n' >"$home/session"
ln -s "$runtime/bin/omp" "$home/.local/bin/omp"
retire() {
  bash "$root/scripts/retire-native-command.sh" "$home" omp "$runtime/bin/omp" "$runtime/.owned" owned-v1
}
retire
[[ ! -L "$home/.local/bin/omp" && -x "$runtime/bin/omp" && -f "$runtime/mise/keep" && -f "$home/session" ]]
retire
printf '#!/bin/sh\nexit 7\n' >"$home/.local/bin/omp"
retire
[[ -f "$home/.local/bin/omp" && ! -L "$home/.local/bin/omp" ]]
rm "$home/.local/bin/omp"
ln -s "$fixture/unrelated" "$home/.local/bin/omp"
retire
[[ "$(readlink "$home/.local/bin/omp")" == "$fixture/unrelated" ]]
rm "$home/.local/bin/omp"
ln -s "$runtime/bin/omp" "$home/.local/bin/omp"
printf 'foreign\n' >"$runtime/.owned"
if retire; then
  printf 'retirement accepted an invalid ownership marker\n' >&2
  exit 1
fi
[[ -L "$home/.local/bin/omp" ]]

while read -r package command profile harness public_profile; do
  manager="$root/prototypes/$package/bin/$command"
  if HOME="$home" "$manager" "$profile" >"$fixture/manager.out" 2>"$fixture/manager.err"; then
    printf 'private profile manager launched through %s\n' "$command" >&2
    exit 1
  fi
  grep -Fq "use trx run $harness $public_profile" "$fixture/manager.err" \
    || { printf 'private profile manager did not point to trx run: %s\n' "$command" >&2; exit 1; }
done <<'EOF'
trellage-agency-profiles agx trellage-azure agency azure
trellage-claude-profiles cldx default claude default
trellage-codex-profiles cdx pstack codex PROFILE
trellage-copilot-profiles cpx hve copilot hve
trellage-firstmate-profiles fmx default firstmate default
trellage-jcode-profiles jcx default jcode default
trellage-omp-profiles omp copilot omp default
trellage-picx-profiles picx default pi default
trellage-prime-profiles prx default prime default
EOF

printf 'native command retirement: PASS\n'
