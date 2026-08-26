#!/usr/bin/env bash

# Block B: profile lifecycle. Depends on durable `hve` and `superpowers`
# profile state, which `establish_main_profiles` rebuilds for this fixture.

set -u
set -o pipefail

blocks_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$blocks_dir/../lib/fixture.sh"
. "$blocks_dir/../lib/profiles.sh"

establish_main_profiles

assert_status() {
  expected_status="$1"
  label="$2"
  shift 2
  "$@" >"$fixture_root/$label.out" 2>&1
  actual_status=$?
  [ "$actual_status" -eq "$expected_status" ] \
    || fail "$label exit was $actual_status, expected $expected_status"
}

mkdir -p "$hve_home/sessions" "$hve_home/plugins/unrelated" \
  "$superpowers_home/sessions" "$superpowers_home/plugins/unrelated"
printf '%s\n' 'hve session bytes' >"$hve_home/sessions/keep.jsonl"
printf '%s\n' 'hve unrelated plugin bytes' >"$hve_home/plugins/unrelated/state"
printf '%s\n' 'superpowers session bytes' >"$superpowers_home/sessions/keep.jsonl"
printf '%s\n' 'superpowers unrelated plugin bytes' \
  >"$superpowers_home/plugins/unrelated/state"
cp "$hve_home/sessions/keep.jsonl" "$fixture_root/snapshot-session.saved"
write_isolation_snapshot snapshot-sensitivity
printf '%s\n' 'mutated session bytes' >"$hve_home/sessions/keep.jsonl"
write_isolation_snapshot snapshot-sensitivity-after
if cmp -s "$fixture_root/snapshot-sensitivity.state-before" \
  "$fixture_root/snapshot-sensitivity-after.state-before"; then
  fail 'isolation snapshot did not detect a session mutation'
fi
mv "$fixture_root/snapshot-session.saved" "$hve_home/sessions/keep.jsonl"

# Repeated setup must read both inventories and never mutate native plugin state.
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot setup-hve-ordinary
HOME="$fixture_root/home" fake_env "$fixture_launcher" setup hve \
  >"$fixture_root/setup-hve-idempotent.out" || fail 'idempotent setup hve failed'
assert_isolation_snapshot_unchanged setup-hve-ordinary
jq -se '
  length == 4
  and map(.args) == [
    ["plugin","marketplace","list","--json"],
    ["plugin","list","--json"],
    ["plugin","marketplace","list","--json"],
    ["plugin","list","--json"]
  ]
' "$fixture_root/fake-codex.log" >/dev/null || fail 'idempotent setup mutated lifecycle state'

: >"$fixture_root/fake-codex.log"
write_isolation_snapshot setup-all-ordinary
HOME="$fixture_root/home" fake_env "$fixture_launcher" setup --all \
  >"$fixture_root/setup-all-idempotent.out" || fail 'idempotent setup --all failed'
assert_isolation_snapshot_unchanged setup-all-ordinary
jq -se --arg hve "$hve_home" --arg pstack "$pstack_home" \
  --arg superpowers "$superpowers_home" '
  length == 12
  and all(.[0:4][]; .codexHome == $hve)
  and all(.[4:8][]; .codexHome == $pstack)
  and all(.[8:12][]; .codexHome == $superpowers)
  and all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))
' "$fixture_root/fake-codex.log" >/dev/null || fail 'setup --all order or idempotence differs'

# Lifecycle actions still share the profile lock with each other. One held
# setup must block other lifecycle work without native activity until release.
# Codex sessions no longer hold that lock for the whole run.
lifecycle_lock_bash_env="$fixture_root/lifecycle-lock.bashenv"
cat >"$lifecycle_lock_bash_env" <<'EOF'
set -T
trap '
  case "$BASH_COMMAND" in
    acquire_profile_launch_lock*)
      if [ "$0" = "$CDX_TEST_LAUNCHER_PATH" ] \
        && [ ! -f "$CDX_TEST_LOCK_ATTEMPT" ]; then
        : >"$CDX_TEST_LOCK_ATTEMPT"
      fi
      ;;
  esac
' DEBUG
EOF

