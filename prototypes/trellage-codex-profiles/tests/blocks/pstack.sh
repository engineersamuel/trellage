#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
repository_root="$(CDPATH= cd -- "$root/../.." && pwd)"

fail() {
  printf 'trellage Codex pstack contract failed: %s\n' "$1" >&2
  exit 1
}

fixture="$(mktemp -d "${TMPDIR:-/tmp}/trellage-pstack-contract.XXXXXX")"
case "$fixture" in "${TMPDIR:-/tmp}"/trellage-pstack-contract.*) ;; *) fail 'unsafe fixture root' ;; esac
cleanup() {
  case "$fixture" in "${TMPDIR:-/tmp}"/trellage-pstack-contract.*) rm -rf -- "$fixture" ;; esac
}
trap cleanup EXIT HUP INT TERM

runtime="$fixture/runtime"
home="$fixture/home"
fake_bin="$fixture/fake-bin"
state="$fixture/state"
common_runtime="$fixture/common/floating-skills-runtime"
shared_cache="$home/.local/share/trellage/common/skills"
mkdir -p "$runtime/bin" "$runtime/lib" "$fake_bin" "$state" "$home" \
  "$common_runtime" "$shared_cache/skills/fixture-personal"
cp "$root/bin/cdx" "$runtime/bin/cdx"
cp "$root/catalog.json" "$runtime/catalog.json"
cp "$root/../trellage-codex-common/native-codex" "$runtime/lib/native-codex"
cp "$repository_root/scripts/trellage-session-bridge.py" \
  "$runtime/lib/trellage-session-bridge.py"
chmod 0755 "$runtime/bin/cdx" "$runtime/lib/native-codex" \
  "$runtime/lib/trellage-session-bridge.py"
install -m 0555 "$repository_root/scripts/floating-skills.mjs" \
  "$common_runtime/floating-skills.mjs"
install -m 0444 "$repository_root/skills.json" "$common_runtime/skills.json"
printf '%s\n' '# Fixture skill' >"$shared_cache/skills/fixture-personal/SKILL.md"
printf '%s\n' fixture-personal >"$shared_cache/managed-skills.txt"
: >"$shared_cache/always-on.md"
printf '%040d\n' 1 >"$state/remote-revision"

cat >"$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
set -u
if [ "$*" = 'ls-remote https://github.com/Aqua-123/pstack-for-codex.git refs/heads/main' ]; then
  printf '%s\trefs/heads/main\n' "$(cat "$FAKE_PSTACK_STATE/remote-revision")"
  exit 0
fi
exit 91
EOF

cat >"$fake_bin/codex" <<'EOF'
#!/usr/bin/env bash
set -u

if [ "${1:-}" = --version ]; then
  printf 'codex-cli 0.149.1\n'
  exit 0
fi
if [ "$*" = 'login status' ]; then
  [ "$CODEX_HOME" = "$HOME/.codex" ] && [ -f "$HOME/.codex/auth.json" ]
  exit
fi

state="$FAKE_PSTACK_STATE"
marketplace=pstack-for-codex-local
plugin=pstack-for-codex
plugin_id="$plugin@$marketplace"
checkout="$CODEX_HOME/.tmp/marketplaces/$marketplace"
cache="$CODEX_HOME/plugins/cache/$marketplace/$plugin/0.1.0"
printf '%s\n' "$*" >>"$state/calls"

append_marketplace_config() {
  local staged="$CODEX_HOME/.config.$$"
  awk -v marker='# trellage-managed-codex-provider-end' \
    -v marketplace="$marketplace" \
    -v source='https://github.com/Aqua-123/pstack-for-codex.git' '
    $0 == marker {
      print ""
      print "[marketplaces." marketplace "]"
      print "source_type = \"git\""
      print "source = \"" source "\""
    }
    { print }
  ' "$CODEX_HOME/config.toml" >"$staged" || exit 1
  mv "$staged" "$CODEX_HOME/config.toml" || exit 1
  chmod 0600 "$CODEX_HOME/config.toml"
}

