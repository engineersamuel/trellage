#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'agx live: %s\n' "$1" >&2
  exit 1
}

has_exact_version() {
  local output="$1" expected="$2"
  grep -Eo '[0-9]+(\.[0-9]+)+([-+][0-9A-Za-z.-]+)?' <<<"$output" \
    | grep -Fxq -- "$expected"
}

[[ "${TRELLAGE_AGENCY_LIVE-}" == 1 ]] \
  || fail 'set TRELLAGE_AGENCY_LIVE=1 to run the paid, authenticated live proof'
[[ -n "${TRELLAGE_AGENCY_VERSION-}" ]] \
  || fail 'set TRELLAGE_AGENCY_VERSION to the exact verified Agency version'
[[ -n "${TRELLAGE_AGENCY_COPILOT_VERSION-}" ]] \
  || fail 'set TRELLAGE_AGENCY_COPILOT_VERSION to the exact Agency-managed Copilot version'
[[ -t 0 && -t 1 ]] || fail 'live proof requires an interactive terminal'

for command_name in agency agx git; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command not found: $command_name"
done

root="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)" \
  || fail 'run the live proof from the Trellage Git worktree'
root="$(CDPATH= cd -P -- "$root" && pwd -P)"
[[ -f "$root/agency.toml" && ! -L "$root/agency.toml" ]] \
  || fail "missing or unsafe repository Agency config: $root/agency.toml"
[[ "$PWD" == "$root" || "$PWD" == "$root/"* ]] \
  || fail 'current directory is outside the resolved Trellage worktree'

agency_version="$(agency --version 2>&1)" \
  || fail 'could not read the Agency version'
has_exact_version "$agency_version" "$TRELLAGE_AGENCY_VERSION" \
  || fail "Agency version does not match $TRELLAGE_AGENCY_VERSION"

agx doctor trellage-azure

copilot_version="$(agx trellage-azure --version 2>&1)" \
  || fail 'could not read the Agency-managed Copilot version'
has_exact_version "$copilot_version" "$TRELLAGE_AGENCY_COPILOT_VERSION" \
  || fail "Agency-managed Copilot version does not match $TRELLAGE_AGENCY_COPILOT_VERSION"

main_copilot="$HOME/.copilot"
main_before="$(mktemp "${TMPDIR:-/tmp}/agx-main-copilot-before.XXXXXX")" \
  || fail 'could not stage the main Copilot state snapshot'
main_after="$(mktemp "${TMPDIR:-/tmp}/agx-main-copilot-after.XXXXXX")" \
  || {
    rm -f -- "$main_before"
    fail 'could not stage the main Copilot state snapshot'
  }
trap 'rm -f -- "$main_before" "$main_after"' EXIT

snapshot_main_copilot() {
  if [[ ! -e "$main_copilot" ]]; then
    printf 'absent\n'
    return
  fi
  [[ -d "$main_copilot" && ! -L "$main_copilot" ]] \
    || fail "unsafe main Copilot path: $main_copilot"
  if stat -f '%N' "$main_copilot" >/dev/null 2>&1; then
    find "$main_copilot" -exec stat -f '%N %HT %z %m' {} \; 2>/dev/null
  else
    find "$main_copilot" -exec stat -c '%n %F %s %Y' {} \; 2>/dev/null
  fi | LC_ALL=C sort
}

snapshot_main_copilot >"$main_before"

cat <<'EOF'
Inside Copilot:
1. Run /env and confirm COPILOT_HOME is under profiles/agency/trellage-azure/home.
2. Run /mcp and confirm msft-learn and azure are present.
3. Confirm MCPs from the main ~/.copilot, .vscode/mcp.json, and .mcp.json are absent.
4. Make one read-only Microsoft Learn request.
5. Make read-only Azure subscription, resource-group, ACR, storage, and resource-health requests.
6. Do not create, update, delete, deploy, upload, or change permissions.
7. Exit Copilot.
EOF

agx trellage-azure

snapshot_main_copilot >"$main_after"
cmp -s "$main_before" "$main_after" \
  || fail 'the live session changed the main ~/.copilot state'

copilot_home="$HOME/.local/share/trellage/profiles/agency/trellage-azure/home"
[[ -d "$copilot_home" && ! -L "$copilot_home" ]] \
  || fail "isolated Copilot home is missing or unsafe: $copilot_home"
find "$copilot_home" -mindepth 1 -print -quit | grep -q . \
  || fail 'the live session wrote no state to the isolated Copilot home'

printf 'Confirm expected MCPs were present and ambient MCPs were absent [yes/no]: '
read -r mcp_confirmation
[[ "$mcp_confirmation" == yes ]] || fail 'MCP composition was not confirmed'
printf 'Confirm all requested MCP calls succeeded and were read-only [yes/no]: '
read -r request_confirmation
[[ "$request_confirmation" == yes ]] || fail 'read-only MCP requests were not confirmed'

printf 'agx live: PASS\n'