assert_lifecycle_waits_for_lifecycle() {
  local label="$1" hold_dir="$fixture_root/lifecycle-lock-$1"
  local holder_pid holder_group contender_pid wait_count before_calls after_calls
  local holder_status=0 contender_status=0
  shift

  mkdir "$hold_dir"
  : >"$fixture_root/fake-codex.log"
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    FAKE_CODEX_LIFECYCLE_HOLD_DIR="$hold_dir" \
    "$fixture_launcher" setup hve >"$hold_dir/holder.out" 2>&1 &
  holder_pid=$!
  track_async_pid "$holder_pid"
  wait_count=0
  while [ ! -f "$hold_dir/first-started" ] && [ "$wait_count" -lt 100 ]; do
    sleep 0.05
    wait_count=$((wait_count + 1))
  done
  [ -f "$hold_dir/first-started" ] \
    || fail "$label held lifecycle action did not start"
  holder_group="$(cat "$hold_dir/first-child.pid")"
  track_async_group "$holder_group"
  before_calls="$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')"

  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    BASH_ENV="$lifecycle_lock_bash_env" \
    CDX_TEST_LAUNCHER_PATH="$fixture_launcher" \
    CDX_TEST_LOCK_ATTEMPT="$hold_dir/lock-attempt" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" "$@" >"$hold_dir/contender.out" 2>&1 &
  contender_pid=$!
  track_async_pid "$contender_pid"
  wait_count=0
  while [ ! -f "$hold_dir/lock-attempt" ] \
    && kill -0 "$contender_pid" 2>/dev/null \
    && [ "$wait_count" -lt 100 ]; do
    sleep 0.05
    wait_count=$((wait_count + 1))
  done
  [ -f "$hold_dir/lock-attempt" ] \
    || fail "$label did not use the shared lifecycle lock"
  sleep 0.1
  kill -0 "$contender_pid" 2>/dev/null \
    || fail "$label did not wait for the held lifecycle action"
  after_calls="$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')"
  [ "$after_calls" = "$before_calls" ] \
    || fail "$label invoked native lifecycle activity while another lifecycle held the lock"

  : >"$hold_dir/release-first"
  wait "$holder_pid" || holder_status=$?
  wait "$contender_pid" || contender_status=$?
  [ "$holder_status" -eq 0 ] || fail "$label held lifecycle action failed"
  [ "$contender_status" -eq 0 ] \
    || fail "$label did not proceed after lifecycle lock release"
  [ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
    || fail "$label left profile launch lock state"
  [ ! -e "$hve_home/.launch-lock-reap" ] \
    && [ ! -L "$hve_home/.launch-lock-reap" ] \
    || fail "$label left profile launch lock recovery state"
  untrack_async_pid "$holder_pid"
  untrack_async_group "$holder_group"
  untrack_async_pid "$contender_pid"
}

# A blocked lifecycle contender must report which pid holds the profile lock.
assert_lifecycle_reports_lock_holder() {
  local hold_dir="$fixture_root/lifecycle-lock-report"
  local holder_pid holder_group contender_pid lock_owner wait_count
  local holder_status=0 contender_status=0

  mkdir "$hold_dir"
  : >"$fixture_root/fake-codex.log"
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    FAKE_CODEX_LIFECYCLE_HOLD_DIR="$hold_dir" \
    "$fixture_launcher" setup hve >"$hold_dir/holder.out" 2>&1 &
  holder_pid=$!
  track_async_pid "$holder_pid"
  wait_count=0
  while [ ! -f "$hold_dir/first-started" ] && [ "$wait_count" -lt 100 ]; do
    sleep 0.05
    wait_count=$((wait_count + 1))
  done
  [ -f "$hold_dir/first-started" ] \
    || fail 'lock-report held lifecycle action did not start'
  holder_group="$(cat "$hold_dir/first-child.pid")"
  track_async_group "$holder_group"
  lock_owner="$(awk '{print $1}' "$hve_home/.launch.lock")"

  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" doctor hve >"$hold_dir/contender.out" 2>&1 &
  contender_pid=$!
  track_async_pid "$contender_pid"
  wait_count=0
  while ! grep -q 'waiting for profile lock' "$hold_dir/contender.out" 2>/dev/null \
    && kill -0 "$contender_pid" 2>/dev/null \
    && [ "$wait_count" -lt 100 ]; do
    sleep 0.05
    wait_count=$((wait_count + 1))
  done
  grep -q "waiting for profile lock: hve is held by pid $lock_owner" \
    "$hold_dir/contender.out" \
    || fail 'lock-report contender did not name the blocking pid'

  : >"$hold_dir/release-first"
  wait "$holder_pid" || holder_status=$?
  wait "$contender_pid" || contender_status=$?
  [ "$holder_status" -eq 0 ] || fail 'lock-report held lifecycle action failed'
  [ "$contender_status" -eq 0 ] \
    || fail 'lock-report did not proceed after lifecycle lock release'
  untrack_async_pid "$holder_pid"
  untrack_async_group "$holder_group"
  untrack_async_pid "$contender_pid"
}

assert_lifecycle_waits_for_lifecycle doctor doctor hve
assert_lifecycle_waits_for_lifecycle update update hve
assert_lifecycle_waits_for_lifecycle setup setup hve
assert_lifecycle_waits_for_lifecycle repair repair hve
assert_lifecycle_waits_for_lifecycle update-check update --check hve

assert_lifecycle_reports_lock_holder

# Concurrent Codex sessions against one profile must both enter native Codex
# while the first session is still live.
concurrent_launch_dir="$fixture_root/concurrent-launches"
mkdir "$concurrent_launch_dir"
: >"$fixture_root/fake-codex.log"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_OVERLAP_DIR="$concurrent_launch_dir" \
  "$fixture_launcher" hve --version >"$concurrent_launch_dir/first.out" 2>&1 &
concurrent_first_pid=$!
track_async_pid "$concurrent_first_pid"
wait_count=0
while [ ! -f "$concurrent_launch_dir/first-started" ] && [ "$wait_count" -lt 100 ]; do
  sleep 0.05
  wait_count=$((wait_count + 1))
done
[ -f "$concurrent_launch_dir/first-started" ] \
  || fail 'concurrent first launch did not start'
concurrent_first_group="$(cat "$concurrent_launch_dir/first-child.pid")"
track_async_group "$concurrent_first_group"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_OVERLAP_DIR="$concurrent_launch_dir" \
  "$fixture_launcher" hve --version >"$concurrent_launch_dir/second.out" 2>&1 &
concurrent_second_pid=$!
track_async_pid "$concurrent_second_pid"
wait_count=0
while [ ! -f "$concurrent_launch_dir/second-started" ] \
  && kill -0 "$concurrent_second_pid" 2>/dev/null \
  && [ "$wait_count" -lt 100 ]; do
  sleep 0.05
  wait_count=$((wait_count + 1))
done
[ -f "$concurrent_launch_dir/second-started" ] \
  || fail 'concurrent second launch did not enter Codex beside the first'
kill -0 "$concurrent_first_pid" 2>/dev/null \
  || fail 'concurrent first launch exited before second entered'
: >"$concurrent_launch_dir/release-first"
concurrent_first_status=0
concurrent_second_status=0
wait "$concurrent_first_pid" || concurrent_first_status=$?
wait "$concurrent_second_pid" || concurrent_second_status=$?
[ "$concurrent_first_status" -eq 0 ] || fail 'concurrent first launch failed'
[ "$concurrent_second_status" -eq 0 ] \
  || { cat "$concurrent_launch_dir/second.out" >&2; fail 'concurrent second launch failed'; }
[ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
  || fail 'concurrent launches left profile lock state'
untrack_async_pid "$concurrent_first_pid"
untrack_async_group "$concurrent_first_group"
untrack_async_pid "$concurrent_second_pid"

# Launch is isolated from lifecycle mutations and network fetches.
: >"$fixture_root/fake-codex.log"
rm -f "$fixture_root/fake-curl.log"
write_isolation_snapshot launch-ordinary
HOME="$fixture_root/home" fake_env "$fixture_launcher" superpowers --version \
  || fail 'superpowers launch failed'
assert_isolation_snapshot_unchanged launch-ordinary
jq -se --arg trustPath "$(CDPATH= cd -P -- . && pwd)" "
$(strip_project_trust_c_jq)
  length == 1
  and (.[0].args | strip_project_trust_c) == [
    \"--sandbox\", \"workspace-write\", \"-c\", \"sandbox_workspace_write.network_access=true\",
    \"--ask-for-approval\", \"never\", \"--disable\", \"default_mode_request_user_input\",
    \"--dangerously-bypass-hook-trust\", \"--version\"
  ]
  and any(.[0].args[]; is_project_trust_override and contains(\$trustPath))
" "$fixture_root/fake-codex.log" >/dev/null || fail 'launch lifecycle isolation differs'
[ ! -e "$fixture_root/fake-curl.log" ] || fail 'launch invoked curl'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'launch created host authentication'
auth_is_absent "$superpowers_home/auth.json" \
  || fail 'launch created profile authentication'

# Doctor reads both inventories without consulting authentication.
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot doctor-ordinary
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor hve \
  >"$fixture_root/doctor-inventory.out" || fail 'doctor inventory read failed'
assert_isolation_snapshot_unchanged doctor-ordinary
jq -se '
  length == 2
  and .[0].args == ["plugin","marketplace","list","--json"]
  and .[1].args == ["plugin","list","--json"]
' "$fixture_root/fake-codex.log" >/dev/null || fail 'doctor native order differs'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'doctor created host authentication'
auth_is_absent "$hve_home/auth.json" || fail 'doctor created profile authentication'

: >"$fixture_root/fake-codex.log"
write_isolation_snapshot repair-ordinary
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair hve \
  >"$fixture_root/repair-healthy.out" || fail 'healthy repair failed'
assert_isolation_snapshot_unchanged repair-ordinary
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'repair created host authentication'
auth_is_absent "$hve_home/auth.json" || fail 'repair created profile authentication'

assert_owned_temps_cleaned() {
  local label="$1" temp_directory="$2"
  if find "$temp_directory" -type f ! -name 'cdx-inventory.user-owned' -print \
    | grep . >/dev/null; then
    fail "$label left an owned temporary file"
  fi
  [ -f "$temp_directory/cdx-inventory.user-owned" ] \
    || fail "$label removed an unowned temporary file"
}

die_temp_directory="$fixture_root/"$'die\ntemp'
mkdir "$die_temp_directory"
printf '%s\n' 'keep' >"$die_temp_directory/cdx-inventory.user-owned"
cp "$hve_home/config.toml" "$fixture_root/config-before-temp-die.toml"
assert_command_fails owned-temp-nested-die env HOME="$fixture_root/home" \
  TMPDIR="$die_temp_directory" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_REMOVE_CONFIG_AFTER_MARKETPLACE=1 \
  "$fixture_launcher" doctor hve
cp "$fixture_root/config-before-temp-die.toml" "$hve_home/config.toml"
assert_owned_temps_cleaned nested-die "$die_temp_directory"

signal_temp_directory="$fixture_root/signal-temp"
mkdir "$signal_temp_directory"
printf '%s\n' 'keep' >"$signal_temp_directory/cdx-inventory.user-owned"
assert_command_fails owned-temp-term env HOME="$fixture_root/home" \
  TMPDIR="$signal_temp_directory" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_CODEX_SIGNAL_PARENT=TERM \
  "$fixture_launcher" doctor hve
assert_owned_temps_cleaned term "$signal_temp_directory"

# Both inventories are strict single JSON documents with the 0.146 object shape.
inventory_bad="$fixture_root/inventory-bad.json"
for bad_inventory in malformed empty concatenated array wrong-keys wrong-type; do
  case "$bad_inventory" in
    malformed) printf '{\n' >"$inventory_bad" ;;
    empty) : >"$inventory_bad" ;;
    concatenated) printf '%s\n%s\n' '{"marketplaces":[]}' '{"marketplaces":[]}' >"$inventory_bad" ;;
    array) printf '%s\n' '[]' >"$inventory_bad" ;;
    wrong-keys) printf '%s\n' '{"installed":[]}' >"$inventory_bad" ;;
    wrong-type) printf '%s\n' '{"marketplaces":{}}' >"$inventory_bad" ;;
  esac
  : >"$fixture_root/fake-codex.log"
  FAKE_CODEX_MARKETPLACE_OVERRIDE="$inventory_bad" \
    assert_command_fails "marketplace-$bad_inventory" env HOME="$fixture_root/home" \
      PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
      "$fixture_launcher" doctor hve
  jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
    "$fixture_root/fake-codex.log" >/dev/null || fail "malformed marketplace mutated state: $bad_inventory"
done

for bad_inventory in malformed empty concatenated array wrong-keys wrong-type; do
  case "$bad_inventory" in
    malformed) printf '{\n' >"$inventory_bad" ;;
    empty) : >"$inventory_bad" ;;
    concatenated) printf '%s\n%s\n' '{"installed":[],"available":[]}' '{"installed":[],"available":[]}' >"$inventory_bad" ;;
    array) printf '%s\n' '[]' >"$inventory_bad" ;;
    wrong-keys) printf '%s\n' '{"installed":[]}' >"$inventory_bad" ;;
    wrong-type) printf '%s\n' '{"installed":{},"available":[]}' >"$inventory_bad" ;;
  esac
  : >"$fixture_root/fake-codex.log"
  FAKE_CODEX_PLUGIN_OVERRIDE="$inventory_bad" \
    assert_command_fails "plugin-$bad_inventory" env HOME="$fixture_root/home" \
      PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
      "$fixture_launcher" doctor hve
  jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
    "$fixture_root/fake-codex.log" >/dev/null || fail "malformed plugin mutated state: $bad_inventory"
done

valid_hve_plugin="$fixture_root/valid-hve-plugin.json"
jq -cn --arg root "$fake_adapter_root" '{installed:[{pluginId:"hve-core-all@hve-core",name:"hve-core-all",marketplaceName:"hve-core",version:"3.3.101",installed:true,enabled:true,source:{source:"git",url:"https://github.com/microsoft/hve-core.git",ref:"main"},marketplaceSource:{sourceType:"local",source:$root},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}],available:[]}' >"$valid_hve_plugin"

cp "$fixture_adapter" "$fixture_root/adapter-before-derived-version.json"
jq '.plugins[0].version = "3.3.102"' "$fixture_adapter" \
  >"$fixture_root/adapter-derived-version.json" \
  || fail 'could not create alternate adapter version'
mv "$fixture_root/adapter-derived-version.json" "$fixture_adapter"
jq -cn --arg root "$fake_adapter_root" \
  '{installed:[{pluginId:"hve-core-all@hve-core",name:"hve-core-all",marketplaceName:"hve-core",version:"3.3.102",installed:true,enabled:true,source:{source:"git",url:"https://github.com/microsoft/hve-core.git",ref:"main"},marketplaceSource:{sourceType:"local",source:$root},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}],available:[]}' \
  >"$fixture_root/derived-version-plugin.json"
FAKE_CODEX_PLUGIN_OVERRIDE="$fixture_root/derived-version-plugin.json" \
  HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor hve \
  >"$fixture_root/doctor-derived-version.out" \
  || fail 'HVE inventory version was not derived from validated adapter metadata'
mv "$fixture_root/adapter-before-derived-version.json" "$fixture_adapter"

assert_selected_plugin_rejected() {
  plugin_label="$1"
  plugin_filter="$2"
  jq "$plugin_filter" "$valid_hve_plugin" >"$inventory_bad" \
    || fail "could not create plugin inventory case: $plugin_label"
  : >"$fixture_root/fake-codex.log"
  FAKE_CODEX_PLUGIN_OVERRIDE="$inventory_bad" \
    assert_command_fails "plugin-selected-$plugin_label" env HOME="$fixture_root/home" \
      PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
      "$fixture_launcher" doctor hve
  jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
    "$fixture_root/fake-codex.log" >/dev/null || fail "invalid selected plugin mutated state: $plugin_label"
}
assert_selected_plugin_rejected missing '.installed = []'
assert_selected_plugin_rejected duplicate '.installed += [.installed[0]]'
assert_selected_plugin_rejected not-installed '.installed[0].installed = false'
assert_selected_plugin_rejected disabled '.installed[0].enabled = false'
assert_selected_plugin_rejected empty-version '.installed[0].version = ""'
assert_selected_plugin_rejected wrong-version '.installed[0].version = "3.3.100"'
assert_selected_plugin_rejected wrong-version-type '.installed[0].version = 1'
assert_selected_plugin_rejected wrong-plugin-id '.installed[0].pluginId = "other@hve-core"'
assert_selected_plugin_rejected wrong-marketplace '.installed[0].marketplaceName = "other"'
assert_selected_plugin_rejected wrong-source-url '.installed[0].source.url = "https://example.com/wrong.git"'
assert_selected_plugin_rejected wrong-source-kind '.installed[0].source.source = "url"'
assert_selected_plugin_rejected wrong-source-ref '.installed[0].source.ref = "wrong"'
assert_selected_plugin_rejected wrong-provenance '.installed[0].marketplaceSource.source = "/wrong"'
assert_selected_plugin_rejected unsafe-installed-path '.installed[0].installedPath = "/outside-selected-home"'