write_marketplace_install_metadata() {
  local revision="$1"
  jq -cn --arg revision "$revision" '{
    source_type:"git",
    source:"https://github.com/Aqua-123/pstack-for-codex.git",
    ref_name:null,
    sparse_paths:[],
    revision:$revision
  }' >"$checkout/.codex-marketplace-install.json"
}

append_plugin_config() {
  grep -Fqx -- "[plugins.\"$plugin_id\"]" "$CODEX_HOME/config.toml" && return
  local staged="$CODEX_HOME/.config.$$"
  awk -v marker='# trellage-managed-codex-provider-end' -v plugin_id="$plugin_id" '
    $0 == marker {
      print ""
      print "[plugins.\"" plugin_id "\"]"
      print "enabled = true"
    }
    { print }
  ' "$CODEX_HOME/config.toml" >"$staged" || exit 1
  mv "$staged" "$CODEX_HOME/config.toml" || exit 1
  chmod 0600 "$CODEX_HOME/config.toml"
}

case "$*" in
  'plugin marketplace list --json')
    if [ -f "$state/marketplace" ]; then
      jq -cn --arg root "$checkout" \
        '{marketplaces:[{name:"pstack-for-codex-local",root:$root,marketplaceSource:{sourceType:"git",source:"https://github.com/Aqua-123/pstack-for-codex.git"}}]}'
    else
      printf '%s\n' '{"marketplaces":[]}'
    fi
    ;;
  'plugin marketplace add Aqua-123/pstack-for-codex --json')
    mkdir -p "$checkout"
    : >"$state/marketplace"
    append_marketplace_config
    write_marketplace_install_metadata "$(cat "$state/remote-revision")"
    printf '%s\n' '{"alreadyAdded":false}'
    ;;
  'plugin marketplace upgrade pstack-for-codex-local --json')
    [ -f "$state/marketplace" ] || exit 92
    mkdir -p "$checkout"
    write_marketplace_install_metadata "$(cat "$state/remote-revision")"
    printf '%s\n' '{"updated":true}'
    ;;
  'plugin list --json')
    if [ -f "$state/plugin" ]; then
      jq -cn --arg checkout "$checkout" '{
        installed:[{
          pluginId:"pstack-for-codex@pstack-for-codex-local",
          name:"pstack-for-codex",
          marketplaceName:"pstack-for-codex-local",
          version:"0.1.0",
          installed:true,
          enabled:true,
          source:{source:"local",path:$checkout},
          marketplaceSource:{sourceType:"git",source:"https://github.com/Aqua-123/pstack-for-codex.git"},
          installPolicy:"AVAILABLE",
          authPolicy:"ON_INSTALL"
        }],
        available:[]
      }'
    else
      printf '%s\n' '{"installed":[],"available":[]}'
    fi
    ;;
  'plugin add pstack-for-codex@pstack-for-codex-local --json')
    mkdir -p "$cache/.codex-plugin" "$cache/skills"
    printf '%s\n' '{"name":"pstack-for-codex","version":"0.1.0","skills":"./skills"}' \
      >"$cache/.codex-plugin/plugin.json"
    index=1
    while [ "$index" -le 45 ]; do
      mkdir -p "$cache/skills/skill-$index"
      printf '# Skill %s\n' "$index" >"$cache/skills/skill-$index/SKILL.md"
      index=$((index + 1))
    done
    : >"$state/plugin"
    append_plugin_config
    printf '%s\n' '{"installed":true}'
    ;;
  'plugin remove pstack-for-codex@pstack-for-codex-local --json')
    rm -f -- "$state/plugin"
    rm -rf -- "$cache"
    printf '%s\n' '{"removed":true}'
    ;;
  'mcp list --json')
    printf '%s\n' '[]'
    ;;
  'debug prompt-input inventory')
    printf '%s\n' '[{"content":[{"type":"input_text","text":"### Available skills\n- pstack-fixture: fixture skill (file: /fixture/SKILL.md)\n- fixture-personal: shared skill (file: /shared/SKILL.md)\n### End"}]}]'
    ;;
  *)
    printf '%s\n' "$*" >"$state/launch"
    ;;