assert_selected_plugin_path_rejected() {
  local plugin_label="$1" installed_path="$2"
  jq --arg installedPath "$installed_path" '.installed[0].installedPath = $installedPath' \
    "$valid_hve_plugin" >"$inventory_bad" \
    || fail "could not create plugin inventory path case: $plugin_label"
  : >"$fixture_root/fake-codex.log"
  FAKE_CODEX_PLUGIN_OVERRIDE="$inventory_bad" \
    assert_command_fails "plugin-selected-$plugin_label" env HOME="$fixture_root/home" \
      PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
      "$fixture_launcher" doctor hve
  jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
    "$fixture_root/fake-codex.log" >/dev/null \
    || fail "invalid selected plugin path mutated state: $plugin_label"
}

mkdir -p "$hve_home/../outside-plugin" "$fixture_root/external-plugin"
ln -s "$fixture_root/external-plugin" "$hve_home/plugin-link"
assert_selected_plugin_path_rejected traversal-installed-path "$hve_home/../outside-plugin"
assert_selected_plugin_path_rejected symlink-installed-path "$hve_home/plugin-link"
assert_selected_plugin_path_rejected missing-installed-path "$hve_home/missing-plugin"
rm "$hve_home/plugin-link"

printf '%s\n' '{"marketplaces":[{"name":"hve-core","root":"/wrong","marketplaceSource":{"sourceType":"local","source":"/wrong"}}]}' >"$inventory_bad"
: >"$fixture_root/fake-codex.log"
FAKE_CODEX_MARKETPLACE_OVERRIDE="$inventory_bad" \
  assert_command_fails marketplace-wrong-source env HOME="$fixture_root/home" \
    PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" repair hve
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null || fail 'wrong marketplace source caused mutation'

: >"$fake_state/hve/forbidden-superpowers-direct"
: >"$fixture_root/fake-codex.log"
FAKE_CODEX_MARKETPLACE_OVERRIDE="$inventory_bad" \
  assert_command_fails marketplace-contamination-atomic env HOME="$fixture_root/home" \
    PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" repair hve
[ -e "$fake_state/hve/forbidden-superpowers-direct" ] \
  || fail 'invalid marketplace caused forbidden-plugin mutation'
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'invalid marketplace with contamination caused native mutation'
rm "$fake_state/hve/forbidden-superpowers-direct"

atomic_bad_plugin="$fixture_root/atomic-bad-selected-plugin.json"
jq '.installed[0].version = "wrong" | .installed += [{pluginId:"superpowers",name:"superpowers",marketplaceName:null,version:"6.2.0",installed:true,enabled:false,source:{source:"git",url:"obra/superpowers"},marketplaceSource:null,installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}]' \
  "$valid_hve_plugin" >"$atomic_bad_plugin"
: >"$fake_state/hve/forbidden-superpowers-direct"
: >"$fixture_root/fake-codex.log"
FAKE_CODEX_PLUGIN_OVERRIDE="$atomic_bad_plugin" \
  assert_command_fails plugin-contamination-atomic env HOME="$fixture_root/home" \
    PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" repair hve
[ -e "$fake_state/hve/forbidden-superpowers-direct" ] \
  || fail 'invalid selected plugin caused forbidden-plugin mutation'
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'invalid selected plugin with contamination caused native mutation'
rm "$fake_state/hve/forbidden-superpowers-direct"

for marketplace_case in missing duplicate wrong-name wrong-kind; do
  case "$marketplace_case" in
    missing) printf '%s\n' '{"marketplaces":[]}' >"$inventory_bad" ;;
    duplicate) jq -cn --arg root "$fake_adapter_root" '{marketplaces:[{name:"hve-core",root:$root,marketplaceSource:{sourceType:"local",source:$root}},{name:"hve-core",root:$root,marketplaceSource:{sourceType:"local",source:$root}}]}' >"$inventory_bad" ;;
    wrong-name) jq -cn --arg root "$fake_adapter_root" '{marketplaces:[{name:"other",root:$root,marketplaceSource:{sourceType:"local",source:$root}}]}' >"$inventory_bad" ;;
    wrong-kind) jq -cn --arg root "$fake_adapter_root" '{marketplaces:[{name:"hve-core",root:$root,marketplaceSource:{sourceType:"git",source:$root}}]}' >"$inventory_bad" ;;
  esac
  : >"$fixture_root/fake-codex.log"
  FAKE_CODEX_MARKETPLACE_OVERRIDE="$inventory_bad" \
    assert_command_fails "marketplace-selected-$marketplace_case" env HOME="$fixture_root/home" \
      PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
      "$fixture_launcher" doctor hve
  jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
    "$fixture_root/fake-codex.log" >/dev/null || fail "invalid selected marketplace mutated state: $marketplace_case"
done

printf '%s\n' '{"marketplaces":[{"name":"superpowers-marketplace","root":"/outside-selected-home","marketplaceSource":{"sourceType":"git","source":"https://github.com/obra/superpowers-marketplace.git"}}]}' >"$inventory_bad"
FAKE_CODEX_MARKETPLACE_OVERRIDE="$inventory_bad" \
  assert_command_fails marketplace-outside-home env HOME="$fixture_root/home" \
    PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" doctor superpowers

assert_selected_marketplace_path_rejected() {
  local marketplace_label="$1" marketplace_root="$2"
  jq -cn --arg root "$marketplace_root" \
    '{marketplaces:[{name:"superpowers-marketplace",root:$root,marketplaceSource:{sourceType:"git",source:"https://github.com/obra/superpowers-marketplace.git"}}]}' \
    >"$inventory_bad" || fail "could not create marketplace path case: $marketplace_label"
  : >"$fixture_root/fake-codex.log"
  FAKE_CODEX_MARKETPLACE_OVERRIDE="$inventory_bad" \
    assert_command_fails "marketplace-selected-$marketplace_label" env HOME="$fixture_root/home" \
      PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
      "$fixture_launcher" doctor superpowers
  jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
    "$fixture_root/fake-codex.log" >/dev/null \
    || fail "invalid selected marketplace path mutated state: $marketplace_label"
}

mkdir -p "$superpowers_home/../outside-marketplace" "$fixture_root/external-marketplace"
ln -s "$fixture_root/external-marketplace" "$superpowers_home/marketplace-link"
assert_selected_marketplace_path_rejected traversal-root "$superpowers_home/../outside-marketplace"
assert_selected_marketplace_path_rejected symlink-root "$superpowers_home/marketplace-link"
assert_selected_marketplace_path_rejected missing-root "$superpowers_home/missing-marketplace"
rm "$superpowers_home/marketplace-link"

traversal_version_plugin="$fixture_root/traversal-version-superpowers-plugin.json"
jq -cn '{installed:[{pluginId:"superpowers@superpowers-marketplace",name:"superpowers",marketplaceName:"superpowers-marketplace",version:"../unrelated/1.0.0",installed:true,enabled:true,source:{source:"git",url:"https://github.com/obra/superpowers.git"},marketplaceSource:{sourceType:"git",source:"https://github.com/obra/superpowers-marketplace.git"},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}],available:[]}' \
  >"$traversal_version_plugin"
FAKE_CODEX_PLUGIN_OVERRIDE="$traversal_version_plugin" \
  assert_command_fails plugin-selected-traversal-version env \
    HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" doctor superpowers
grep -F -- 'cdx: invalid selected plugin inventory: superpowers' \
  "$fixture_root/plugin-selected-traversal-version.out" >/dev/null \
  || fail 'traversal plugin version diagnostic differs'

printf '%s\n' '{"installed":[{"pluginId":"hve-core-all@hve-core","name":"hve-core-all","marketplaceName":"hve-core","version":"","installed":true,"enabled":false,"source":{},"marketplaceSource":{}}],"available":[]}' >"$inventory_bad"
: >"$fixture_root/fake-codex.log"
FAKE_CODEX_PLUGIN_OVERRIDE="$inventory_bad" \
  assert_command_fails plugin-wrong-provenance env HOME="$fixture_root/home" \
    PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" setup hve
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null || fail 'wrong plugin provenance caused setup mutation'

# A malformed later inventory prevents an earlier missing marketplace mutation.
rm -f "$fake_state/hve/marketplace"
printf '%s\n' '{"installed":{}}' >"$inventory_bad"
: >"$fixture_root/fake-codex.log"
FAKE_CODEX_PLUGIN_OVERRIDE="$inventory_bad" \
  assert_command_fails preflight-before-mutation env HOME="$fixture_root/home" \
    PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" setup hve
[ ! -e "$fake_state/hve/marketplace" ] || fail 'malformed later inventory added marketplace'
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null || fail 'preflight failure mutated lifecycle state'
: >"$fake_state/hve/marketplace"

# Revalidate the local adapter after native preparation and immediately before
# passing its pathname to Codex. The remaining same-user swap window is bounded
# by Codex accepting a pathname rather than an already-open descriptor.
race_bin="$fixture_root/race-bin"
mkdir "$race_bin"
real_mktemp="$(command -v mktemp)" || fail 'could not resolve real mktemp'
adapter_swap_arm="$fixture_root/adapter-swap.arm"
adapter_race_saved="$fixture_root/adapter-race-saved.json"
cp "$fixture_adapter" "$fixture_root/adapter-race-escape.json"
cat >"$race_bin/mktemp" <<'EOF'
#!/usr/bin/env bash
set -u

created="$($REAL_MKTEMP "$@")" || exit 1
printf '%s\n' "$created"
case "${1:-}" in
  */cdx-native-error.XXXXXX)
    if [ -f "$ADAPTER_SWAP_ARM" ]; then
      rm -f "$ADAPTER_SWAP_ARM"
      mv "$ADAPTER_FILE" "$ADAPTER_RACE_SAVED"
      ln -s "$ADAPTER_RACE_ESCAPE" "$ADAPTER_FILE"
    fi
    ;;
esac
EOF
chmod +x "$race_bin/mktemp"
rm -f "$fake_state/hve/marketplace"
: >"$fixture_root/fake-codex.log"
assert_command_fails adapter-final-revalidation env HOME="$fixture_root/home" \
  PATH="$race_bin:$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_ARM_ADAPTER_SWAP="$adapter_swap_arm" REAL_MKTEMP="$real_mktemp" \
  ADAPTER_SWAP_ARM="$adapter_swap_arm" ADAPTER_FILE="$fixture_adapter" \
  ADAPTER_RACE_SAVED="$adapter_race_saved" \
  ADAPTER_RACE_ESCAPE="$fixture_root/adapter-race-escape.json" \
  "$fixture_launcher" setup hve
jq -se 'all(.[]; .args != ["plugin","marketplace","add",$adapter,"--json"])' \
  --arg adapter "$fake_adapter_root" "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'adapter changed after validation still reached native marketplace add'
[ -f "$adapter_race_saved" ] || fail 'adapter race did not reach final mutation boundary'
rm "$fixture_adapter"
mv "$adapter_race_saved" "$fixture_adapter"
: >"$fake_state/hve/marketplace"

# Repair may replace one selected invalid plugin, but preserves unrelated profile state.
mkdir -p "$hve_home/sessions" "$hve_home/plugins/unrelated"
printf '%s\n' 'session bytes' >"$hve_home/sessions/keep.jsonl"
printf '%s\n' 'unrelated plugin bytes' >"$hve_home/plugins/unrelated/state"
cp "$hve_home/sessions/keep.jsonl" "$fixture_root/session-before-repair"
cp "$hve_home/plugins/unrelated/state" "$fixture_root/plugin-before-repair"
printf '%s\n' '{"installed":[{"pluginId":"hve-core-all@hve-core","name":"hve-core-all","marketplaceName":"hve-core","version":"3.3.100","installed":true,"enabled":false,"source":{"source":"url","url":"https://example.com/wrong.git","ref":"wrong"},"marketplaceSource":{"sourceType":"local","source":"/wrong"},"installPolicy":"AVAILABLE","authPolicy":"ON_INSTALL"}],"available":[]}' >"$inventory_bad"
: >"$fixture_root/fake-codex.log"
env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_PLUGIN_OVERRIDE="$inventory_bad" FAKE_CODEX_PLUGIN_OVERRIDE_ONCE=1 \
  "$fixture_launcher" repair hve >"$fixture_root/repair-wrong-plugin.out" \
  || fail 'repair did not replace wrong selected plugin'
jq -se '
  map(select(.args[1] == "remove" or .args[1] == "add")) | map(.args) == [
    ["plugin","remove","hve-core-all@hve-core","--json"],
    ["plugin","add","hve-core-all@hve-core","--json"]
  ]
' "$fixture_root/fake-codex.log" >/dev/null || fail 'wrong plugin repair mutation order differs'
cmp -s "$fixture_root/session-before-repair" "$hve_home/sessions/keep.jsonl" \
  || fail 'repair changed session bytes'
cmp -s "$fixture_root/plugin-before-repair" "$hve_home/plugins/unrelated/state" \
  || fail 'repair changed unrelated plugin bytes'

# With a valid marketplace revision, missing and invalid selected Git plugins
# are re-added directly. Native plugin add materializes the selected cache;
# marketplace upgrade must not run.
rm -f "$fake_state/superpowers/plugin" \
  "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache"
: >"$fixture_root/fake-codex.log"
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair superpowers \
  >"$fixture_root/repair-missing-superpowers.out" \
  || fail 'repair did not restore and materialize missing Superpowers plugin'
jq -se '
  [ .[] | select(.args[1] == "add" or .args[2] == "upgrade") | .args ] == [
    ["plugin","add","superpowers@superpowers-marketplace","--json"]
  ]
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'revisioned missing Superpowers repair mutation order differs'
[ -f "$superpowers_home/plugins/.fake-installed-superpowers" ] \
  && [ -f "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" ] \
  || fail 'missing Superpowers repair did not materialize selected plugin'

wrong_superpowers_plugin="$fixture_root/wrong-superpowers-plugin.json"
jq -cn '{installed:[{pluginId:"superpowers@superpowers-marketplace",name:"superpowers",marketplaceName:"superpowers-marketplace",version:"0.0.1",installed:true,enabled:false,source:{source:"git",url:"https://example.com/wrong.git"},marketplaceSource:{sourceType:"git",source:"https://github.com/obra/superpowers-marketplace.git"},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}],available:[]}' \
  >"$wrong_superpowers_plugin"
rm -f "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache"
: >"$fixture_root/fake-codex.log"
env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_STATE="$fake_state" FAKE_HVE_ADAPTER_ROOT="$fake_adapter_root" \
  FAKE_CODEX_MARKETPLACE_OVERRIDE="$fixture_root/no-marketplace-override" \
  FAKE_CODEX_PLUGIN_OVERRIDE="$wrong_superpowers_plugin" \
  FAKE_CODEX_PLUGIN_OVERRIDE_ONCE=1 \
  "$fixture_launcher" repair superpowers \
  >"$fixture_root/repair-wrong-superpowers.out" \
  || fail 'repair did not replace and materialize wrong Superpowers plugin'
jq -se '
  [ .[] | select(
      .args[1] == "remove" or .args[1] == "add" or .args[2] == "upgrade"
    ) | .args ] == [
      ["plugin","remove","superpowers@superpowers-marketplace","--json"],
      ["plugin","add","superpowers@superpowers-marketplace","--json"]
    ]
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'revisioned wrong Superpowers repair mutation order differs'
[ -f "$superpowers_home/plugins/.fake-installed-superpowers" ] \
  && [ -f "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" ] \
  || fail 'wrong Superpowers repair did not materialize selected plugin'

# Valid native inventory is not healthy without a valid selected cache.
# Revisioned repair removes and re-adds only the selected plugin.
rm -rf "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0"
mkdir -p "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0"
: >"$fixture_root/fake-codex.log"
assert_command_fails setup-empty-superpowers-cache env \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_STATE="$fake_state" FAKE_HVE_ADAPTER_ROOT="$fake_adapter_root" \
  FAKE_CODEX_MARKETPLACE_OVERRIDE="$fixture_root/no-marketplace-override" \
  "$fixture_launcher" setup superpowers
grep -Fx -- \
  'cdx: selected plugin cache is invalid: superpowers; run: cdx repair superpowers' \
  "$fixture_root/setup-empty-superpowers-cache.out" >/dev/null \
  || fail 'empty selected cache setup diagnostic differs'
if grep -F -- 'superpowers: ready' \
  "$fixture_root/setup-empty-superpowers-cache.out" >/dev/null; then
  fail 'empty selected cache setup reported ready'
fi
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair superpowers \
  >"$fixture_root/repair-empty-superpowers-cache.out" \
  || fail 'repair did not recover empty selected cache'
jq -se '
  [ .[] | select(
      .args[1] == "remove" or .args[1] == "add" or .args[2] == "upgrade"
    ) | .args ] == [
      ["plugin","remove","superpowers@superpowers-marketplace","--json"],
      ["plugin","add","superpowers@superpowers-marketplace","--json"]
    ]
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'empty selected cache repair mutation order differs'
[ -f "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.codex-plugin/plugin.json" ] \
  && [ -f "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/skills/core/SKILL.md" ] \
  || fail 'empty selected cache repair did not rematerialize payload'

rm -rf "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0"
mkdir -p "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0"
printf '%s\n' 'junk must not count as a selected plugin cache' \
  >"$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/junk"
: >"$fixture_root/fake-codex.log"
assert_command_fails setup-junk-superpowers-cache env \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_STATE="$fake_state" FAKE_HVE_ADAPTER_ROOT="$fake_adapter_root" \
  FAKE_CODEX_MARKETPLACE_OVERRIDE="$fixture_root/no-marketplace-override" \
  "$fixture_launcher" setup superpowers
grep -Fx -- \
  'cdx: selected plugin cache is invalid: superpowers; run: cdx repair superpowers' \
  "$fixture_root/setup-junk-superpowers-cache.out" >/dev/null \
  || fail 'junk selected cache setup diagnostic differs'
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair superpowers \
  >"$fixture_root/repair-junk-superpowers-cache.out" \
  || fail 'repair did not recover junk selected cache'
jq -se '
  [ .[] | select(
      .args[1] == "remove" or .args[1] == "add" or .args[2] == "upgrade"
    ) | .args ] == [
      ["plugin","remove","superpowers@superpowers-marketplace","--json"],
      ["plugin","add","superpowers@superpowers-marketplace","--json"]
    ]
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'junk selected cache repair mutation order differs'
[ ! -e "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/junk" ] \
  && [ -f "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.codex-plugin/plugin.json" ] \
  && [ -f "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/skills/core/SKILL.md" ] \
  || fail 'junk selected cache repair did not replace payload'

# A control character inside one JSON skills string must not become multiple
# independently accepted paths after jq serialization.
mkdir -p "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/other"
printf '%s\n' \
  '{"name":"superpowers","version":"6.2.0","skills":"./skills\n./other"}' \
  >"$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.codex-plugin/plugin.json"
: >"$fixture_root/fake-codex.log"
assert_command_fails doctor-control-character-skills env \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_STATE="$fake_state" FAKE_HVE_ADAPTER_ROOT="$fake_adapter_root" \
  FAKE_CODEX_MARKETPLACE_OVERRIDE="$fixture_root/no-marketplace-override" \
  "$fixture_launcher" doctor superpowers
grep -Fx -- \
  'cdx: selected plugin cache is invalid: superpowers; run: cdx repair superpowers' \
  "$fixture_root/doctor-control-character-skills.out" >/dev/null \
  || fail 'control-character skills diagnostic differs'