esac
EOF
chmod 0755 "$fake_bin/codex" "$fake_bin/git"

run_cdx() {
  HOME="$home" PATH="$fake_bin:$PATH" FAKE_PSTACK_STATE="$state" \
    "$runtime/bin/cdx" "$@"
}

run_cdx list --json >"$fixture/list.json"
jq -e '.launcher == "cdx" and .sandbox == true
  and (.profiles | map(.name)) == ["pstack", "superpowers", "youtube"]' "$fixture/list.json" >/dev/null \
  || fail 'list JSON differs'
run_cdx inventory pstack --json >"$fixture/inventory-before.json"
jq -e '.readiness == "not-setup" and .launcher == "cdx"' \
  "$fixture/inventory-before.json" >/dev/null || fail 'pre-setup inventory differs'
[ ! -e "$state/calls" ] || fail 'read-only pre-setup commands invoked Codex'

run_cdx setup pstack >"$fixture/setup.out" || fail 'setup failed'
grep -Fqx -- 'pstack: ready' "$fixture/setup.out" || fail 'setup output differs'
run_cdx doctor pstack >"$fixture/doctor.out" || fail 'doctor failed'
grep -Fqx -- 'pstack: healthy' "$fixture/doctor.out" || fail 'doctor output differs'
profile_home="$home/.local/share/trellage/profiles/codex/pstack/home"
[ -d "$profile_home" ] && [ ! -L "$profile_home" ] || fail 'profile home differs'
[ ! -e "$profile_home/agents" ] || fail 'optional agents were installed'
[ ! -e "$profile_home/benny" ] || fail 'Benny was enabled'

run_cdx inventory pstack --json >"$fixture/inventory.json"
jq -e '.launcher == "cdx" and .readiness == "healthy"
  and .skills.packageCount == 45
  and .plugins == [{name:"pstack-for-codex@pstack-for-codex-local",version:"0.1.0"}]' \
  "$fixture/inventory.json" >/dev/null || fail 'healthy inventory differs'

config_hash="$(shasum -a 256 "$profile_home/config.toml" | awk '{print $1}')"
run_cdx doctor pstack >/dev/null || fail 'second doctor failed'
[ "$(shasum -a 256 "$profile_home/config.toml" | awk '{print $1}')" = "$config_hash" ] \
  || fail 'doctor mutated config'

run_cdx pstack --version || fail 'pstack profile launch failed'
grep -Fq -- '--sandbox workspace-write' "$state/launch" \
  || fail 'native sandbox flags were not forwarded'
grep -Fq -- '--version' "$state/launch" || fail 'Codex argument was not forwarded'
run_cdx update --check pstack >"$fixture/update-current.out" \
  || fail 'current update check failed'
grep -Fq -- 'pstack: current (' "$fixture/update-current.out" \
  || fail 'current update check output differs'
printf '%040d\n' 2 >"$state/remote-revision"
update_status=0
run_cdx update --check pstack >"$fixture/update-available.out" || update_status=$?
[ "$update_status" -eq 1 ] || fail "update check status was $update_status"
grep -Fq -- 'pstack: update available (' "$fixture/update-available.out" \
  || fail 'available update output differs'
run_cdx update pstack >"$fixture/update.out" || fail 'update failed'
grep -Fqx -- 'pstack: updated' "$fixture/update.out" || fail 'update output differs'
run_cdx update --check pstack >/dev/null || fail 'post-update check was not current'

native_home="$home/.codex"
mkdir -p "$native_home"
printf '%s\n' '{"tokens":{"access_token":"fixture"}}' >"$native_home/auth.json"
chmod 0600 "$native_home/auth.json"
run_cdx --native-auth pstack --version || fail 'native-auth launch failed'
[ -f "$profile_home/auth.json" ] && [ ! -L "$profile_home/auth.json" ] \
  || fail 'native auth was not refreshed'

printf 'trellage Codex pstack contract: PASS\n'