mkdir -p "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/third"
printf '%s\n' \
  '{"name":"superpowers","version":"6.2.0","skills":["./skills","./other\n./third"]}' \
  >"$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.codex-plugin/plugin.json"
assert_command_fails doctor-control-character-skills-array env \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_STATE="$fake_state" FAKE_HVE_ADAPTER_ROOT="$fake_adapter_root" \
  FAKE_CODEX_MARKETPLACE_OVERRIDE="$fixture_root/no-marketplace-override" \
  "$fixture_launcher" doctor superpowers
grep -Fx -- \
  'cdx: selected plugin cache is invalid: superpowers; run: cdx repair superpowers' \
  "$fixture_root/doctor-control-character-skills-array.out" >/dev/null \
  || fail 'control-character skills array diagnostic differs'
printf '%s\n' \
  '{"name":"superpowers","version":"6.2.0","skills":"./skills"}' \
  >"$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.codex-plugin/plugin.json"
rm -rf "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/other" \
  "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/third"

# Adapter path components must remain regular, non-symlink paths.
mv "$fixture_adapter" "$fixture_root/adapter-saved.json"
ln -s "$fixture_root/adapter-saved.json" "$fixture_adapter"
: >"$fixture_root/fake-codex.log"
assert_command_fails symlink-adapter env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" doctor hve
[ ! -s "$fixture_root/fake-codex.log" ] || fail 'symlink adapter invoked Codex'
rm "$fixture_adapter"
mv "$fixture_root/adapter-saved.json" "$fixture_adapter"

# Check is read-only, fetches only the official manifest, and uses 0/1/2 status.
: >"$fixture_root/fake-codex.log"
: >"$fixture_root/fake-curl.log"

mv "$hve_home/config.toml" "$fixture_root/hve-config-saved.toml"
assert_status 2 update-check-missing-config env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" update --check hve
mv "$fixture_root/hve-config-saved.toml" "$hve_home/config.toml"

printf '%s\n' 'external config' >"$fixture_root/external-config.toml"
mv "$hve_home/config.toml" "$fixture_root/hve-config-saved.toml"
ln -s "$fixture_root/external-config.toml" "$hve_home/config.toml"
assert_status 2 update-check-symlink-config env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" update --check hve
rm "$hve_home/config.toml"
mv "$fixture_root/hve-config-saved.toml" "$hve_home/config.toml"

mv "$hve_home" "$fixture_root/hve-home-saved"
assert_status 2 update-check-missing-home env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" update --check hve
mv "$fixture_root/hve-home-saved" "$hve_home"

mv "$fixture_adapter" "$fixture_root/adapter-saved.json"
ln -s "$fixture_root/adapter-saved.json" "$fixture_adapter"
assert_status 2 update-check-symlink-adapter env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" update --check hve
assert_status 2 update-check-all-operational-dominates env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_SUPERPOWERS_AVAILABLE_VERSION=99.0.0 \
  "$fixture_launcher" update --check --all
rm "$fixture_adapter"
mv "$fixture_root/adapter-saved.json" "$fixture_adapter"

: >"$fixture_root/fake-curl.log"
write_isolation_snapshot update-check-ordinary
assert_status 0 update-check-current env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_SUCCESS_STDERR='successful native stderr must stay private' \
  "$fixture_launcher" update --check hve
assert_isolation_snapshot_unchanged update-check-ordinary
if grep -F -- 'successful native stderr must stay private' \
  "$fixture_root/update-check-current.out" >/dev/null; then
  fail 'successful native stderr leaked through cdx'
fi
[ "$(cat "$fixture_root/fake-curl.log")" = '-fsSL https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json' ] \
  || fail 'update check fetched a non-official URL'
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null || fail 'update check mutated native state'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'update --check created host authentication'
auth_is_absent "$hve_home/auth.json" \
  || fail 'update --check created profile authentication'

: >"$fixture_root/fake-curl.log"
write_isolation_snapshot update-check-all-ordinary
assert_status 0 update-check-all-current env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" update --check --all
assert_isolation_snapshot_unchanged update-check-all-ordinary
cmp -s "$fixture_root/fake-curl.log" <(printf '%s\n' \
  '-fsSL https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json' \
  '-fsSL https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json') \
  || fail 'update check --all order differs'
assert_status 1 update-check-all-available env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_HVE_AVAILABLE_VERSION=99.0.0 \
  "$fixture_launcher" update --check --all

printf '%s\n' '{"plugins":[{"name":"hve-core-all","version":"99.0.0"}]}' >"$fixture_root/manifest-new.json"
FAKE_CURL_OVERRIDE="$fixture_root/manifest-new.json" \
  assert_status 1 update-check-available env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" update --check hve
printf '%s\n%s\n' '{"plugins":[]}' '{"plugins":[]}' >"$fixture_root/manifest-bad.json"
FAKE_CURL_OVERRIDE="$fixture_root/manifest-bad.json" \
  assert_status 2 update-check-malformed env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" update --check hve

# Explicit update operations are profile-scoped and ordered.
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot update-hve-ordinary
HOME="$fixture_root/home" fake_env "$fixture_launcher" update hve \
  >"$fixture_root/update-hve.out" || fail 'update hve failed'
write_isolation_snapshot update-hve-ordinary-after
grep -Fv $'hve.config\t' "$fixture_root/update-hve-ordinary.state-before" \
  >"$fixture_root/update-hve-ordinary.filtered-before"
grep -Fv $'hve.config\t' "$fixture_root/update-hve-ordinary-after.state-before" \
  >"$fixture_root/update-hve-ordinary.filtered-after"
cmp -s "$fixture_root/update-hve-ordinary.filtered-before" \
  "$fixture_root/update-hve-ordinary.filtered-after" \
  || fail 'HVE update changed session, MCP, plugin, or other-profile state'
[ "$(grep -Fxc '[plugins."hve-core-all@hve-core"]' \
  "$hve_home/config.toml")" -eq 1 ] \
  || fail 'HVE update did not re-add exactly one selected native plugin table'
grep -F -A1 -- '[plugins."unrelated@user-owned"]' "$hve_home/config.toml" \
  | grep -F -- 'enabled = false' >/dev/null \
  || fail 'HVE update changed unrelated native plugin state'
jq -se '
  map(select(.args[1] == "remove" or .args[1] == "add")) | map(.args) == [
    ["plugin","remove","hve-core-all@hve-core","--json"],
    ["plugin","add","hve-core-all@hve-core","--json"]
  ]
' "$fixture_root/fake-codex.log" >/dev/null || fail 'hve update mutation order differs'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'update created host authentication'
auth_is_absent "$hve_home/auth.json" || fail 'update created profile authentication'

: >"$fixture_root/fake-codex.log"
write_isolation_snapshot update-superpowers-ordinary
HOME="$fixture_root/home" fake_env "$fixture_launcher" update superpowers \
  >"$fixture_root/update-superpowers.out" || fail 'update superpowers failed'
write_isolation_snapshot update-superpowers-ordinary-after
grep -Fv -e $'superpowers.config\t' -e $'superpowers.plugin-cache\t' \
  -e $'superpowers.plugin-metadata\t' \
  "$fixture_root/update-superpowers-ordinary.state-before" \
  >"$fixture_root/update-superpowers-ordinary.filtered-before"
grep -Fv -e $'superpowers.config\t' -e $'superpowers.plugin-cache\t' \
  -e $'superpowers.plugin-metadata\t' \
  "$fixture_root/update-superpowers-ordinary-after.state-before" \
  >"$fixture_root/update-superpowers-ordinary.filtered-after"
cmp -s "$fixture_root/update-superpowers-ordinary.filtered-before" \
  "$fixture_root/update-superpowers-ordinary.filtered-after" \
  || fail 'Superpowers update changed session, MCP, plugin, or other-profile state'
grep -Fx -- 'upgrade marketplace-upgrade selected plugin cache materialized' \
  "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" \
  >/dev/null || fail 'Superpowers update did not rematerialize installed plugin cache'
grep -Fx -- 'upgrade selected plugin install metadata' \
  "$superpowers_home/plugins/.fake-installed-superpowers" >/dev/null \
  || fail 'Superpowers update did not rematerialize installed plugin metadata'
[ "$(grep -Fxc \
  'last_revision = "0123456789abcdef0123456789abcdef01234567"' \
  "$superpowers_home/config.toml")" -eq 1 ] \
  || fail 'Superpowers update did not preserve exactly one native revision'
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor superpowers \
  >"$fixture_root/doctor-superpowers-after-update.out" \
  || fail 'doctor rejected upgraded Superpowers native state'
HOME="$fixture_root/home" fake_env "$fixture_launcher" setup superpowers \
  >"$fixture_root/setup-superpowers-after-update.out" \
  || fail 'repeated setup rejected upgraded Superpowers native state'
[ "$(grep -Fxc \
  'last_revision = "0123456789abcdef0123456789abcdef01234567"' \
  "$superpowers_home/config.toml")" -eq 1 ] \
  || fail 'repeated Superpowers operations changed native revision state'
jq -se '
  map(select(.args[2] == "upgrade")) | map(.args) == [
    ["plugin","marketplace","upgrade","superpowers-marketplace","--json"]
  ]
' "$fixture_root/fake-codex.log" >/dev/null || fail 'superpowers update mutation differs'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'update created host authentication'
auth_is_absent "$superpowers_home/auth.json" \
  || fail 'update created profile authentication'

# A Git marketplace update is marketplace-wide. Refuse it when an unrelated
# plugin from that marketplace is installed, before any native mutation.
: >"$fake_state/superpowers/unrelated-same-marketplace"
mkdir -p "$superpowers_home/plugins/cache/superpowers-marketplace/unrelated/1.0.0"
printf '%s\n' 'update unrelated cache bytes must stay exact' \
  >"$superpowers_home/plugins/cache/superpowers-marketplace/unrelated/1.0.0/.fake-materialized-cache"
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot update-superpowers-unrelated-block
assert_command_fails update-superpowers-unrelated-block env \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" update superpowers
grep -Fx -- \
  'cdx: cannot upgrade selected Git marketplace with unrelated installed plugins: superpowers' \
  "$fixture_root/update-superpowers-unrelated-block.out" >/dev/null \
  || fail 'unrelated same-marketplace update diagnostic differs'
assert_isolation_snapshot_unchanged update-superpowers-unrelated-block
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'unrelated same-marketplace update mutated lifecycle state'
rm -f "$fake_state/superpowers/unrelated-same-marketplace"

# Failed HVE reinstall leaves a diagnosable missing plugin; repair restores only it.
FAKE_CODEX_FAIL_MUTATION=plugin-add \
  assert_status 2 update-hve-failed env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" update hve
grep -F -- 'native plugin add failed: simulated Codex diagnostic' \
  "$fixture_root/update-hve-failed.out" >/dev/null \
  || fail 'failed HVE reinstall hid native Codex stderr'
[ ! -e "$fake_state/hve/plugin" ] || fail 'failed HVE reinstall did not leave plugin missing'
assert_status 1 update-check-missing-plugin env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" update --check hve
assert_command_fails doctor-missing-after-update env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" doctor hve
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair hve \
  >"$fixture_root/repair-after-update.out" || fail 'repair after failed update failed'
[ -e "$fake_state/hve/plugin" ] || fail 'repair did not restore missing HVE plugin'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'repair created host authentication'
auth_is_absent "$hve_home/auth.json" || fail 'repair created profile authentication'

# Native authentication is launch-only: host login is checked first, only the
# selected profile auth is refreshed, and no proxy fallback is attempted.
rm -f "$fixture_root/home/.codex/auth.json" "$hve_home/auth.json"
native_config_hash="$(state_file_hash "$hve_home/config.toml")"
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot native-login-unavailable
assert_command_fails native-login-unavailable env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=1 "$fixture_launcher" --native-auth hve --version
assert_isolation_snapshot_unchanged native-login-unavailable
auth_is_absent "$hve_home/auth.json" \
  || fail 'unavailable native login created profile authentication'
[ "$(state_file_hash "$hve_home/config.toml")" = "$native_config_hash" ] \
  || fail 'unavailable native login changed managed config'
jq -se --arg host "$fixture_root/home/.codex" '
  length == 1
  and .[0].codexHome == $host
  and .[0].args == ["login","status"]
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'unavailable native login invoked a launch or proxy fallback'

: >"$fixture_root/fake-codex.log"
write_isolation_snapshot native-source-missing
assert_command_fails native-source-missing env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 "$fixture_launcher" --native-auth hve --version
assert_isolation_snapshot_unchanged native-source-missing
grep -F -- 'hve' "$fixture_root/native-source-missing.out" >/dev/null \
  || fail 'missing native auth diagnostic omitted selected profile'
auth_is_absent "$hve_home/auth.json" \
  || fail 'missing native auth source created profile authentication'
jq -se 'length == 1 and .[0].args == ["login","status"]' \
  "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'missing native auth source invoked a launch or proxy fallback'

printf '%s\n' '{"tokens":{"access_token":"native-v1","refresh_token":"native-refresh-v1"}}' \
  >"$fixture_root/home/.codex/auth.json"
chmod 0600 "$fixture_root/home/.codex/auth.json"

# Malformed host auth is rejected by native login status; cdx does not parse it.
printf '%s\n' '{malformed-host-auth' >"$fixture_root/home/.codex/auth.json"
printf '%s\n' '{"tokens":{"access_token":"profile-before-malformed-login"}}' \
  >"$hve_home/auth.json"
chmod 0640 "$hve_home/auth.json"
malformed_target_hash="$(state_file_hash "$hve_home/auth.json")"
malformed_target_inode="$(file_inode "$hve_home/auth.json")"
malformed_target_mode="$(file_mode "$hve_home/auth.json")"
malformed_config_hash="$(state_file_hash "$hve_home/config.toml")"
: >"$fixture_root/fake-codex.log"
assert_command_fails native-malformed-host-auth env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=1 "$fixture_launcher" --native-auth hve --version
grep -F -- 'hve' "$fixture_root/native-malformed-host-auth.out" >/dev/null \
  || fail 'malformed host auth diagnostic omitted selected profile'
[ "$(state_file_hash "$hve_home/auth.json")" = "$malformed_target_hash" ] \
  || fail 'malformed host auth changed profile authentication bytes'
[ "$(file_inode "$hve_home/auth.json")" = "$malformed_target_inode" ] \
  || fail 'malformed host auth replaced profile authentication'
[ "$(file_mode "$hve_home/auth.json")" = "$malformed_target_mode" ] \
  || fail 'malformed host auth changed profile authentication mode'
[ "$(state_file_hash "$hve_home/config.toml")" = "$malformed_config_hash" ] \
  || fail 'malformed host auth changed managed config'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'malformed host auth left authentication staging debris'
jq -se '
  length == 1
  and .[0].args == ["login","status"]
  and (map(select(.args[0] == "--sandbox")) | length) == 0
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'malformed host auth invoked a native launch or proxy fallback'
printf '%s\n' '{"tokens":{"access_token":"native-v1","refresh_token":"native-refresh-v1"}}' \
  >"$fixture_root/home/.codex/auth.json"
rm "$hve_home/auth.json"
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot native-launch-success
(cd "$original_cwd" && \
  HOME="$fixture_root/home" FAKE_CODEX_LOGIN_STATUS=0 \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_APPEND_PROJECT_TRUST_TWICE=1 \
  fake_env "$fixture_launcher" --native-auth hve \
    -m gpt-5.5 exec --json 'hello world') \
  || fail 'native-auth launch failed'
assert_isolation_snapshot_unchanged native-launch-success
jq -se --arg host "$fixture_root/home/.codex" --arg profile "$hve_home" \
  --arg home "$fixture_root/home" --arg cwd "$original_cwd" \
  --arg trustPath "$(CDPATH= cd -P -- "$original_cwd" && pwd)" "
$(strip_project_trust_c_jq)
  length == 3
  and .[0] == {
    codexHome: \$host,
    home: \$home,
    cwd: \$cwd,
    args: [\"login\",\"status\"]
  }
  and .[1] == {
    codexHome: \$profile,
    home: \$home,
    cwd: \$cwd,
    args: [\"plugin\",\"list\",\"--json\"]
  }
  and .[2].codexHome == \$profile
  and .[2].home == \$home
  and .[2].cwd == \$cwd
  and (.[2].args | strip_project_trust_c) == [
    \"--sandbox\", \"workspace-write\", \"-c\", \"sandbox_workspace_write.network_access=true\",
    \"--ask-for-approval\", \"never\", \"--disable\", \"default_mode_request_user_input\",
    \"--dangerously-bypass-hook-trust\",
    \"-c\", \"model_provider=\\\"openai\\\"\",
    \"-m\", \"gpt-5.5\", \"exec\", \"--json\", \"hello world\"
  ]
  and any(.[2].args[]; is_project_trust_override and contains(\$trustPath))
" "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'native-auth login, routing, environment, or forwarded arguments differ'
cmp -s "$fixture_root/home/.codex/auth.json" "$hve_home/auth.json" \
  || fail 'native-auth launch did not copy exact host authentication'
[ "$(file_mode "$hve_home/auth.json")" = '600' ] \
  || fail 'native-auth profile authentication mode is not 0600'
[ "$(state_file_hash "$hve_home/config.toml")" = "$native_config_hash" ] \
  || fail 'native-auth launch persisted provider selection'
auth_is_absent "$superpowers_home/auth.json" \
  || fail 'native-auth launch changed another profile authentication'

assert_early_status 41 native-launch-child-status env \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_CODEX_LOGIN_STATUS=0 \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_EXIT_STATUS=41 \
  "$fixture_launcher" --native-auth hve --version
[ "$(state_file_hash "$hve_home/config.toml")" = "$native_config_hash" ] \
  || fail 'failed native child did not restore exact prelaunch config bytes'

native_tree_cp="$real_cp"
cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_TREE_REAL_CP" "$@" || exit $?
case "${2:-}" in
  */.config-snapshot.*)
    if [ -f "$CDX_TEST_TREE_DIR/child-signaled" ] \
      && [ ! -f "$CDX_TEST_TREE_DIR/cleanup-ready" ]; then
      : >"$CDX_TEST_TREE_DIR/cleanup-ready"
      while [ ! -f "$CDX_TEST_TREE_DIR/release-cleanup" ]; do
        sleep 0.05
      done
    fi
    ;;
esac
EOF
chmod +x "$fake_bin/cp"
for native_tree_case in HUP:129 INT:130 TERM:143; do
  native_tree_signal="${native_tree_case%%:*}"
  native_tree_expected_status="${native_tree_case#*:}"
  native_tree_dir="$fixture_root/native-process-tree-$native_tree_signal"
  native_tree_output="$fixture_root/native-process-tree-$native_tree_signal.out"
  mkdir "$native_tree_dir"
  set -m
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_CODEX_LOGIN_STATUS=0 \
    FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_TREE_DIR="$native_tree_dir" \
    CDX_TEST_TREE_REAL_CP="$native_tree_cp" CDX_TEST_TREE_DIR="$native_tree_dir" \
    "$fixture_launcher" --native-auth hve --version \
    >"$native_tree_output" 2>&1 &
  native_tree_launcher_pid=$!
  track_async_pid "$native_tree_launcher_pid"
  set +m
  native_tree_wait=0
  while [ ! -f "$native_tree_dir/ready" ] \
    && kill -0 "$native_tree_launcher_pid" 2>/dev/null \
    && [ "$native_tree_wait" -lt 400 ]; do
    sleep 0.05
    native_tree_wait=$((native_tree_wait + 1))
  done
  [ -f "$native_tree_dir/ready" ] \
    || {
      cat "$native_tree_output" >&2 || :
      fail "$native_tree_signal native process tree did not start"
    }
  native_tree_grandchild_pid="$(cat "$native_tree_dir/grandchild.pid")"
  native_tree_group="$(cat "$native_tree_dir/child.pid")"
  track_async_group "$native_tree_group"
  kill -s "$native_tree_signal" "$native_tree_launcher_pid" \
    || fail "could not send $native_tree_signal to native launcher"
  native_tree_wait=0
  while [ ! -f "$native_tree_dir/cleanup-ready" ] \
    && [ "$native_tree_wait" -lt 200 ]; do
    sleep 0.05
    native_tree_wait=$((native_tree_wait + 1))
  done
  [ -f "$native_tree_dir/cleanup-ready" ] \
    || {
      cat "$native_tree_output" >&2 || :
      native_tree_child_pid="$(cat "$native_tree_dir/child.pid")"
      kill -KILL -- "-$native_tree_child_pid" 2>/dev/null || :
      kill -KILL "$native_tree_launcher_pid" 2>/dev/null || :
      wait "$native_tree_launcher_pid" 2>/dev/null || :
      fail "$native_tree_signal native launcher did not enter bounded cleanup"
    }
  kill -s "$native_tree_signal" "$native_tree_launcher_pid" \
    || fail "could not repeat $native_tree_signal during native cleanup"
  : >"$native_tree_dir/release-cleanup"
  native_tree_status=0
  wait "$native_tree_launcher_pid" || native_tree_status=$?
  [ "$native_tree_status" -eq "$native_tree_expected_status" ] \
    || fail "$native_tree_signal native process-tree exit was $native_tree_status, expected $native_tree_expected_status"
  [ -f "$native_tree_dir/child-signaled" ] \
    || fail "$native_tree_signal did not reach native direct child"
  native_tree_wait=0
  while { [ ! -f "$native_tree_dir/grandchild-signaled" ] \
    || kill -0 "$native_tree_grandchild_pid" 2>/dev/null; } \
    && [ "$native_tree_wait" -lt 100 ]; do
    sleep 0.05
    native_tree_wait=$((native_tree_wait + 1))
  done
  [ -f "$native_tree_dir/grandchild-signaled" ] \
    || fail "$native_tree_signal did not reach native grandchild"
  if kill -0 "$native_tree_grandchild_pid" 2>/dev/null; then
    fail "$native_tree_signal left native grandchild running"
  fi
  [ "$(state_file_hash "$hve_home/config.toml")" = "$native_config_hash" ] \
    || fail "$native_tree_signal bypassed exact native config cleanup"
  [ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
    || fail "$native_tree_signal left native profile launch lock"
  untrack_async_pid "$native_tree_launcher_pid"
  untrack_async_group "$native_tree_group"
done
rm "$fake_bin/cp"

# Identical content preserves the destination inode while enforcing mode 0600.
auth_inode="$(file_inode "$hve_home/auth.json")"
chmod 0400 "$hve_home/auth.json"
: >"$fixture_root/fake-codex.log"
HOME="$fixture_root/home" FAKE_CODEX_LOGIN_STATUS=0 \
  fake_env "$fixture_launcher" --native-auth hve --version \
  || fail 'identical native-auth launch failed'
[ "$(file_inode "$hve_home/auth.json")" = "$auth_inode" ] \
  || fail 'identical native auth refresh replaced destination inode'
cmp -s "$fixture_root/home/.codex/auth.json" "$hve_home/auth.json" \
  || fail 'identical native auth refresh changed destination content'
[ "$(file_mode "$hve_home/auth.json")" = '600' ] \
  || fail 'identical native auth refresh did not enforce 0600'

# Owner-readable mode 0400 is a valid safe source.
chmod 0400 "$fixture_root/home/.codex/auth.json"
HOME="$fixture_root/home" FAKE_CODEX_LOGIN_STATUS=0 \
  fake_env "$fixture_launcher" --native-auth hve --version \
  || fail 'owner-readable native auth source launch failed'
cmp -s "$fixture_root/home/.codex/auth.json" "$hve_home/auth.json" \
  || fail 'owner-readable native auth source was not copied exactly'
chmod 0600 "$fixture_root/home/.codex/auth.json"

assert_native_refresh_failure() {
  local label="$1" prior_hash prior_inode prior_mode
  shift
  prior_hash="$(state_file_hash "$hve_home/auth.json")"
  prior_inode="$(file_inode "$hve_home/auth.json")"
  prior_mode="$(file_mode "$hve_home/auth.json")"
  : >"$fixture_root/fake-codex.log"
  write_isolation_snapshot "$label"
  assert_command_fails "$label" "$@"
  native_refresh_failure_status="$asserted_failure_status"
  grep -F -- 'hve' "$fixture_root/$label.out" >/dev/null \
    || fail "$label diagnostic omitted selected profile"
  if grep '^cdx:' "$fixture_root/$label.out" | grep -Fv -- 'hve' >/dev/null; then
    fail "$label emitted a native refresh diagnostic without selected profile"
  fi
  assert_isolation_snapshot_unchanged "$label"
  [ "$(state_file_hash "$hve_home/auth.json")" = "$prior_hash" ] \
    || fail "$label changed destination authentication bytes"
  [ "$(file_inode "$hve_home/auth.json")" = "$prior_inode" ] \
    || fail "$label changed destination authentication inode"
  [ "$(file_mode "$hve_home/auth.json")" = "$prior_mode" ] \
    || fail "$label changed destination authentication mode"
  [ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
    || fail "$label left authentication staging debris"
  jq -se '
    map(select(.args[0] == "--sandbox")) | length == 0
  ' "$fixture_root/fake-codex.log" >/dev/null \
    || fail "$label invoked a native launch or proxy fallback"
}

mv "$fixture_root/home/.codex/auth.json" "$fixture_root/native-auth-source.saved"
assert_native_refresh_failure native-source-absent env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 "$fixture_launcher" --native-auth hve --version
mv "$fixture_root/native-auth-source.saved" "$fixture_root/home/.codex/auth.json"

chmod 0000 "$fixture_root/home/.codex/auth.json"
assert_native_refresh_failure native-source-unreadable env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 "$fixture_launcher" --native-auth hve --version
chmod 0600 "$fixture_root/home/.codex/auth.json"

mv "$fixture_root/home/.codex/auth.json" "$fixture_root/native-auth-source.saved"
ln -s "$fixture_root/native-auth-source.saved" "$fixture_root/home/.codex/auth.json"
assert_native_refresh_failure native-source-symlink env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 "$fixture_launcher" --native-auth hve --version
rm "$fixture_root/home/.codex/auth.json"
mv "$fixture_root/native-auth-source.saved" "$fixture_root/home/.codex/auth.json"

mv "$fixture_root/home/.codex/auth.json" "$fixture_root/native-auth-source.saved"
mkdir "$fixture_root/home/.codex/auth.json"
assert_native_refresh_failure native-source-nonregular env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 "$fixture_launcher" --native-auth hve --version
rmdir "$fixture_root/home/.codex/auth.json"
mv "$fixture_root/native-auth-source.saved" "$fixture_root/home/.codex/auth.json"

mv "$hve_home/auth.json" "$fixture_root/native-auth-target.saved"
ln -s "$fixture_root/native-auth-target.saved" "$hve_home/auth.json"
assert_native_refresh_failure native-target-symlink env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 "$fixture_launcher" --native-auth hve --version
rm "$hve_home/auth.json"
mv "$fixture_root/native-auth-target.saved" "$hve_home/auth.json"

mv "$hve_home/auth.json" "$fixture_root/native-auth-target.saved"
mkdir "$hve_home/auth.json"
target_saved_hash="$(state_file_hash "$fixture_root/native-auth-target.saved")"
: >"$fixture_root/fake-codex.log"
assert_command_fails native-target-nonregular env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 "$fixture_launcher" --native-auth hve --version
grep -F -- 'hve' "$fixture_root/native-target-nonregular.out" >/dev/null \
  || fail 'nonregular destination diagnostic omitted selected profile'
[ "$(state_file_hash "$fixture_root/native-auth-target.saved")" = "$target_saved_hash" ] \
  || fail 'nonregular destination changed saved authentication'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'nonregular destination left authentication staging debris'
rmdir "$hve_home/auth.json"
mv "$fixture_root/native-auth-target.saved" "$hve_home/auth.json"

printf '%s\n' '{"tokens":{"access_token":"native-v2","refresh_token":"native-refresh-v2"}}' \
  >"$fixture_root/home/.codex/auth.json"
chmod 0640 "$hve_home/auth.json"
real_cp="$(command -v cp)"
real_mv="$(command -v mv)"
real_ln="$(command -v ln)"
real_mktemp="$(command -v mktemp)"
real_chmod="$(command -v chmod)"
real_rm="$(command -v rm)"

cat >"$fake_bin/chmod" <<'EOF'
#!/usr/bin/env bash
case "${2:-}" in
  "$CDX_TEST_AUTH_TARGET") exit 70 ;;
esac
exec "$CDX_TEST_REAL_CHMOD" "$@"
EOF
"$real_chmod" +x "$fake_bin/chmod"
cp "$hve_home/auth.json" "$fixture_root/home/.codex/auth.json"
assert_native_refresh_failure native-existing-auth-chmod-failure \
  env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_CODEX_LOGIN_STATUS=0 \
  CDX_TEST_AUTH_TARGET="$hve_home/auth.json" CDX_TEST_REAL_CHMOD="$real_chmod" \
  "$fixture_launcher" --native-auth hve --version
rm "$fake_bin/chmod"
printf '%s\n' '{"tokens":{"access_token":"native-v2","refresh_token":"native-refresh-v2"}}' \
  >"$fixture_root/home/.codex/auth.json"

cat >"$fake_bin/chmod" <<'EOF'
#!/usr/bin/env bash
case "${2:-}" in
  */.auth.*) exit 71 ;;
esac
exec "$CDX_TEST_REAL_CHMOD" "$@"
EOF
"$real_chmod" +x "$fake_bin/chmod"
assert_native_refresh_failure native-staged-auth-chmod-failure \
  env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_CODEX_LOGIN_STATUS=0 \
  CDX_TEST_REAL_CHMOD="$real_chmod" \
  "$fixture_launcher" --native-auth hve --version
rm "$fake_bin/chmod"

cat >"$fake_bin/mktemp" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  */.auth.XXXXXX) exit 72 ;;
esac
exec "$CDX_TEST_REAL_MKTEMP" "$@"
EOF
chmod +x "$fake_bin/mktemp"
assert_native_refresh_failure native-staging-failure env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 CDX_TEST_REAL_MKTEMP="$real_mktemp" \
  "$fixture_launcher" --native-auth hve --version
rm "$fake_bin/mktemp"

cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
case "${2:-}" in
  */.auth.*) exit 73 ;;
esac
exec "$CDX_TEST_REAL_CP" "$@"
EOF
chmod +x "$fake_bin/cp"
assert_native_refresh_failure native-copy-failure env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 CDX_TEST_REAL_CP="$real_cp" \
  "$fixture_launcher" --native-auth hve --version
rm "$fake_bin/cp"

cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
case "${2:-}" in */.auth.*) exit 75 ;; esac
exec "$CDX_TEST_REAL_CP" "$@"
EOF
cat >"$fake_bin/rm" <<'EOF'
#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in */.auth.*) exit 76 ;; esac
done
exec "$CDX_TEST_REAL_RM" "$@"
EOF
chmod +x "$fake_bin/cp" "$fake_bin/rm"
: >"$fixture_root/fake-codex.log"
cleanup_prior_hash="$(state_file_hash "$hve_home/auth.json")"
cleanup_prior_inode="$(file_inode "$hve_home/auth.json")"
cleanup_prior_mode="$(file_mode "$hve_home/auth.json")"
assert_command_fails native-cleanup-failure env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 CDX_TEST_REAL_CP="$real_cp" \
  CDX_TEST_REAL_RM="$real_rm" "$fixture_launcher" --native-auth hve --version
grep -F -- 'hve' "$fixture_root/native-cleanup-failure.out" >/dev/null \
  || fail 'cleanup failure diagnostic omitted selected profile'
if grep '^cdx:' "$fixture_root/native-cleanup-failure.out" \
  | grep -Fv -- 'hve' >/dev/null; then
  fail 'cleanup failure emitted a native refresh diagnostic without selected profile'
fi
[ "$(state_file_hash "$hve_home/auth.json")" = "$cleanup_prior_hash" ] \
  || fail 'cleanup failure changed destination authentication bytes'
[ "$(file_inode "$hve_home/auth.json")" = "$cleanup_prior_inode" ] \
  || fail 'cleanup failure changed destination authentication inode'
[ "$(file_mode "$hve_home/auth.json")" = "$cleanup_prior_mode" ] \
  || fail 'cleanup failure changed destination authentication mode'
stale_auth_stage="$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)"
[ -n "$stale_auth_stage" ] || fail 'cleanup failure did not retain failed staging target'
"$real_rm" -f -- "$stale_auth_stage" "$fake_bin/cp" "$fake_bin/rm"

cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CP" "$@" || exit $?
case "${2:-}" in */.auth.*) "$CDX_TEST_REAL_RM" "$CDX_TEST_AUTH_SOURCE" ;; esac
EOF
chmod +x "$fake_bin/cp"
assert_native_refresh_failure native-source-removed-during-copy \
  env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_CODEX_LOGIN_STATUS=0 \
  CDX_TEST_REAL_CP="$real_cp" CDX_TEST_REAL_RM="$real_rm" \
  CDX_TEST_AUTH_SOURCE="$fixture_root/home/.codex/auth.json" \
  "$fixture_launcher" --native-auth hve --version
rm "$fake_bin/cp"
printf '%s\n' '{"tokens":{"access_token":"native-v2","refresh_token":"native-refresh-v2"}}' \
  >"$fixture_root/home/.codex/auth.json"

cat >"$fake_bin/mv" <<'EOF'
#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in */.auth.*) exit 74 ;; esac
done
exec "$CDX_TEST_REAL_MV" "$@"
EOF
chmod +x "$fake_bin/mv"
assert_native_refresh_failure native-publication-failure env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 CDX_TEST_REAL_MV="$real_mv" \
  "$fixture_launcher" --native-auth hve --version
rm "$fake_bin/mv"

cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CP" "$@" || exit $?
case "${2:-}" in */.auth.*) kill -s "$CDX_TEST_SIGNAL" "$PPID" ;; esac
EOF
chmod +x "$fake_bin/cp"
for native_signal in HUP INT TERM; do
  case "$native_signal" in
    HUP) expected_signal_status=129 ;;
    INT) expected_signal_status=130 ;;
    TERM) expected_signal_status=143 ;;
  esac
  assert_native_refresh_failure "native-stage-signal-$native_signal" \
    env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    FAKE_CODEX_LOGIN_STATUS=0 CDX_TEST_REAL_CP="$real_cp" \
    CDX_TEST_SIGNAL="$native_signal" \
    "$fixture_launcher" --native-auth hve --version
  [ "$native_refresh_failure_status" -eq "$expected_signal_status" ] \
    || fail "native-stage-signal-$native_signal exit was $native_refresh_failure_status, expected $expected_signal_status"
  grep -F -- "native authentication refresh interrupted for profile hve: $native_signal" \
    "$fixture_root/native-stage-signal-$native_signal.out" >/dev/null \
    || fail "native-stage-signal-$native_signal diagnostic differs"
done
rm "$fake_bin/cp"

cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CP" "$@" || exit $?
case "${2:-}" in
  */.auth.*) printf '%s\n' '{"tokens":{"access_token":"changed-during-copy"}}' >"$CDX_TEST_AUTH_SOURCE" ;;
esac
EOF
chmod +x "$fake_bin/cp"
assert_native_refresh_failure native-source-changed-during-copy env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 CDX_TEST_REAL_CP="$real_cp" \
  CDX_TEST_AUTH_SOURCE="$fixture_root/home/.codex/auth.json" \
  "$fixture_launcher" --native-auth hve --version
rm "$fake_bin/cp"
printf '%s\n' '{"tokens":{"access_token":"native-v2","refresh_token":"native-refresh-v2"}}' \
  >"$fixture_root/home/.codex/auth.json"

outside_auth="$fixture_root/outside-native-auth"
: >"$outside_auth"
cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CP" "$@" || exit $?
case "${2:-}" in
  */.auth.*)
    "$CDX_TEST_REAL_MV" "$CDX_TEST_AUTH_TARGET" "$CDX_TEST_AUTH_SAVED" || exit $?
    "$CDX_TEST_REAL_LN" -s "$CDX_TEST_AUTH_OUTSIDE" "$CDX_TEST_AUTH_TARGET" || exit $?
    ;;
esac
EOF
chmod +x "$fake_bin/cp"
native_target_hash="$(state_file_hash "$hve_home/auth.json")"
native_target_inode="$(file_inode "$hve_home/auth.json")"
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot native-target-changed-during-copy
assert_command_fails native-target-changed-during-copy env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_LOGIN_STATUS=0 CDX_TEST_REAL_CP="$real_cp" \
  CDX_TEST_REAL_MV="$real_mv" CDX_TEST_REAL_LN="$real_ln" \
  CDX_TEST_AUTH_TARGET="$hve_home/auth.json" \
  CDX_TEST_AUTH_SAVED="$fixture_root/native-auth-post-stage.saved" \
  CDX_TEST_AUTH_OUTSIDE="$outside_auth" \
  "$fixture_launcher" --native-auth hve --version
grep -F -- 'hve' "$fixture_root/native-target-changed-during-copy.out" >/dev/null \
  || fail 'destination safety diagnostic omitted selected profile'
assert_isolation_snapshot_unchanged native-target-changed-during-copy
[ "$(state_file_hash "$fixture_root/native-auth-post-stage.saved")" = "$native_target_hash" ] \
  || fail 'destination safety failure changed prior authentication bytes'
[ "$(file_inode "$fixture_root/native-auth-post-stage.saved")" = "$native_target_inode" ] \
  || fail 'destination safety failure replaced prior authentication inode'
[ "$(file_mode "$fixture_root/native-auth-post-stage.saved")" = '640' ] \
  || fail 'destination safety failure changed prior authentication mode'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'destination safety failure left authentication staging debris'
jq -se '
  map(select(.args[0] == "--sandbox")) | length == 0
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'destination safety failure invoked a native launch or proxy fallback'
rm "$fake_bin/cp" "$hve_home/auth.json"
mv "$fixture_root/native-auth-post-stage.saved" "$hve_home/auth.json"

# A successful differing-content publication replaces the file atomically at 0600.
printf '%s\n' '{"tokens":{"access_token":"native-v3","refresh_token":"native-refresh-v3"}}' \
  >"$fixture_root/home/.codex/auth.json"
HOME="$fixture_root/home" FAKE_CODEX_LOGIN_STATUS=0 \
  fake_env "$fixture_launcher" --native-auth hve --version \
  || fail 'differing native auth publication failed'
cmp -s "$fixture_root/home/.codex/auth.json" "$hve_home/auth.json" \
  || fail 'successful native auth publication changed copied bytes'
[ "$(file_mode "$hve_home/auth.json")" = '600' ] \
  || fail 'successful native auth publication mode is not 0600'

# Final ordinary launch stays proxy-routed even when native auth exists.
profile_auth_hash="$(shasum -a 256 "$hve_home/auth.json" | awk '{print $1}')"
profile_auth_inode="$(file_inode "$hve_home/auth.json")"
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot launch-preserved-auth-ordinary
HOME="$fixture_root/home" fake_env "$fixture_launcher" hve --version \
  || fail 'launch with preserved profile authentication failed'
assert_isolation_snapshot_unchanged launch-preserved-auth-ordinary
jq -se --arg trustPath "$(CDPATH= cd -P -- . && pwd)" "
$(strip_project_trust_c_jq)
  length == 2
  and .[0].args == [\"plugin\",\"list\",\"--json\"]
  and (.[1].args | strip_project_trust_c) == [
    \"--sandbox\", \"workspace-write\", \"-c\", \"sandbox_workspace_write.network_access=true\",
    \"--ask-for-approval\", \"never\", \"--disable\", \"default_mode_request_user_input\",
    \"--dangerously-bypass-hook-trust\", \"--version\"
  ]
  and any(.[1].args[]; is_project_trust_override and contains(\$trustPath))
" "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'launch with preserved authentication injected a provider override'
[ "$(shasum -a 256 "$hve_home/auth.json" | awk '{print $1}')" = "$profile_auth_hash" ] \
  || fail 'default launch changed profile authentication bytes'
[ "$(file_inode "$hve_home/auth.json")" = "$profile_auth_inode" ] \
  || fail 'default launch replaced profile authentication'
[ "$(file_mode "$hve_home/auth.json")" = '600' ] \
  || fail 'default launch changed profile authentication mode'

printf 'trellage Codex lifecycle contract: PASS\n'
