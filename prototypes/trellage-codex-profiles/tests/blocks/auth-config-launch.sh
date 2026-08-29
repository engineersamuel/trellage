#!/usr/bin/env bash

# Block A: adapter and catalog contracts, native auth, config management, and
# launch behaviour.

set -u
set -o pipefail

blocks_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$blocks_dir/../lib/fixture.sh"
. "$blocks_dir/../lib/profiles.sh"


jq -e '
  .schemaVersion == 1
  and (.profiles | keys | sort) == ["pstack", "superpowers"]
  and .profiles.pstack.marketplaceKind == "git-local"
  and .profiles.pstack.marketplaceSource == "Aqua-123/pstack-for-codex"
  and .profiles.pstack.marketplaceName == "pstack-for-codex-local"
  and .profiles.pstack.upstreamRepository == "https://github.com/Aqua-123/pstack-for-codex.git"
  and .profiles.pstack.plugin == "pstack-for-codex@pstack-for-codex-local"
  and .profiles.pstack.standaloneMcps == []
  and .profiles.superpowers.description == "Host-native Codex CLI with a workspace-write OS sandbox for TDD, root-cause fixes, reviews, and clean branches through the Codex-adapted Superpowers workflow."
  and .profiles.superpowers.marketplaceKind == "git"
  and .profiles.superpowers.marketplaceSource == "obra/superpowers-marketplace"
  and .profiles.superpowers.marketplaceName == "superpowers-marketplace"
  and .profiles.superpowers.upstreamRepository == "https://github.com/obra/superpowers-marketplace.git"
  and .profiles.superpowers.manifestUrl == "https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json"
  and .profiles.superpowers.plugin == "superpowers@superpowers-marketplace"
  and .profiles.superpowers.standaloneMcps == []
' "$catalog" >/dev/null || fail 'catalog contract failed'

build_fixture_profiles

HOME="$fixture_root/home" "$fixture_launcher" list >"$fixture_root/list.out" || fail 'list failed'
cmp -s "$fixture_root/list.out" <(printf '%s\n' \
  $'pstack\tpstack-for-codex@pstack-for-codex-local' \
  $'superpowers\tsuperpowers@superpowers-marketplace') \
  || fail 'list output differs'

HOME="$fixture_root/home" "$fixture_launcher" list --json >"$fixture_root/list.json" \
  || fail 'JSON list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "cdx"
  and .harness == "codex"
  and .sandbox == true
  and [.profiles[].name] == ["pstack", "superpowers"]
  and all(.profiles[]; (.description | type == "string" and length > 0))
  and .profiles[0].headless == {
    "schemaVersion": 1,
    "prompt": false,
    "outputFormats": ["text"],
    "eventContract": null,
    "trellageEventContract": null,
    "sessionId": "none",
    "resume": false,
    "resumeWithPrompt": false,
    "questionToolControl": "none",
    "changedFiles": "none",
    "usage": false,
    "cost": false,
    "modelOverride": false,
    "effortOverride": false,
    "testedHarnessVersion": null
  }
  and .profiles[1].headless == .profiles[0].headless
  and .profiles[0].plugin == "pstack-for-codex@pstack-for-codex-local"
  and .profiles[0].source == null
  and .profiles[0].marketplace == {
    "kind": "git-local",
    "manifestUrl": "https://raw.githubusercontent.com/Aqua-123/pstack-for-codex/main/.codex-plugin/marketplace.json",
    "name": "pstack-for-codex-local",
    "source": "Aqua-123/pstack-for-codex"
  }
  and .profiles[0].standaloneMcps == []
  and .profiles[1].marketplace.kind == "git"
  and .profiles[1].marketplace.source == "obra/superpowers-marketplace"
  and .profiles[1].standaloneMcps == []
' "$fixture_root/list.json" >/dev/null || fail 'JSON list output differs'

if HOME="$fixture_root/home" "$fixture_launcher" >"$fixture_root/bare.out" 2>&1; then
  fail 'bare cdx unexpectedly succeeded'
else
  status=$?
  [ "$status" -eq 2 ] || fail "bare cdx exit was $status, expected 2"
fi

write_fake_bin

HOME="$fixture_root/home" PATH="$fake_bin:$PATH" "$fixture_launcher" list --json \
  >"$fixture_root/list-verified.json" || fail 'verified JSON list failed'
jq -e '
  .profiles[0].headless == {
    "schemaVersion": 1,
    "prompt": false,
    "outputFormats": ["text"],
    "eventContract": null,
    "trellageEventContract": null,
    "sessionId": "none",
    "resume": false,
    "resumeWithPrompt": false,
    "questionToolControl": "none",
    "changedFiles": "none",
    "usage": false,
    "cost": false,
    "modelOverride": false,
    "effortOverride": false,
    "testedHarnessVersion": null
  }
  and .profiles[1].headless == .profiles[0].headless
' "$fixture_root/list-verified.json" >/dev/null || fail 'verified JSON list output differs'

profile_login_home="$fixture_root/home/.local/share/trellage/profiles/codex/pstack/home"
HOME="$fixture_root/home" CODEX_HOME="$profile_login_home" \
  FAKE_CODEX_LOGIN_STATUS=0 fake_env codex login status \
  >"$fixture_root/login-status-profile-home.out" 2>&1
login_status=$?
[ "$login_status" -eq 94 ] \
  || fail "profile-home login status was $login_status, expected 94"
HOME="$fixture_root/home" CODEX_HOME="$fixture_root/home/.codex" \
  fake_env codex login status >"$fixture_root/login-status-default.out" 2>&1
login_status=$?
[ "$login_status" -eq 1 ] \
  || fail "default host login status was $login_status, expected 1"
HOME="$fixture_root/home" CODEX_HOME="$fixture_root/home/.codex" \
  FAKE_CODEX_LOGIN_STATUS=0 fake_env codex login status \
  >"$fixture_root/login-status-success.out" 2>&1 \
  || fail 'host login status ignored forced success status'
HOME="$fixture_root/home" CODEX_HOME="$fixture_root/home/.codex" \
  FAKE_CODEX_LOGIN_STATUS=42 fake_env codex login status \
  >"$fixture_root/login-status-custom.out" 2>&1
login_status=$?
[ "$login_status" -eq 1 ] || fail "nonzero host login status was $login_status, expected 1"
rm -f "$fixture_root/fake-codex.log"

: >"$fixture_root/fake-codex.log"
assert_usage_status() {
  local label="$1" before status
  shift
  before="$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')"
  status=0
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" "$@" >"$fixture_root/$label.out" 2>&1 || status=$?
  [ "$status" -eq 2 ] || fail "$label exit was $status, expected 2"
  [ "$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')" = "$before" ] \
    || fail "$label invoked Codex"
}

assert_usage_status native-missing --native-auth
for lifecycle_profile in list setup doctor update repair --help -h; do
  assert_usage_status "native-$lifecycle_profile" --native-auth "$lifecycle_profile" pstack
done
native_unknown_status=0
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" --native-auth unknown --version \
  >"$fixture_root/native-unknown.out" 2>&1 || native_unknown_status=$?
[ "$native_unknown_status" -eq 1 ] \
  || fail "native-unknown exit was $native_unknown_status, expected 1"
grep -F -- 'cdx: unknown profile: unknown' "$fixture_root/native-unknown.out" >/dev/null \
  || fail 'native-unknown validation diagnostic differs'
[ ! -s "$fixture_root/fake-codex.log" ] || fail 'native-unknown invoked Codex'
rm -f "$fixture_root/fake-codex.log"

if HOME="$fixture_root/home" PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" unknown-profile >"$fixture_root/unknown.out" 2>&1; then
  fail 'unknown profile unexpectedly succeeded'
fi
[ ! -e "$fixture_root/fake-codex.log" ] || fail 'unknown profile invoked fake Codex'

expected_help="$fixture_root/expected-help.out"
printf '%s\n' \
  'Usage: cdx COMMAND' \
  '' \
  'Commands:' \
  '  list' \
  '  list --json' \
  '  inventory PROFILE --json' \
  '  setup PROFILE|--all' \
  '  doctor PROFILE' \
  '  update --check PROFILE|--all' \
  '  update PROFILE|--all' \
  '  repair PROFILE' \
  '  --native-auth PROFILE [CODEX_ARGS...]' \
  '  PROFILE [CODEX_ARGS...]' >"$expected_help"
HOME="$fixture_root/home" "$fixture_launcher" --help >"$fixture_root/help.out" || fail 'help failed'
cmp -s "$fixture_root/help.out" "$expected_help" || fail 'help output differs'
HOME="$fixture_root/home" "$fixture_launcher" -h >"$fixture_root/help-short.out" || fail 'short help failed'
cmp -s "$fixture_root/help-short.out" "$expected_help" || fail 'short help output differs'

mkdir -p "$fixture_root/home/.codex" "$fixture_root/original-cwd"
original_cwd="$(CDPATH= cd -- "$fixture_root/original-cwd" && pwd)"
printf '%s\n' \
  'host-only-secret = "must-not-copy"' \
  '[mcp_servers.host-only]' \
  'command = "must-not-copy"' >"$fixture_root/home/.codex/config.toml"

HOME="$fixture_root/home" fake_env "$fixture_launcher" setup pstack \
  >"$fixture_root/setup-pstack.out" || fail 'setup pstack failed'
pstack_home="$fixture_root/home/.local/share/trellage/profiles/codex/pstack/home"
[ -d "$pstack_home" ] || fail 'setup did not create pstack home'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'setup created host authentication'
auth_is_absent "$pstack_home/auth.json" || fail 'setup created profile authentication'
[ -f "$pstack_home/config.toml" ] || fail 'setup did not create profile config'
if grep -F -e 'host-only-secret' -e 'mcp_servers.host-only' -e 'must-not-copy' \
  "$pstack_home/config.toml" >/dev/null; then
  fail 'setup imported host config bytes'
fi

jq -se '
  any(.[]; .args == ["plugin","marketplace","list","--json"])
  and any(.[]; .args == ["plugin","list","--json"])
  and any(.[]; .args == ["plugin","marketplace","add","Aqua-123/pstack-for-codex","--json"])
  and any(.[]; .args == ["plugin","marketplace","upgrade","pstack-for-codex-local","--json"])
  and any(.[]; .args == ["plugin","add","pstack-for-codex@pstack-for-codex-local","--json"])
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'setup pstack native lifecycle calls differ'

printf '%s\n' '{"tokens":{"access_token":"host-only-access","refresh_token":"host-only-refresh"},"last_refresh":"2026-07-30T00:00:00Z"}' \
  >"$fixture_root/home/.codex/auth.json"
chmod 0600 "$fixture_root/home/.codex/auth.json"
host_auth_hash="$(shasum -a 256 "$fixture_root/home/.codex/auth.json" | awk '{print $1}')"
cp "$pstack_home/config.toml" "$fixture_root/proxy-launch-config-before.toml"
(cd "$original_cwd" && \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  "$fixture_launcher" pstack -m gpt-5.5 exec --json 'hello world') \
  || fail 'pstack launch failed'

HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
FAKE_CODEX_LOG="$fixture_root/pty-fake-codex.log" \
python3 - "$fixture_launcher" <<'PY' \
  || fail 'interactive Codex launch could not read from the foreground terminal'
import os
import pty
import select
import signal
import sys
import time

launcher = sys.argv[1]
pid, terminal = pty.fork()
if pid == 0:
    environment = os.environ.copy()
    environment["FAKE_CODEX_TTY_READ"] = "1"
    os.execvpe(launcher, [launcher, "pstack", "--version"], environment)

output = bytearray()
sent = False
status = None
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    ready, _, _ = select.select([terminal], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(terminal, 4096)
        except OSError:
            chunk = b""
        output.extend(chunk)
        if not sent and b"TTY_READ_READY" in output:
            os.write(terminal, b"continue\n")
            sent = True
    waited, wait_status = os.waitpid(pid, os.WNOHANG)
    if waited:
        status = os.waitstatus_to_exitcode(wait_status)
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    sys.stderr.buffer.write(output)
    raise SystemExit(1)
if status != 0 or b"TTY_READ_DONE" not in output:
    sys.stderr.buffer.write(output)
    raise SystemExit(1)
PY

cmp -s "$fixture_root/proxy-launch-config-before.toml" "$pstack_home/config.toml" \
  || fail 'proxy launch did not restore exact prelaunch config bytes'
original_cwd_physical="$(CDPATH= cd -P -- "$original_cwd" && pwd)"
jq -se --arg codexHome "$pstack_home" \
  --arg home "$fixture_root/home" \
  --arg cwd "$original_cwd" \
  --arg trustOverride "projects={\"$original_cwd_physical\"={trust_level=\"trusted\"}}" '
    map(select(.args[0] == "--sandbox")) as $launches |
    ($launches | length) == 1
    and $launches[0].codexHome == $codexHome
    and $launches[0].home == $home
    and $launches[0].cwd == $cwd
    and $launches[0].args == [
      "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true",
      "--ask-for-approval", "never", "--disable", "default_mode_request_user_input",
      "--dangerously-bypass-hook-trust",
      "-c", $trustOverride,
      "-m", "gpt-5.5", "exec", "--json", "hello world"
    ]
  ' "$fixture_root/fake-codex.log" >/dev/null || fail 'launch environment or arguments differ'

# Non-TTY auto mode keeps hook-trust bypass so unattended launches cannot block.
# CDX_HOOK_TRUST=prompt forces human review path (no bypass flag).
: >"$fixture_root/fake-codex.log"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  CDX_HOOK_TRUST=prompt \
  "$fixture_launcher" pstack --version \
  || fail 'CDX_HOOK_TRUST=prompt launch failed'
jq -se '
  map(select(.args[0] == "--sandbox")) as $launches |
  ($launches | length) == 1
  and all($launches[0].args[]; . != "--dangerously-bypass-hook-trust")
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'CDX_HOOK_TRUST=prompt still passed hook-trust bypass'
: >"$fixture_root/fake-codex.log"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  CDX_HOOK_TRUST=bypass \
  "$fixture_launcher" pstack --version \
  || fail 'CDX_HOOK_TRUST=bypass launch failed'
jq -se '
  map(select(.args[0] == "--sandbox")) as $launches |
  ($launches | length) == 1
  and any($launches[0].args[]; . == "--dangerously-bypass-hook-trust")
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'CDX_HOOK_TRUST=bypass omitted hook-trust bypass'
: >"$fixture_root/fake-codex.log"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  CDX_HOOK_TRUST=invalid-mode \
  "$fixture_launcher" pstack --version \
  >"$fixture_root/hook-trust-invalid.out" 2>&1 \
  && fail 'invalid CDX_HOOK_TRUST was accepted'
grep -F 'CDX_HOOK_TRUST must be auto, bypass, or prompt' \
  "$fixture_root/hook-trust-invalid.out" >/dev/null \
  || fail 'invalid CDX_HOOK_TRUST diagnostic missing'
: >"$fixture_root/fake-codex.log"

auth_is_absent "$pstack_home/auth.json" || fail 'launch copied host authentication'
[ "$(shasum -a 256 "$fixture_root/home/.codex/auth.json" | awk '{print $1}')" = "$host_auth_hash" ] \
  || fail 'launch changed host authentication'
rm "$fixture_root/home/.codex/auth.json"

# Linked worktree: Codex applies the trust gate to the main repository root
# (dirname of the common .git), not only the worktree cwd / show-toplevel.
worktree_trust_main="$fixture_root/git-trust-main"
worktree_trust_link="$fixture_root/git-trust-worktree"
mkdir -p "$worktree_trust_main"
git -C "$worktree_trust_main" init -b main >/dev/null \
  || fail 'could not init worktree trust main repository'
git -C "$worktree_trust_main" config user.email 'cdx-contract@example.com'
git -C "$worktree_trust_main" config user.name 'cdx contract'
printf 'seed\n' >"$worktree_trust_main/README"
git -C "$worktree_trust_main" add README \
  || fail 'could not stage worktree trust seed'
git -C "$worktree_trust_main" commit -m seed >/dev/null \
  || fail 'could not commit worktree trust seed'
git -C "$worktree_trust_main" worktree add -b cdx-trust-wt "$worktree_trust_link" >/dev/null \
  || fail 'could not add linked worktree for trust override'
worktree_trust_main_physical="$(CDPATH= cd -P -- "$worktree_trust_main" && pwd)"
worktree_trust_link_physical="$(CDPATH= cd -P -- "$worktree_trust_link" && pwd)"
worktree_trust_log="$fixture_root/fake-codex-worktree-trust.log"
: >"$worktree_trust_log"
(cd "$worktree_trust_link" && \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$worktree_trust_log" \
  "$fixture_launcher" pstack --version) \
  || fail 'launch from linked worktree failed'
jq -se \
  --arg linkPath "$worktree_trust_link_physical" \
  --arg mainPath "$worktree_trust_main_physical" '
    map(select(.args[0] == "--sandbox")) as $launches |
    ($launches | length) == 1
    and any(
      $launches[0].args[];
      type == "string"
      and test("^projects=\\{")
      and contains($linkPath)
      and contains($mainPath)
      and contains("trust_level=\"trusted\"")
    )
  ' "$worktree_trust_log" >/dev/null \
  || fail 'linked worktree launch omitted cwd or main-root project trust overrides'
git -C "$worktree_trust_main" worktree remove --force "$worktree_trust_link" >/dev/null 2>&1 || :
rm -rf -- "$worktree_trust_main" "$worktree_trust_link"

proxy_config_before="$fixture_root/proxy-launch-config-before.toml"
assert_early_status 37 proxy-launch-child-status env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_APPEND_PROJECT_TRUST_TWICE=1 \
  FAKE_CODEX_EXIT_STATUS=37 "$fixture_launcher" pstack --version
cmp -s "$proxy_config_before" "$pstack_home/config.toml" \
  || fail 'failed proxy child did not restore exact prelaunch config bytes'

proxy_config_with_separator="$fixture_root/proxy-launch-config-with-separator.toml"
awk -v marker='# trellage-managed-codex-provider-end' '
  $0 == marker { print "" }
  { print }
' "$proxy_config_before" >"$proxy_config_with_separator"
cp "$proxy_config_with_separator" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  "$fixture_launcher" pstack --version \
  || fail 'separator-preserving project trust launch failed'
cmp -s "$proxy_config_with_separator" "$pstack_home/config.toml" \
  || fail 'separator-preserving launch did not restore exact prelaunch bytes'
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

# Eight bounds compatibility well above normal one-stanza writes and the
# two-stanza recovery case while keeping accepted native-tail growth small.
generated_project_trust_cap=8
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  FAKE_CODEX_APPEND_PROJECT_TRUST_COUNT="$generated_project_trust_cap" \
  "$fixture_launcher" pstack --version \
  || fail 'boundary generated project trust chain was rejected'
cmp -s "$proxy_config_before" "$pstack_home/config.toml" \
  || fail 'boundary project trust cleanup changed prelaunch config bytes'

over_cap_project_config="$fixture_root/over-cap-project-config.toml"
over_cap_status=0
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  FAKE_CODEX_APPEND_PROJECT_TRUST_COUNT="$((generated_project_trust_cap + 1))" \
  FAKE_CODEX_CAPTURE_PROJECT_CONFIG="$over_cap_project_config" \
  "$fixture_launcher" pstack --version \
  >"$fixture_root/over-cap-project-launch.out" 2>&1 \
  || over_cap_status=$?
[ "$over_cap_status" -eq 1 ] \
  || fail 'over-cap generated project trust chain was accepted'
cmp -s "$over_cap_project_config" "$pstack_home/config.toml" \
  || fail 'over-cap project trust rejection changed live config bytes'
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

pending_signal_bash_env="$fixture_root/pending-launch-signal.bashenv"
cat >"$pending_signal_bash_env" <<'EOF'
set -T
trap '
  if [ "$0" = "$CDX_TEST_LAUNCHER_PATH" ] \
    && [ "$BASH_COMMAND" = "launch_child_pid=\$!" ] \
    && [ ! -f "$CDX_TEST_PENDING_SIGNAL_ARM" ]; then
    cdx_test_pending_child_pid=$!
    cdx_test_pending_child_stage="$CDX_TEST_PENDING_SIGNAL_CHILD_PID.$$"
    printf "%s\n" "$cdx_test_pending_child_pid" \
      >"$cdx_test_pending_child_stage" || {
        kill -KILL -- "-$cdx_test_pending_child_pid" 2>/dev/null || :
        exit 96
      }
    mv -f "$cdx_test_pending_child_stage" \
      "$CDX_TEST_PENDING_SIGNAL_CHILD_PID" || {
        rm -f -- "$cdx_test_pending_child_stage" || :
        kill -KILL -- "-$cdx_test_pending_child_pid" 2>/dev/null || :
        exit 96
      }
    cdx_test_pending_ready_wait=0
    while [ ! -f "$CDX_TEST_PENDING_SIGNAL_READY" ] \
      && kill -0 "$cdx_test_pending_child_pid" 2>/dev/null \
      && [ "$cdx_test_pending_ready_wait" -lt 200 ]; do
      sleep 0.01
      cdx_test_pending_ready_wait=$((cdx_test_pending_ready_wait + 1))
    done
    [ -f "$CDX_TEST_PENDING_SIGNAL_READY" ] || {
      kill -KILL -- "-$cdx_test_pending_child_pid" 2>/dev/null || :
      exit 97
    }
    : >"$CDX_TEST_PENDING_SIGNAL_ARM"
    kill -s "$CDX_TEST_PENDING_SIGNAL_NAME" "$$"
  fi
' DEBUG
EOF
pending_signal_iteration=1
while [ "$pending_signal_iteration" -le 3 ]; do
  pending_signal_dir="$fixture_root/pending-launch-signal-$pending_signal_iteration"
  mkdir "$pending_signal_dir"
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    BASH_ENV="$pending_signal_bash_env" \
    CDX_TEST_LAUNCHER_PATH="$fixture_launcher" \
    CDX_TEST_PENDING_SIGNAL_ARM="$pending_signal_dir/injected" \
    CDX_TEST_PENDING_SIGNAL_CHILD_PID="$pending_signal_dir/known-child.pid" \
    CDX_TEST_PENDING_SIGNAL_READY="$pending_signal_dir/ready" \
    CDX_TEST_PENDING_SIGNAL_NAME=TERM \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_TREE_DIR="$pending_signal_dir" \
    "$fixture_launcher" pstack --version \
    >"$fixture_root/pending-launch-signal-$pending_signal_iteration.out" 2>&1 &
  pending_signal_launcher_pid=$!
  track_async_pid "$pending_signal_launcher_pid"
  pending_signal_wait=0
  while { [ ! -f "$pending_signal_dir/injected" ] \
    || [ ! -f "$pending_signal_dir/known-child.pid" ]; } \
    && kill -0 "$pending_signal_launcher_pid" 2>/dev/null \
    && [ "$pending_signal_wait" -lt 100 ]; do
    sleep 0.05
    pending_signal_wait=$((pending_signal_wait + 1))
  done
  [ -f "$pending_signal_dir/injected" ] \
    || fail "pending launch signal iteration $pending_signal_iteration was not injected before PID publication"
  [ -f "$pending_signal_dir/known-child.pid" ] \
    || fail "pending launch signal iteration $pending_signal_iteration lacked atomic child PID authority"
  pending_signal_authority_lines="$(wc -l \
    <"$pending_signal_dir/known-child.pid" | tr -d ' ')"
  [ "$pending_signal_authority_lines" = 1 ] \
    || fail "pending launch signal iteration $pending_signal_iteration atomic child PID authority was not one complete line: lines=$pending_signal_authority_lines bytes=$(wc -c <"$pending_signal_dir/known-child.pid" | tr -d ' ')"
  [ -z "$(find "$pending_signal_dir" -maxdepth 1 \
    -name 'known-child.pid.*' -print -quit)" ] \
    || fail "pending launch signal iteration $pending_signal_iteration left atomic child PID staging state"
  pending_signal_child_pid="$(cat "$pending_signal_dir/known-child.pid")"
  case "$pending_signal_child_pid" in
    ''|*[!0-9]*)
      fail "pending launch signal iteration $pending_signal_iteration published invalid atomic child PID"
      ;;
  esac
  track_async_group "$pending_signal_child_pid"
  pending_signal_wait=0
  while kill -0 "$pending_signal_launcher_pid" 2>/dev/null \
    && [ "$pending_signal_wait" -lt 200 ]; do
    sleep 0.05
    pending_signal_wait=$((pending_signal_wait + 1))
  done
  pending_signal_completed=yes
  pending_signal_launcher_state=exited
  pending_signal_child_state=exited
  pending_signal_group_state=exited
  pending_signal_ready_state=no
  pending_signal_child_signal_state=no
  pending_signal_grandchild_signal_state=no
  if kill -0 "$pending_signal_launcher_pid" 2>/dev/null; then
    pending_signal_completed=no
    pending_signal_launcher_state=alive
  fi
  kill -0 "$pending_signal_child_pid" 2>/dev/null \
    && pending_signal_child_state=alive
  kill -0 -- "-$pending_signal_child_pid" 2>/dev/null \
    && pending_signal_group_state=alive
  [ ! -f "$pending_signal_dir/ready" ] || pending_signal_ready_state=yes
  [ ! -f "$pending_signal_dir/child-signaled" ] \
    || pending_signal_child_signal_state=yes
  [ ! -f "$pending_signal_dir/grandchild-signaled" ] \
    || pending_signal_grandchild_signal_state=yes
  if [ "$pending_signal_completed" = no ]; then
    kill -KILL -- "-$pending_signal_child_pid" 2>/dev/null || :
    kill -KILL "$pending_signal_launcher_pid" 2>/dev/null || :
  fi
  pending_signal_status=0
  wait "$pending_signal_launcher_pid" || pending_signal_status=$?
  if [ "$pending_signal_completed" = no ]; then
    kill -KILL -- "-$pending_signal_child_pid" 2>/dev/null || :
    pending_signal_cleanup_wait=0
    while { kill -0 "$pending_signal_child_pid" 2>/dev/null \
      || kill -0 -- "-$pending_signal_child_pid" 2>/dev/null; } \
      && [ "$pending_signal_cleanup_wait" -lt 100 ]; do
      sleep 0.05
      pending_signal_cleanup_wait=$((pending_signal_cleanup_wait + 1))
    done
  fi
  if [ -f "$pending_signal_dir/child.pid" ]; then
    pending_signal_corroborated_pid="$(cat "$pending_signal_dir/child.pid")"
    case "$pending_signal_corroborated_pid" in
      ''|*[!0-9]*)
        fail "pending launch signal iteration $pending_signal_iteration published invalid corroborating child PID"
        ;;
    esac
    [ "$pending_signal_corroborated_pid" = "$pending_signal_child_pid" ] \
      || fail "pending launch signal iteration $pending_signal_iteration child PID authority disagreed with fake child"
  fi
  [ "$pending_signal_completed" = yes ] \
    || fail "pending launch signal iteration $pending_signal_iteration timed out after condition polling: launcher=$pending_signal_launcher_state child=$pending_signal_child_state group=$pending_signal_group_state ready=$pending_signal_ready_state child-signaled=$pending_signal_child_signal_state grandchild-signaled=$pending_signal_grandchild_signal_state"
  [ "$pending_signal_status" -eq 143 ] \
    || fail "pending launch signal iteration $pending_signal_iteration exit was $pending_signal_status, expected 143"
  ! kill -0 "$pending_signal_child_pid" 2>/dev/null \
    || fail "pending launch signal iteration $pending_signal_iteration left child running"
  ! kill -0 -- "-$pending_signal_child_pid" 2>/dev/null \
    || fail "pending launch signal iteration $pending_signal_iteration left process group running"
  if [ -f "$pending_signal_dir/grandchild.pid" ] \
    && kill -0 "$(cat "$pending_signal_dir/grandchild.pid")" 2>/dev/null; then
    fail "pending launch signal iteration $pending_signal_iteration left grandchild running"
  fi
  cmp -s "$proxy_config_before" "$pstack_home/config.toml" \
    || fail "pending launch signal iteration $pending_signal_iteration bypassed exact config cleanup"
  [ ! -e "$pstack_home/.launch.lock" ] && [ ! -L "$pstack_home/.launch.lock" ] \
    || fail "pending launch signal iteration $pending_signal_iteration left profile launch lock"
  untrack_async_pid "$pending_signal_launcher_pid"
  untrack_async_group "$pending_signal_child_pid"
  pending_signal_iteration=$((pending_signal_iteration + 1))
done

overlap_dir="$fixture_root/overlapping-launches"
mkdir "$overlap_dir"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_OVERLAP_DIR="$overlap_dir" \
  "$fixture_launcher" pstack --version >"$fixture_root/overlap-first.out" 2>&1 &
overlap_first_pid=$!
track_async_pid "$overlap_first_pid"
overlap_wait=0
while [ ! -f "$overlap_dir/first-started" ] && [ "$overlap_wait" -lt 100 ]; do
  sleep 0.05
  overlap_wait=$((overlap_wait + 1))
done
[ -f "$overlap_dir/first-started" ] || fail 'first overlapping launch did not start'
overlap_first_group="$(cat "$overlap_dir/first-child.pid")"
track_async_group "$overlap_first_group"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_OVERLAP_DIR="$overlap_dir" \
  "$fixture_launcher" pstack --version >"$fixture_root/overlap-second.out" 2>&1 &
overlap_second_pid=$!
track_async_pid "$overlap_second_pid"
overlap_wait=0
while [ ! -f "$overlap_dir/second-started" ] && [ "$overlap_wait" -lt 40 ]; do
  sleep 0.05
  overlap_wait=$((overlap_wait + 1))
done
overlap_entered_early=no
[ ! -f "$overlap_dir/second-started" ] || overlap_entered_early=yes
: >"$overlap_dir/release-first"
overlap_first_status=0
overlap_second_status=0
wait "$overlap_first_pid" || overlap_first_status=$?
overlap_wait=0
while [ ! -f "$overlap_dir/second-child.pid" ] \
  && kill -0 "$overlap_second_pid" 2>/dev/null \
  && [ "$overlap_wait" -lt 100 ]; do
  sleep 0.05
  overlap_wait=$((overlap_wait + 1))
done
overlap_second_group=""
if [ -f "$overlap_dir/second-child.pid" ]; then
  overlap_second_group="$(cat "$overlap_dir/second-child.pid")"
  track_async_group "$overlap_second_group"
fi
wait "$overlap_second_pid" || overlap_second_status=$?
[ "$overlap_entered_early" = yes ] \
  || fail 'second overlapping launch did not run concurrently with the first'
[ "$overlap_first_status" -eq 0 ] || fail 'first overlapping launch failed'
[ "$overlap_second_status" -eq 0 ] \
  || { cat "$fixture_root/overlap-second.out" >&2; fail 'second overlapping launch failed'; }
[ -f "$overlap_dir/second-started" ] || fail 'second overlapping launch never started'
grep -E '^\[projects\."' "$pstack_home/config.toml" >/dev/null \
  && fail 'overlapping launches left generated project trust in config'
# Managed marker envelope must remain intact after concurrent sessions.
grep -Fxc -- '# trellage-managed-codex-config-begin' "$pstack_home/config.toml" \
  | grep -qx 1 \
  || fail 'overlapping launches damaged managed config begin marker'
grep -Fxc -- '# trellage-managed-codex-provider-end' "$pstack_home/config.toml" \
  | grep -qx 1 \
  || fail 'overlapping launches damaged managed provider end marker'
[ ! -e "$pstack_home/.launch.lock" ] && [ ! -L "$pstack_home/.launch.lock" ] \
  || fail 'overlapping launches left profile lock state'
untrack_async_pid "$overlap_first_pid"
untrack_async_group "$overlap_first_group"
untrack_async_pid "$overlap_second_pid"
[ -z "$overlap_second_group" ] || untrack_async_group "$overlap_second_group"
# Restore canonical bytes before later exact-restore assertions.
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

printf '%s %s %s\n' 2147483647 stalebirth 999-1 >"$pstack_home/.launch.lock"
chmod 0600 "$pstack_home/.launch.lock"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" pstack --version \
  || fail 'launch did not recover stale profile lock'
[ ! -e "$pstack_home/.launch.lock" ] && [ ! -L "$pstack_home/.launch.lock" ] \
  || fail 'stale profile lock recovery left lock state'

printf '%s %s %s\n' "$$" mismatchedbirth 999-2 >"$pstack_home/.launch.lock"
chmod 0600 "$pstack_home/.launch.lock"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" pstack --version \
  || fail 'launch did not recover reused-PID lock identity mismatch'
[ ! -e "$pstack_home/.launch.lock" ] && [ ! -L "$pstack_home/.launch.lock" ] \
  || fail 'reused-PID lock recovery left lock state'

printf '%s %s %s\n' 2147483647 stalebirth 999-3 >"$pstack_home/.launch.lock"
printf '%s %s %s\n' 2147483646 olderbirth 999-4 >"$pstack_home/.launch-lock-reap"
chmod 0600 "$pstack_home/.launch.lock" "$pstack_home/.launch-lock-reap"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" pstack --version \
  || fail 'launch did not recover mismatched stale recovery link'
[ ! -e "$pstack_home/.launch.lock" ] && [ ! -L "$pstack_home/.launch.lock" ] \
  || fail 'mismatched recovery-link test left profile lock'
[ ! -e "$pstack_home/.launch-lock-reap" ] \
  && [ ! -L "$pstack_home/.launch-lock-reap" ] \
  || fail 'mismatched recovery-link test left recovery link'

release_race_dir="$fixture_root/launch-lock-owner-release"
mkdir "$release_race_dir"
printf '%s %s %s\n' 2147483647 stalebirth 999-5 >"$pstack_home/.launch.lock"
chmod 0600 "$pstack_home/.launch.lock"
release_race_bash_env="$release_race_dir/release.bashenv"
cat >"$release_race_bash_env" <<'EOF'
set -T
trap '
  case "$BASH_COMMAND" in
    owner=*read_launch_lock_owner*)
      if [ "$0" = "$CDX_TEST_LAUNCHER_PATH" ] \
        && [ ! -f "$CDX_TEST_RELEASE_RACE_DIR/injected" ]; then
        : >"$CDX_TEST_RELEASE_RACE_DIR/injected"
        rm -f -- "$CDX_TEST_RELEASE_RACE_LOCK"
      fi
      ;;
  esac
' DEBUG
EOF
release_race_status=0
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  BASH_ENV="$release_race_bash_env" \
  CDX_TEST_LAUNCHER_PATH="$fixture_launcher" \
  CDX_TEST_RELEASE_RACE_DIR="$release_race_dir" \
  CDX_TEST_RELEASE_RACE_LOCK="$pstack_home/.launch.lock" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  FAKE_CODEX_RELEASE_RACE_DIR="$release_race_dir" \
  "$fixture_launcher" pstack --version >"$release_race_dir/waiter.out" 2>&1 \
  || release_race_status=$?
[ -f "$release_race_dir/injected" ] \
  || fail 'owner release race was not injected before owner read'
[ "$release_race_status" -eq 0 ] \
  || fail 'waiter did not retry after owner released launch lock'
[ -f "$release_race_dir/child-started" ] \
  || fail 'waiter did not launch after owner released launch lock'
[ ! -e "$pstack_home/.launch.lock" ] && [ ! -L "$pstack_home/.launch.lock" ] \
  || fail 'owner release race left profile lock state'

takeover_dir="$fixture_root/launch-lock-takeover"
mkdir "$takeover_dir"
takeover_birth="$(LC_ALL=C ps -p "$$" -o lstart= | tr -cd '[:alnum:]')"
[ -n "$takeover_birth" ] || fail 'could not determine takeover lock owner birth'
takeover_owner="$$ $takeover_birth 999-5"
printf '%s %s %s\n' 2147483647 stalebirth 999-4 >"$pstack_home/.launch.lock"
printf '%s\n' "$takeover_owner" >"$takeover_dir/active-owner"
chmod 0600 "$pstack_home/.launch.lock" "$takeover_dir/active-owner"
takeover_bash_env="$takeover_dir/takeover.bashenv"
cat >"$takeover_bash_env" <<'EOF'
set -T
trap '
  case "$BASH_COMMAND" in
    ln\ \"\$lock\"\ \"\$reap\"*)
      if [ "$0" = "$CDX_TEST_LAUNCHER_PATH" ] \
        && [ ! -f "$CDX_TEST_TAKEOVER_DIR/injected" ]; then
        : >"$CDX_TEST_TAKEOVER_DIR/injected"
        rm -f -- "$CDX_TEST_TAKEOVER_LOCK"
        mv "$CDX_TEST_TAKEOVER_DIR/active-owner" "$CDX_TEST_TAKEOVER_LOCK"
      fi
      ;;
  esac
' DEBUG
EOF
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  BASH_ENV="$takeover_bash_env" \
  CDX_TEST_LAUNCHER_PATH="$fixture_launcher" \
  CDX_TEST_TAKEOVER_DIR="$takeover_dir" \
  CDX_TEST_TAKEOVER_LOCK="$pstack_home/.launch.lock" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_TAKEOVER_DIR="$takeover_dir" \
  "$fixture_launcher" pstack --version >"$takeover_dir/contender.out" 2>&1 &
takeover_contender_pid=$!
track_async_pid "$takeover_contender_pid"
takeover_wait=0
while [ ! -f "$takeover_dir/injected" ] && [ "$takeover_wait" -lt 100 ]; do
  sleep 0.05
  takeover_wait=$((takeover_wait + 1))
done
[ -f "$takeover_dir/injected" ] \
  || fail 'takeover race was not injected before stale lock claim'
takeover_wait=0
while [ ! -f "$takeover_dir/child-started" ] \
  && kill -0 "$takeover_contender_pid" 2>/dev/null \
  && [ "$takeover_wait" -lt 20 ]; do
  sleep 0.05
  takeover_wait=$((takeover_wait + 1))
done
[ -f "$pstack_home/.launch.lock" ] \
  && [ "$(cat "$pstack_home/.launch.lock")" = "$takeover_owner" ] \
  || fail 'takeover race removed active profile lock'
[ ! -f "$takeover_dir/child-started" ] \
  || fail 'takeover contender entered Codex while active lock was held'
kill -0 "$takeover_contender_pid" 2>/dev/null \
  || fail 'takeover contender did not wait for active lock release'
rm -f -- "$pstack_home/.launch.lock"
takeover_status=0
wait "$takeover_contender_pid" || takeover_status=$?
[ "$takeover_status" -eq 0 ] || fail 'takeover contender failed after lock release'
[ -f "$takeover_dir/child-started" ] \
  || fail 'takeover contender did not launch after lock release'
[ ! -e "$pstack_home/.launch.lock" ] && [ ! -L "$pstack_home/.launch.lock" ] \
  || fail 'takeover contender left profile lock state'
[ ! -e "$pstack_home/.launch-lock-reap" ] \
  && [ ! -L "$pstack_home/.launch-lock-reap" ] \
  || fail 'takeover contender left recovery link'
untrack_async_pid "$takeover_contender_pid"

for launch_signal_case in HUP:129 INT:130 TERM:143; do
  launch_signal_name="${launch_signal_case%%:*}"
  launch_signal_status="${launch_signal_case#*:}"
  assert_early_status "$launch_signal_status" \
    "proxy-launch-${launch_signal_name}" env HOME="$fixture_root/home" \
    PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
    FAKE_CODEX_SIGNAL_PARENT="$launch_signal_name" \
    "$fixture_launcher" pstack --version
  cmp -s "$proxy_config_before" "$pstack_home/config.toml" \
    || fail "$launch_signal_name proxy launch did not restore exact prelaunch config bytes"
done

retry_wait_dir="$fixture_root/retry-wait-signal"
mkdir "$retry_wait_dir"
retry_wait_real_cp="$(command -v cp)"
cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
case "${2:-}" in
  */.config-snapshot.*)
    if [ -f "$CDX_TEST_RETRY_WAIT_DIR/child-signal-2" ]; then
      : >"$CDX_TEST_RETRY_WAIT_DIR/cleanup-observed"
      [ -f "$CDX_TEST_RETRY_WAIT_DIR/child-exited" ] \
        || : >"$CDX_TEST_RETRY_WAIT_DIR/cleanup-before-child-exit"
    fi
    ;;
esac
exec "$CDX_TEST_RETRY_WAIT_REAL_CP" "$@"
EOF
chmod +x "$fake_bin/cp"
set -m
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_TREE_DIR="$retry_wait_dir" \
  FAKE_CODEX_WAIT_SECOND_SIGNAL=1 \
  CDX_TEST_RETRY_WAIT_DIR="$retry_wait_dir" \
  CDX_TEST_RETRY_WAIT_REAL_CP="$retry_wait_real_cp" \
  "$fixture_launcher" pstack --version >"$fixture_root/retry-wait-signal.out" 2>&1 &
retry_wait_launcher_pid=$!
track_async_pid "$retry_wait_launcher_pid"
set +m
retry_wait_count=0
while [ ! -f "$retry_wait_dir/ready" ] && [ "$retry_wait_count" -lt 100 ]; do
  sleep 0.05
  retry_wait_count=$((retry_wait_count + 1))
done
[ -f "$retry_wait_dir/ready" ] || fail 'retry-wait process tree did not start'
retry_wait_group="$(cat "$retry_wait_dir/child.pid")"
track_async_group "$retry_wait_group"
kill -TERM "$retry_wait_launcher_pid" || fail 'could not send first retry-wait signal'
retry_wait_count=0
while [ ! -f "$retry_wait_dir/child-signal-1" ] \
  && [ "$retry_wait_count" -lt 100 ]; do
  sleep 0.05
  retry_wait_count=$((retry_wait_count + 1))
done
[ -f "$retry_wait_dir/child-signal-1" ] \
  || fail 'first retry-wait signal did not reach child'
kill -TERM "$retry_wait_launcher_pid" || fail 'could not interrupt retrying wait'
retry_wait_count=0
while [ ! -f "$retry_wait_dir/cleanup-observed" ] \
  && kill -0 "$retry_wait_launcher_pid" 2>/dev/null \
  && [ "$retry_wait_count" -lt 100 ]; do
  sleep 0.05
  retry_wait_count=$((retry_wait_count + 1))
done
retry_wait_status=0
wait "$retry_wait_launcher_pid" || retry_wait_status=$?
[ ! -f "$retry_wait_dir/cleanup-before-child-exit" ] \
  || fail 'retrying wait allowed cleanup while child remained alive'
[ "$retry_wait_status" -eq 143 ] \
  || fail "retry-wait launch exit was $retry_wait_status, expected 143"
if kill -0 "$(cat "$retry_wait_dir/grandchild.pid")" 2>/dev/null; then
  fail 'retrying wait left grandchild running'
fi
cmp -s "$proxy_config_before" "$pstack_home/config.toml" \
  || fail 'retrying wait bypassed exact config cleanup'
[ ! -e "$pstack_home/.launch.lock" ] && [ ! -L "$pstack_home/.launch.lock" ] \
  || fail 'retrying wait released lock before process tree reaped'
untrack_async_pid "$retry_wait_launcher_pid"
untrack_async_group "$retry_wait_group"
rm "$fake_bin/cp"

assert_early_status 1 proxy-launch-unrelated-mutation env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  FAKE_CODEX_PROJECT_EXTRA_FIELD='unexpected = true' \
  "$fixture_launcher" pstack --version
grep -F -- 'cdx: post-launch config cleanup refused unrelated mutation: pstack' \
  "$fixture_root/proxy-launch-unrelated-mutation.out" >/dev/null \
  || fail 'unrelated launch mutation cleanup diagnostic differs'
grep -F -- 'unexpected = true' "$pstack_home/config.toml" >/dev/null \
  || fail 'cleanup clobbered unrelated launch mutation'
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

# Codex often bumps tui nux counters and rewrites hooks.state during a normal
# session while also persisting project trust. Cleanup must strip trust, keep
# the session-live tables, and exit 0.
awk -v marker='# trellage-managed-codex-provider-end' '
  $0 == marker {
    print ""
    print "[hooks.state]"
    print ""
    print "[tui.model_availability_nux]"
    print "\"gpt-5.6-sol\" = 1"
  }
  { print }
' "$proxy_config_before" >"$fixture_root/session-live-before.toml"
cp "$fixture_root/session-live-before.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  FAKE_CODEX_BUMP_TUI_NUX=1 \
  "$fixture_launcher" pstack --version \
  || fail 'session-live hooks/tui launch cleanup failed'
grep -E '^\[projects\."' "$pstack_home/config.toml" >/dev/null \
  && fail 'session-live launch left generated project trust'
grep -F -- '"gpt-5.6-sol" = 2' "$pstack_home/config.toml" >/dev/null \
  || fail 'session-live launch cleanup dropped tui nux mutation'
grep -F -- '[hooks.state]' "$pstack_home/config.toml" >/dev/null \
  || fail 'session-live launch cleanup dropped hooks.state'
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
    print ""
  }
  { print }
' "$pstack_home/config.toml" >"$fixture_root/stale-project-config.toml"
mv "$fixture_root/stale-project-config.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor pstack \
  >"$fixture_root/doctor-stale-project.out" \
  || fail 'doctor did not recover stale generated project trust'
cmp -s "$proxy_config_with_separator" "$pstack_home/config.toml" \
  || fail 'stale project trust recovery changed other config bytes'

awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
    print ""
  }
  { print }
' "$pstack_home/config.toml" >"$fixture_root/stale-project-repair.toml"
mv "$fixture_root/stale-project-repair.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair pstack \
  >"$fixture_root/repair-stale-project.out" \
  || fail 'repair did not recover stale generated project trust'
cmp -s "$proxy_config_with_separator" "$pstack_home/config.toml" \
  || fail 'repair stale project recovery changed other config bytes'

awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
    print ""
    print ""
  }
  { print }
' "$pstack_home/config.toml" >"$fixture_root/stale-project-extra-blanks.toml"
mv "$fixture_root/stale-project-extra-blanks.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
cp "$pstack_home/config.toml" "$fixture_root/stale-project-extra-blanks-before.toml"
extra_blank_status=0
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor pstack \
  >"$fixture_root/doctor-stale-project-extra-blanks.out" 2>&1 \
  || extra_blank_status=$?
[ "$extra_blank_status" -eq 1 ] \
  || fail 'doctor accepted multiple trailing project trust blanks'
cmp -s "$fixture_root/stale-project-extra-blanks-before.toml" \
  "$pstack_home/config.toml" \
  || fail 'doctor changed project trust with multiple trailing blanks'
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
  }
  { print }
' "$pstack_home/config.toml" >"$fixture_root/stale-project-setup.toml"
mv "$fixture_root/stale-project-setup.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" setup pstack \
  >"$fixture_root/setup-stale-project.out" \
  || fail 'setup did not recover stale generated project trust'
cmp -s "$proxy_config_with_separator" "$pstack_home/config.toml" \
  || fail 'setup stale project recovery changed other config bytes'

awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
  }
  { print }
' "$pstack_home/config.toml" >"$fixture_root/stale-project-launch.toml"
mv "$fixture_root/stale-project-launch.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" pstack --version \
  || fail 'launch did not recover stale generated project trust'
# Launch prepare no longer mutates live trust (concurrent sessions share the
# home). Cleanup strips trust and prefers none-style so concurrent cleanups do
# not leave cosmetic blank separators.
cmp -s "$proxy_config_before" "$pstack_home/config.toml" \
  || fail 'launch stale project recovery changed other config bytes'

# Codex writes hook-approval trust hashes and TUI nux flags into config.toml
# after the managed provider tail, often *after* a project trust stanza that
# is itself only ever transient. Doctor must strip the stale project trust
# while leaving this other native Codex state untouched.
awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
    print ""
    print "[hooks.state]"
    print ""
    print "[hooks.state.\"" cwd "/.codex/hooks.json:pre_tool_use:0:0\"]"
    print "trusted_hash = \"sha256:398989e9bdf95b43657a40589049a298a170f1946642abe2124fe9ee222caa5a\""
    print ""
    print "[tui.model_availability_nux]"
    print "\"gpt-5.6-sol\" = 1"
  }
  { print }
' "$pstack_home/config.toml" >"$fixture_root/stale-project-with-hooks-nux.toml"
mv "$fixture_root/stale-project-with-hooks-nux.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor pstack \
  >"$fixture_root/doctor-stale-project-hooks-nux.out" \
  || fail 'doctor rejected hooks state and tui nux native content'
grep -F -- '[projects."' "$pstack_home/config.toml" >/dev/null \
  && fail 'doctor left stale project trust alongside hooks state and tui nux'
grep -F -- '[hooks.state]' "$pstack_home/config.toml" >/dev/null \
  || fail 'doctor stripped hooks state alongside stale project trust'
grep -F -- 'trusted_hash = "sha256:398989e9bdf95b43657a40589049a298a170f1946642abe2124fe9ee222caa5a"' \
  "$pstack_home/config.toml" >/dev/null \
  || fail 'doctor lost a hook approval trust hash'
grep -F -- '[tui.model_availability_nux]' "$pstack_home/config.toml" >/dev/null \
  || fail 'doctor stripped tui nux flags alongside stale project trust'
grep -F -- '"gpt-5.6-sol" = 1' "$pstack_home/config.toml" >/dev/null \
  || fail 'doctor lost a tui nux flag'
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

# Hooks state and tui nux content with no project trust stanza at all must be
# accepted and left byte-for-byte unchanged (no stale content to recover).
awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print "[hooks.state]"
    print ""
    print "[hooks.state.\"" cwd "/.codex/hooks.json:post_tool_use:0:0\"]"
    print "trusted_hash = \"sha256:a044cd448bad32f8a34e7639e24f7aa40ba782ee3221fa3c510958986e26518f\""
    print ""
    print "[tui.model_availability_nux]"
    print "\"gpt-5.6-sol\" = 1"
    print ""
  }
  { print }
' "$pstack_home/config.toml" >"$fixture_root/hooks-nux-only.toml"
mv "$fixture_root/hooks-nux-only.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
cp "$pstack_home/config.toml" "$fixture_root/hooks-nux-only-before.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor pstack \
  >"$fixture_root/doctor-hooks-nux-only.out" \
  || fail 'doctor rejected hooks state and tui nux native content with no project trust'
cmp -s "$fixture_root/hooks-nux-only-before.toml" "$pstack_home/config.toml" \
  || fail 'doctor changed hooks state and tui nux bytes with no project trust to recover'
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

awk '
  $0 == "# trellage-profile-local-config-end" {
    print "[projects.\"/user/owned/project\"]"
    print "trust_level = \"trusted\""
  }
  { print }
' "$pstack_home/config.toml" >"$fixture_root/local-project-config.toml"
mv "$fixture_root/local-project-config.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
cp "$pstack_home/config.toml" "$fixture_root/local-project-config-before.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor pstack \
  >"$fixture_root/doctor-local-project.out" \
  || fail 'doctor rejected profile-local project table'
cmp -s "$fixture_root/local-project-config-before.toml" "$pstack_home/config.toml" \
  || fail 'recovery changed profile-local project table bytes'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" pstack --version \
  || fail 'launch with profile-local project table failed'
cmp -s "$fixture_root/local-project-config-before.toml" "$pstack_home/config.toml" \
  || fail 'launch cleanup changed profile-local project table bytes'
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

real_cmp="$(command -v cmp)"
sed 's/model = "gpt-5.6-sol"/model = "concurrent-launch-winner"/' \
  "$proxy_config_before" >"$fixture_root/concurrent-launch-config.toml"
chmod 0600 "$fixture_root/concurrent-launch-config.toml"
cat >"$fake_bin/cmp" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CMP" "$@"
status=$?
case "${2:-}:${3:-}" in
  */.config-snapshot.*:*/config.toml|*/.config-snapshot.*:*/.config-cleanup-*)
    if [ "$status" -eq 0 ] && [ -f "$CDX_TEST_CLEANUP_RACE_ARM" ]; then
      rm "$CDX_TEST_CLEANUP_RACE_ARM" || exit $?
      "$CDX_TEST_REAL_MV" "$CDX_TEST_CLEANUP_RACE_EXTERNAL" \
        "$CDX_TEST_CLEANUP_RACE_TARGET" || exit $?
    fi
    ;;
esac
exit "$status"
EOF
chmod +x "$fake_bin/cmp"
# Concurrent writers may replace config during cleanup. Keep the other writer's
# bytes and fail the launch rather than clobbering them.
assert_early_status 1 proxy-launch-cleanup-race env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 CDX_TEST_REAL_CMP="$real_cmp" \
  FAKE_CODEX_ARM_CLEANUP_RACE="$fixture_root/arm-launch-cleanup-race" \
  CDX_TEST_REAL_MV="$(command -v mv)" \
  CDX_TEST_CLEANUP_RACE_ARM="$fixture_root/arm-launch-cleanup-race" \
  CDX_TEST_CLEANUP_RACE_EXTERNAL="$fixture_root/concurrent-launch-config.toml" \
  CDX_TEST_CLEANUP_RACE_TARGET="$pstack_home/config.toml" \
  "$fixture_launcher" pstack --version
if ! grep -F -- 'cdx: post-launch config cleanup refused unrelated mutation: pstack' \
  "$fixture_root/proxy-launch-cleanup-race.out" >/dev/null \
  && ! grep -F -- 'cdx: post-launch config cleanup detected concurrent mutation: pstack' \
  "$fixture_root/proxy-launch-cleanup-race.out" >/dev/null; then
  fail 'concurrent launch cleanup diagnostic differs'
fi
grep -F -- 'model = "concurrent-launch-winner"' "$pstack_home/config.toml" >/dev/null \
  || fail 'launch cleanup clobbered concurrent config mutation'
rm "$fake_bin/cmp"
cp "$proxy_config_before" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"


dangling_auth_probe="$fixture_root/dangling-auth.json"
ln -s "$fixture_root/missing-auth-target.json" "$dangling_auth_probe"
if auth_is_absent "$dangling_auth_probe"; then
  fail 'auth absence check accepted a dangling symlink'
fi
rm "$dangling_auth_probe"

stat_probe="$fixture_root/stat-probe"
: >"$stat_probe"
chmod 0640 "$stat_probe"
[ "$(file_mode "$stat_probe")" = '640' ] \
  || fail 'file_mode did not return exact numeric mode'
stat_probe_inode="$(file_inode "$stat_probe")" \
  || fail 'file_inode failed for probe'
case "$stat_probe_inode" in
  ''|*[!0-9]*) fail 'file_inode did not return an exact numeric inode' ;;
esac

root_write_blocker_bin="$fixture_root/root-write-blocker-bin"
mkdir "$root_write_blocker_bin"
cat >"$root_write_blocker_bin/write-blocker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$0 $*" >>"$CDX_TEST_ROOT_WRITE_LOG"
exit 79
EOF
chmod +x "$root_write_blocker_bin/write-blocker"
for blocked_command in mkdir chmod mktemp ln cp mv; do
  ln -s write-blocker "$root_write_blocker_bin/$blocked_command"
done
root_write_log="$fixture_root/root-write.log"
root_profile_target='/.local/share/trellage/profiles/codex/pstack/home'
if [ -e "$root_profile_target" ] || [ -L "$root_profile_target" ]; then
  root_target_identity="$(file_inode "$root_profile_target"):$(file_mode "$root_profile_target")"
else
  root_target_identity='missing'
fi
assert_root_home_rejected() {
  local label="$1"
  local unsafe_home="$2"
  local expected_path="${unsafe_home%/}/.local/share/trellage/profiles/codex/pstack/home"
  assert_command_fails "root-home-doctor-$label" env HOME="$unsafe_home" \
    PATH="$root_write_blocker_bin:$PATH" CDX_TEST_ROOT_WRITE_LOG="$root_write_log" \
    "$fixture_launcher" doctor pstack
  grep -F -- "cdx: unsafe profile home path: $expected_path" \
    "$fixture_root/root-home-doctor-$label.out" >/dev/null \
    || fail "canonical root HOME doctor diagnostic differs for $label"
  assert_command_fails "root-home-setup-$label" env HOME="$unsafe_home" \
    PATH="$root_write_blocker_bin:$PATH" CDX_TEST_ROOT_WRITE_LOG="$root_write_log" \
    "$fixture_launcher" setup pstack
  grep -F -- "cdx: unsafe profile home path: $expected_path" \
    "$fixture_root/root-home-setup-$label.out" >/dev/null \
    || fail "canonical root HOME setup diagnostic differs for $label"
}
assert_root_home_rejected double-slash '//'
assert_root_home_rejected parent-alias '/tmp/..'
[ ! -e "$root_write_log" ] || fail 'canonical root HOME attempted a profile-derived write'
if [ -e "$root_profile_target" ] || [ -L "$root_profile_target" ]; then
  root_target_after="$(file_inode "$root_profile_target"):$(file_mode "$root_profile_target")"
else
  root_target_after='missing'
fi
[ "$root_target_after" = "$root_target_identity" ] \
  || fail 'canonical root HOME mutated the root profile target'

expected_config="$fixture_root/expected-config.toml"
cat >"$expected_config" <<EOF
# trellage-managed-codex-config-begin
model = "gpt-5.6-sol"
model_provider = "copilotproxy"
model_reasoning_effort = "medium"
# trellage-managed-codex-config-end

# trellage-profile-local-config-begin
# Add profile-local MCP and other user sections here.
# trellage-profile-local-config-end

# trellage-managed-codex-provider-begin
[model_providers.copilotproxy]
name = "Copilot Proxy RS"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"

[marketplaces.pstack-for-codex-local]
last_updated = "2026-07-30T21:16:34Z"
source_type = "git"
source = "https://github.com/Aqua-123/pstack-for-codex.git"
last_revision = "0123456789abcdef0123456789abcdef01234567"

[plugins."pstack-for-codex@pstack-for-codex-local"]
enabled = true
# trellage-managed-codex-provider-end
EOF

cmp -s "$expected_config" "$pstack_home/config.toml" || fail 'initial managed config differs'
[ "$(file_mode "$pstack_home")" = '700' ] || fail 'pstack home mode is not 0700'
[ "$(file_mode "$pstack_home/config.toml")" = '600' ] || fail 'pstack config mode is not 0600'
write_main_plugin_cache
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" doctor pstack \
  >"$fixture_root/doctor-pstack.out" || fail 'doctor pstack failed'
: >"$fake_state/pstack/forbidden-superpowers"
if HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" doctor pstack \
  >"$fixture_root/doctor-pstack-superpowers.out" \
  2>"$fixture_root/doctor-pstack-superpowers.err"; then
  fail 'doctor accepted Superpowers in the pstack profile'
fi
grep -F -- 'cdx: forbidden Superpowers plugin is installed: pstack; run: cdx repair pstack' \
  "$fixture_root/doctor-pstack-superpowers.err" >/dev/null \
  || fail 'Codex forbidden-Superpowers diagnostic differs'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" repair pstack \
  >"$fixture_root/repair-pstack-superpowers.out" \
  || fail 'repair did not remove forbidden Superpowers from pstack'
[ ! -e "$fake_state/pstack/forbidden-superpowers" ] \
  || fail 'repair preserved forbidden Superpowers in pstack'
: >"$fake_state/pstack/forbidden-superpowers-direct"
: >"$fake_state/pstack/forbidden-superpowers-renamed"
launches_before="$(jq -s '[.[] | select(.args[0] == "--sandbox")] | length' \
  "$fixture_root/fake-codex.log")"
mkdir -p "$fixture_root/home/.codex"
printf '%s\n' '{"tokens":{"access_token":"contamination-check"}}' \
  >"$fixture_root/home/.codex/auth.json"
chmod 0600 "$fixture_root/home/.codex/auth.json"
export FAKE_CODEX_LOGIN_STATUS=0
for contaminated_launch in proxy native; do
  contaminated_args=(pstack --version)
  [ "$contaminated_launch" = proxy ] \
    || contaminated_args=(--native-auth pstack --version)
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" "${contaminated_args[@]}" \
    >"$fixture_root/$contaminated_launch-contaminated.out" \
    2>"$fixture_root/$contaminated_launch-contaminated.err" \
    || fail "$contaminated_launch launch did not self-heal forbidden Superpowers"
done
unset FAKE_CODEX_LOGIN_STATUS
rm "$fixture_root/home/.codex/auth.json"
[ -f "$pstack_home/auth.json" ] \
  || fail 'self-healed native launch did not refresh profile authentication'
rm "$pstack_home/auth.json"
[ ! -e "$fake_state/pstack/forbidden-superpowers-direct" ] \
  && [ ! -e "$fake_state/pstack/forbidden-superpowers-renamed" ] \
  || fail 'contaminated launch preserved forbidden Superpowers variants'
[ "$(jq -s '[.[] | select(.args[0] == "--sandbox")] | length' \
  "$fixture_root/fake-codex.log")" = "$((launches_before + 2))" ] \
  || fail 'self-healed launches did not start the underlying Codex agent'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" inventory pstack --json \
  >"$fixture_root/inventory-pstack.json" || fail 'inventory pstack failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "cdx"
  and .harness == "codex"
  and .profile == "pstack"
  and .readiness == "healthy"
  and .plugins == [{name:"pstack-for-codex@pstack-for-codex-local",version:"0.1.0"}]
  and .skills == {packageCount:45,visibleCount:2}
  and .mcps == ["docs"]
' "$fixture_root/inventory-pstack.json" >/dev/null \
  || fail 'Codex inventory output differs'
mv "$pstack_cache" "$pstack_cache.safe"
ln -s "$pstack_home/plugins/cache/pstack-for-codex-local/unrelated/9.9.9" "$pstack_cache"
if HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" doctor pstack \
  >"$fixture_root/doctor-pstack-symlink.out" \
  2>"$fixture_root/doctor-pstack-symlink.err"; then
  fail 'Codex doctor accepted a redirected selected plugin cache'
fi
grep -F -- 'selected plugin cache is invalid: pstack' \
  "$fixture_root/doctor-pstack-symlink.err" >/dev/null \
  || fail 'Codex redirected-cache diagnostic differs'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" inventory pstack --json \
  >"$fixture_root/inventory-pstack-symlink.json" \
  || fail 'inventory failed on redirected selected plugin cache'
jq -e '.profile == "pstack" and .readiness == "unhealthy"' \
  "$fixture_root/inventory-pstack-symlink.json" >/dev/null \
  || fail 'redirected selected plugin cache was not reported unhealthy'
rm "$pstack_cache"
mv "$pstack_cache.safe" "$pstack_cache"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  "$fixture_launcher" inventory superpowers --json \
  >"$fixture_root/inventory-not-setup.json" || fail 'not-setup inventory failed'
jq -e '
  .profile == "superpowers"
  and .readiness == "not-setup"
  and .plugins == []
  and .skills == {packageCount:null,visibleCount:null}
  and .mcps == []
' "$fixture_root/inventory-not-setup.json" >/dev/null \
  || fail 'Codex not-setup inventory differs'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'doctor created host authentication'
auth_is_absent "$pstack_home/auth.json" || fail 'doctor created profile authentication'

sed 's/2026-07-30T21:16:34Z/2026-07-30T22:17:35Z/' \
  "$pstack_home/config.toml" >"$fixture_root/config-new-timestamp.toml"
mv "$fixture_root/config-new-timestamp.toml" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor pstack \
  >"$fixture_root/doctor-pstack-new-timestamp.out" \
  || fail 'doctor rejected mutable native marketplace timestamp'
HOME="$fixture_root/home" fake_env "$fixture_launcher" setup pstack \
  >"$fixture_root/setup-pstack-new-timestamp.out" \
  || fail 'repeated setup rejected mutable native marketplace timestamp'
grep -F -- 'last_updated = "2026-07-30T22:17:35Z"' \
  "$pstack_home/config.toml" >/dev/null \
  || fail 'repeated setup changed native marketplace timestamp'
cp "$expected_config" "$pstack_home/config.toml"

: >"$fixture_root/fake-codex.log"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" setup --all \
  >"$fixture_root/setup-all.out" || fail 'setup --all failed'
superpowers_home="$fixture_root/home/.local/share/trellage/profiles/codex/superpowers/home"
[ -d "$superpowers_home" ] || fail 'setup --all did not create superpowers home'
expected_superpowers_config="$fixture_root/expected-superpowers-config.toml"
sed \
  -e 's/\[marketplaces\.pstack-for-codex-local\]/[marketplaces.superpowers-marketplace]/' \
  -e 's/\[plugins\."pstack-for-codex@pstack-for-codex-local"\]/[plugins."superpowers@superpowers-marketplace"]/' \
  -e 's|^source = "https://github.com/Aqua-123/pstack-for-codex.git"$|source = "https://github.com/obra/superpowers-marketplace.git"|' \
  "$expected_config" >"$expected_superpowers_config"
cmp -s "$expected_superpowers_config" "$superpowers_home/config.toml" \
  || {
    diff -u "$expected_superpowers_config" "$superpowers_home/config.toml" >&2 || :
    fail 'superpowers managed config differs'
  }
[ -f "$superpowers_home/.tmp/marketplaces/superpowers-marketplace/.fake-materialized-revision" ] \
  || fail 'fresh Superpowers setup did not materialize marketplace revision'
[ -f "$superpowers_home/plugins/.fake-installed-superpowers" ] \
  || fail 'fresh Superpowers setup did not materialize install metadata'
[ -f "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" ] \
  || fail 'fresh Superpowers setup did not materialize selected plugin cache'
jq -se --arg superpowers "$superpowers_home" '
  map(select(.codexHome == $superpowers)) as $calls |
  ($calls | map(.args)) as $args |
  $args[2:9] == [
    ["plugin","marketplace","add","obra/superpowers-marketplace","--json"],
    ["plugin","marketplace","list","--json"],
    ["plugin","list","--json"],
    ["plugin","marketplace","upgrade","superpowers-marketplace","--json"],
    ["plugin","marketplace","list","--json"],
    ["plugin","add","superpowers@superpowers-marketplace","--json"],
    ["plugin","list","--json"]
  ] and
  ([ $args[] | select(.[0:3] == ["plugin","marketplace","upgrade"]) ] | length) == 1
' "$fixture_root/fake-codex.log" >/dev/null \
  || {
    jq -c --arg superpowers "$superpowers_home" \
      'select(.codexHome == $superpowers) | .args' \
      "$fixture_root/fake-codex.log" >&2 || :
    fail 'fresh Superpowers setup did not prime marketplace before plugin add'
  }
[ "$(file_mode "$superpowers_home")" = '700' ] \
  || fail 'superpowers home mode is not 0700'
[ "$(file_mode "$superpowers_home/config.toml")" = '600' ] \
  || fail 'superpowers config mode is not 0600'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'setup --all created host authentication'
auth_is_absent "$pstack_home/auth.json" \
  || fail 'setup --all created pstack authentication'
auth_is_absent "$superpowers_home/auth.json" \
  || fail 'setup --all created superpowers authentication'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" doctor superpowers \
  >"$fixture_root/doctor-superpowers.out" || fail 'doctor superpowers failed'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'doctor created host authentication'
auth_is_absent "$pstack_home/auth.json" || fail 'doctor created pstack authentication'
auth_is_absent "$superpowers_home/auth.json" \
  || fail 'doctor created superpowers authentication'

# A bounded first launch after setup must not trigger Codex app-startup
# materialization or change selected marketplace/plugin bytes.
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot launch-after-fresh-superpowers-setup
HOME="$fixture_root/home" fake_env "$fixture_launcher" superpowers \
  'bounded full app prompt' \
  || fail 'first Superpowers launch after setup failed'
assert_isolation_snapshot_unchanged launch-after-fresh-superpowers-setup

upgrade_failure_home="$fixture_root/upgrade-failure-home"
prepare_test_home() {
  test_home="$1"
  mkdir -p "$test_home/.codex"
}
prepare_test_home "$upgrade_failure_home"
mv "$fake_state/superpowers" "$fixture_root/main-superpowers-state"
: >"$fixture_root/fake-codex.log"
assert_command_fails setup-superpowers-upgrade-failure env \
  HOME="$upgrade_failure_home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_FAIL_MUTATION=marketplace-upgrade \
  "$fixture_launcher" setup superpowers
grep -F -- 'cdx: failed to materialize selected Git marketplace: superpowers' \
  "$fixture_root/setup-superpowers-upgrade-failure.out" >/dev/null \
  || fail 'failed fresh Superpowers materialization diagnostic differs'
if grep -F -- 'superpowers: ready' \
  "$fixture_root/setup-superpowers-upgrade-failure.out" >/dev/null; then
  fail 'failed fresh Superpowers materialization reported ready'
fi
upgrade_failure_profile="$upgrade_failure_home/.local/share/trellage/profiles/codex/superpowers/home"
[ ! -e "$upgrade_failure_profile/plugins/.fake-installed-superpowers" ] \
  || fail 'failed fresh Superpowers materialization wrote install metadata'
[ ! -e "$upgrade_failure_profile/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" ] \
  || fail 'failed fresh Superpowers materialization added selected plugin before upgrade'
jq -se '
  any(.[]; .args == ["plugin","marketplace","upgrade","superpowers-marketplace","--json"])
  and all(.[]; .args[0] != "--sandbox")
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'failed fresh Superpowers materialization used a launch fallback'
: >"$fixture_root/fake-codex.log"
HOME="$upgrade_failure_home" fake_env "$fixture_launcher" setup superpowers \
  >"$fixture_root/setup-superpowers-upgrade-retry.out" \
  || fail 'fresh Superpowers setup did not retry failed marketplace priming'
jq -se '
  any(.[]; .args == ["plugin","marketplace","upgrade","superpowers-marketplace","--json"])
  and any(.[]; .args == ["plugin","add","superpowers@superpowers-marketplace","--json"])
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'fresh Superpowers priming retry falsely reported ready'
[ -f "$upgrade_failure_profile/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" ] \
  || fail 'fresh Superpowers priming retry did not materialize selected cache'
mv "$fake_state/superpowers" "$fixture_root/upgrade-failure-state"
mv "$fixture_root/main-superpowers-state" "$fake_state/superpowers"

plugin_add_failure_home="$fixture_root/plugin-add-failure-home"
plugin_add_failure_profile="$plugin_add_failure_home/.local/share/trellage/profiles/codex/superpowers/home"
prepare_test_home "$plugin_add_failure_home"
mv "$fake_state/superpowers" "$fixture_root/main-superpowers-state"
mkdir "$fake_state/superpowers"
: >"$fixture_root/fake-codex.log"
assert_command_fails setup-superpowers-plugin-add-failure env \
  HOME="$plugin_add_failure_home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_FAIL_MUTATION=plugin-add \
  "$fixture_launcher" setup superpowers
grep -F -- 'cdx: failed to add selected plugin: superpowers' \
  "$fixture_root/setup-superpowers-plugin-add-failure.out" >/dev/null \
  || fail 'failed fresh Superpowers plugin add diagnostic differs'
[ ! -e "$plugin_add_failure_profile/plugins/.fake-installed-superpowers" ] \
  || fail 'marketplace upgrade created selected plugin metadata before add'
[ ! -e "$plugin_add_failure_profile/plugins/cache/superpowers-marketplace/superpowers/6.2.0" ] \
  || fail 'marketplace upgrade created selected plugin cache before add'
jq -se '
  [ .[] | select(.args[2] == "upgrade" or .args[1] == "add") | .args ] == [
    ["plugin","marketplace","upgrade","superpowers-marketplace","--json"],
    ["plugin","add","superpowers@superpowers-marketplace","--json"]
  ]
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'failed fresh Superpowers plugin add mutation order differs'
: >"$fixture_root/fake-codex.log"
HOME="$plugin_add_failure_home" fake_env "$fixture_launcher" setup superpowers \
  >"$fixture_root/setup-superpowers-plugin-add-retry.out" \
  || fail 'fresh Superpowers plugin add retry failed'
jq -se '
  [ .[] | select(.args[2] == "upgrade" or .args[1] == "add") | .args ] == [
    ["plugin","add","superpowers@superpowers-marketplace","--json"]
  ]
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'fresh Superpowers plugin add retry mutation order differs'
[ -f "$plugin_add_failure_profile/plugins/.fake-installed-superpowers" ] \
  && [ -f "$plugin_add_failure_profile/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" ] \
  || fail 'plugin add retry did not create selected plugin files'
mv "$fake_state/superpowers" "$fixture_root/plugin-add-failure-state"
mv "$fixture_root/main-superpowers-state" "$fake_state/superpowers"

fresh_unrelated_home="$fixture_root/fresh-unrelated-home"
fresh_unrelated_profile="$fresh_unrelated_home/.local/share/trellage/profiles/codex/superpowers/home"
mkdir -p "$fresh_unrelated_profile/plugins/cache/superpowers-marketplace/unrelated/1.0.0" \
  "$fresh_unrelated_home/.codex"
chmod 0700 "$fresh_unrelated_profile"
sed '/^\[marketplaces\.superpowers-marketplace\]$/,/^enabled = true$/d' \
  "$superpowers_home/config.toml" >"$fresh_unrelated_profile/config.toml"
chmod 0600 "$fresh_unrelated_profile/config.toml"
printf '%s\n' 'fresh unrelated cache bytes must stay exact' \
  >"$fresh_unrelated_profile/plugins/cache/superpowers-marketplace/unrelated/1.0.0/.fake-materialized-cache"
cp "$fresh_unrelated_profile/config.toml" \
  "$fixture_root/fresh-unrelated-config-before.toml"
cp "$fresh_unrelated_profile/plugins/cache/superpowers-marketplace/unrelated/1.0.0/.fake-materialized-cache" \
  "$fixture_root/fresh-unrelated-cache-before"
mv "$fake_state/superpowers" "$fixture_root/main-superpowers-state"
mkdir "$fake_state/superpowers"
: >"$fake_state/superpowers/unrelated-same-marketplace"
: >"$fixture_root/fake-codex.log"
assert_command_fails setup-fresh-unrelated-block env \
  HOME="$fresh_unrelated_home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" setup superpowers
grep -Fx -- \
  'cdx: cannot prime selected Git marketplace with unrelated installed plugins: superpowers' \
  "$fixture_root/setup-fresh-unrelated-block.out" >/dev/null \
  || fail 'fresh unrelated same-marketplace diagnostic differs'
cmp -s "$fixture_root/fresh-unrelated-config-before.toml" \
  "$fresh_unrelated_profile/config.toml" \
  && cmp -s "$fixture_root/fresh-unrelated-cache-before" \
    "$fresh_unrelated_profile/plugins/cache/superpowers-marketplace/unrelated/1.0.0/.fake-materialized-cache" \
  || fail 'fresh unrelated same-marketplace block changed state bytes'
[ ! -e "$fake_state/superpowers/marketplace" ] \
  && [ ! -e "$fake_state/superpowers/plugin" ] \
  || fail 'fresh unrelated same-marketplace block mutated selected state'
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'fresh unrelated same-marketplace block ran a native mutation'
mv "$fake_state/superpowers" "$fixture_root/fresh-unrelated-state"
mv "$fixture_root/main-superpowers-state" "$fake_state/superpowers"

# A selected Git plugin with an unprimed marketplace is unsafe for ordinary
# setup. Debug prompt-input bypasses app startup and must not hide that state.
sed '/^last_revision = /d' "$superpowers_home/config.toml" \
  >"$fixture_root/superpowers-unprimed-config.toml"
mv "$fixture_root/superpowers-unprimed-config.toml" \
  "$superpowers_home/config.toml"
chmod 0600 "$superpowers_home/config.toml"
rm -f "$superpowers_home/.tmp/marketplaces/superpowers-marketplace/.fake-materialized-revision" \
  "$superpowers_home/plugins/.fake-installed-superpowers"
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot debug-prompt-input-unprimed
HOME="$fixture_root/home" fake_env "$fixture_launcher" superpowers \
  debug prompt-input 'bounded debug prompt' \
  || fail 'debug prompt-input simulation failed'
assert_isolation_snapshot_unchanged debug-prompt-input-unprimed

cp "$superpowers_home/config.toml" "$fixture_root/superpowers-unprimed-before-full-app.toml"
assert_command_fails unprimed-full-app env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" superpowers 'bounded full app prompt while unprimed'
grep -F -- 'cdx: post-launch config cleanup refused unrelated mutation: superpowers' \
  "$fixture_root/unprimed-full-app.out" >/dev/null \
  || fail 'unprimed full app cleanup diagnostic differs'
grep -Eq -- '^last_revision = "[0-9a-f]{40}"$' \
  "$superpowers_home/config.toml" \
  && grep -F -- 'app-startup marketplace revision materialized' \
    "$superpowers_home/.tmp/marketplaces/superpowers-marketplace/.fake-materialized-revision" >/dev/null \
  && grep -F -- 'app-startup marketplace-upgrade selected plugin cache materialized' \
    "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" >/dev/null \
  || fail 'refused full app startup did not preserve Codex marketplace mutation'
cp "$fixture_root/superpowers-unprimed-before-full-app.toml" \
  "$superpowers_home/config.toml"
chmod 0600 "$superpowers_home/config.toml"
rm -f "$superpowers_home/.tmp/marketplaces/superpowers-marketplace/.fake-materialized-revision" \
  "$superpowers_home/plugins/.fake-installed-superpowers"
printf '%s\n' 'plugin-add selected plugin cache materialized' \
  >"$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache"

: >"$fixture_root/fake-codex.log"
write_isolation_snapshot setup-selected-unprimed
assert_command_fails setup-selected-unprimed env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" setup superpowers
grep -Fx -- \
  'cdx: selected Git marketplace revision is unprimed: superpowers; run: cdx repair superpowers' \
  "$fixture_root/setup-selected-unprimed.out" >/dev/null \
  || fail 'selected-present unprimed setup diagnostic differs'
assert_isolation_snapshot_unchanged setup-selected-unprimed
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'selected-present unprimed setup mutated lifecycle state'

sed '/^source = "https:\/\/github.com\/obra\/superpowers-marketplace.git"$/a\
last_revision = "invalid-revision"' "$superpowers_home/config.toml" \
  >"$fixture_root/superpowers-invalid-revision.toml"
mv "$fixture_root/superpowers-invalid-revision.toml" \
  "$superpowers_home/config.toml"
chmod 0600 "$superpowers_home/config.toml"
: >"$fixture_root/fake-codex.log"
assert_command_fails setup-selected-invalid-revision env \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" setup superpowers
grep -Fx -- \
  'cdx: selected Git marketplace revision is unprimed: superpowers; run: cdx repair superpowers' \
  "$fixture_root/setup-selected-invalid-revision.out" >/dev/null \
  || fail 'invalid marketplace revision setup diagnostic differs'
sed '/^last_revision = /d' "$superpowers_home/config.toml" \
  >"$fixture_root/superpowers-unprimed-config-again.toml"
mv "$fixture_root/superpowers-unprimed-config-again.toml" \
  "$superpowers_home/config.toml"
chmod 0600 "$superpowers_home/config.toml"

# Repair refuses to upgrade while any unrelated plugin from the same mutable
# marketplace is installed, preserving every selected and unrelated byte.
: >"$fake_state/superpowers/unrelated-same-marketplace"
mkdir -p "$superpowers_home/plugins/cache/superpowers-marketplace/unrelated/1.0.0"
printf '%s\n' 'unrelated cache bytes must stay exact' \
  >"$superpowers_home/plugins/cache/superpowers-marketplace/unrelated/1.0.0/.fake-materialized-cache"
: >"$fixture_root/fake-codex.log"
write_isolation_snapshot repair-unprimed-unrelated-block
assert_command_fails repair-unprimed-unrelated-block env \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" repair superpowers
grep -Fx -- \
  'cdx: cannot prime selected Git marketplace with unrelated installed plugins: superpowers' \
  "$fixture_root/repair-unprimed-unrelated-block.out" >/dev/null \
  || fail 'unrelated same-marketplace repair diagnostic differs'
assert_isolation_snapshot_unchanged repair-unprimed-unrelated-block
jq -se 'all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))' \
  "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'unrelated same-marketplace repair mutated lifecycle state'
rm -f "$fake_state/superpowers/unrelated-same-marketplace"

# Priming failure after selected removal stays diagnosable. The next repair
# retries upgrade before re-adding the selected plugin.
: >"$fixture_root/fake-codex.log"
assert_command_fails repair-selected-unprimed-upgrade-failure env \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_FAIL_MUTATION=marketplace-upgrade \
  "$fixture_launcher" repair superpowers
grep -Fx -- 'cdx: failed to materialize selected Git marketplace: superpowers' \
  "$fixture_root/repair-selected-unprimed-upgrade-failure.out" >/dev/null \
  || fail 'selected-present priming failure diagnostic differs'
[ ! -e "$fake_state/superpowers/plugin" ] \
  || fail 'failed selected-present priming did not leave selected plugin missing'
[ ! -e "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" ] \
  || fail 'failed selected-present priming left selected cache materialized'

: >"$fixture_root/fake-codex.log"
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair superpowers \
  >"$fixture_root/repair-selected-unprimed-retry.out" \
  || fail 'selected-present unprimed repair retry failed'
jq -se '
  [ .[] | select(.args[2] == "upgrade" or .args[1] == "add") | .args ] == [
    ["plugin","marketplace","upgrade","superpowers-marketplace","--json"],
    ["plugin","add","superpowers@superpowers-marketplace","--json"]
  ]
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'selected-present unprimed repair retry order differs'
[ -f "$superpowers_home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" ] \
  || fail 'selected-present unprimed repair did not rematerialize selected cache'

real_mv="$(command -v mv)"
real_ln="$(command -v ln)"

write_custom_main_config "$expected_config"
sed 's/model = "gpt-5.6-sol"/model = "wrong-managed-model"/' \
  "$custom_config" >"$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
assert_command_fails doctor-wrong-managed env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor pstack
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" repair pstack \
  >"$fixture_root/repair-pstack.out" || fail 'repair pstack failed'
cmp -s "$custom_config" "$pstack_home/config.toml" \
  || fail 'repair did not restore managed config and preserve profile-local bytes'
root_key_line="$(grep -Fn 'profile_root_key = "stays-root"' \
  "$pstack_home/config.toml" | cut -d: -f1)"
provider_table_line="$(grep -Fn '[model_providers.copilotproxy]' \
  "$pstack_home/config.toml" | cut -d: -f1)"
[ "$root_key_line" -lt "$provider_table_line" ] \
  || fail 'repair moved a root-level profile-local key into provider table scope'
grep -F -- '[marketplaces.pstack-for-codex-local]' "$pstack_home/config.toml" >/dev/null \
  && grep -F -- '[marketplaces.user-owned]' "$pstack_home/config.toml" >/dev/null \
  && grep -F -- 'source = "C:\\Users\"quoted\""' \
    "$pstack_home/config.toml" >/dev/null \
  && grep -F -- '[plugins."unrelated@user-owned"]' \
    "$pstack_home/config.toml" >/dev/null \
  && grep -F -- 'source = "\uD7FF\uE000\U0010FFFF"' \
    "$pstack_home/config.toml" >/dev/null \
  && grep -F -- '[plugins."valid\u002Dplugin@user-owned"]' \
    "$pstack_home/config.toml" >/dev/null \
  && grep -F -- 'future_scalar = "preserve-marketplace-field"' \
    "$pstack_home/config.toml" >/dev/null \
  && grep -F -- 'future_flag = true' "$pstack_home/config.toml" >/dev/null \
  || fail 'repair lost selected or unrelated native config state'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'repair created host authentication'
auth_is_absent "$pstack_home/auth.json" || fail 'repair created profile authentication'
[ "$(file_mode "$pstack_home/config.toml")" = '600' ] \
  || fail 'repair did not enforce config mode 0600'

real_cp="$(command -v cp)"
real_chmod="$(command -v chmod)"
real_sed="$(command -v sed)"
cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CP" "$@" || exit $?
case "${2:-}" in
  */.config-snapshot.*)
    "$CDX_TEST_REAL_SED" 's/2026-07-30T21:16:34Z/2026-07-30T21:16:35Z/' \
      "$CDX_TEST_CONFIG_TARGET" >"$CDX_TEST_CONFIG_EXTERNAL" || exit $?
    "$CDX_TEST_REAL_MV" "$CDX_TEST_CONFIG_EXTERNAL" \
      "$CDX_TEST_CONFIG_TARGET" || exit $?
    ;;
esac
EOF
chmod +x "$fake_bin/cp"
sed 's/model = "gpt-5.6-sol"/model = "snapshot-race-model"/' \
  "$custom_config" >"$pstack_home/config.toml"
sed 's/2026-07-30T21:16:34Z/2026-07-30T21:16:35Z/' \
  "$pstack_home/config.toml" >"$fixture_root/config-snapshot-race-expected.toml"
assert_command_fails config-snapshot-race env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" CDX_TEST_REAL_CP="$real_cp" \
  CDX_TEST_REAL_SED="$real_sed" CDX_TEST_REAL_MV="$real_mv" \
  CDX_TEST_CONFIG_TARGET="$pstack_home/config.toml" \
  CDX_TEST_CONFIG_EXTERNAL="$fixture_root/config-snapshot-race-external.toml" \
  "$fixture_launcher" repair pstack
grep -F -- 'cdx: profile config changed during snapshot: pstack' \
  "$fixture_root/config-snapshot-race.out" >/dev/null \
  || fail 'snapshot-race diagnostic differs'
cmp -s "$fixture_root/config-snapshot-race-expected.toml" \
  "$pstack_home/config.toml" || fail 'snapshot race overwrote external config bytes'
[ -z "$(find "$pstack_home" -maxdepth 1 -name '.config*' -print -quit)" ] \
  || fail 'snapshot race left config staging debris'
rm "$fake_bin/cp"

cat >"$fake_bin/chmod" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CHMOD" "$@" || exit $?
for argument in "$@"; do
  case "$argument" in
    */.config-snapshot.*) ;;
    */.config.*)
      "$CDX_TEST_REAL_SED" 's/2026-07-30T21:16:34Z/2026-07-30T21:16:36Z/' \
        "$CDX_TEST_CONFIG_TARGET" >"$CDX_TEST_CONFIG_EXTERNAL" || exit $?
      "$CDX_TEST_REAL_MV" "$CDX_TEST_CONFIG_EXTERNAL" \
        "$CDX_TEST_CONFIG_TARGET" || exit $?
      ;;
  esac
done
EOF
chmod +x "$fake_bin/chmod"
sed 's/model = "gpt-5.6-sol"/model = "publish-race-model"/' \
  "$custom_config" >"$pstack_home/config.toml"
sed 's/2026-07-30T21:16:34Z/2026-07-30T21:16:36Z/' \
  "$pstack_home/config.toml" >"$fixture_root/config-publish-race-expected.toml"
assert_command_fails config-publish-race env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" CDX_TEST_REAL_CHMOD="$real_chmod" \
  CDX_TEST_REAL_SED="$real_sed" CDX_TEST_REAL_MV="$real_mv" \
  CDX_TEST_CONFIG_TARGET="$pstack_home/config.toml" \
  CDX_TEST_CONFIG_EXTERNAL="$fixture_root/config-publish-race-external.toml" \
  "$fixture_launcher" repair pstack
grep -F -- 'cdx: profile config changed during repair: pstack' \
  "$fixture_root/config-publish-race.out" >/dev/null \
  || fail 'publish-race diagnostic differs'
cmp -s "$fixture_root/config-publish-race-expected.toml" \
  "$pstack_home/config.toml" || fail 'publish race overwrote external config bytes'
[ -z "$(find "$pstack_home" -maxdepth 1 -name '.config*' -print -quit)" ] \
  || fail 'publish race left config staging debris'
rm "$fake_bin/chmod"
cp "$custom_config" "$pstack_home/config.toml"

real_cat="$(command -v cat)"
cat >"$fake_bin/cat" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -eq 0 ]; then
  exit 86
fi
exec "$CDX_TEST_REAL_CAT" "$@"
EOF
chmod +x "$fake_bin/cat"
sed 's/model = "gpt-5.6-sol"/model = "write-failure-model"/' \
  "$custom_config" >"$pstack_home/config.toml"
cp "$pstack_home/config.toml" "$fixture_root/config-write-failure-before.toml"
assert_command_fails config-write-failure env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" CDX_TEST_REAL_CAT="$real_cat" \
  "$fixture_launcher" repair pstack
grep -F -- 'cdx: failed to write profile config' \
  "$fixture_root/config-write-failure.out" >/dev/null \
  || fail 'config write-failure diagnostic differs'
cmp -s "$fixture_root/config-write-failure-before.toml" \
  "$pstack_home/config.toml" || fail 'config write failure published partial bytes'
[ -z "$(find "$pstack_home" -maxdepth 1 -name '.config*' -print -quit)" ] \
  || fail 'config write failure left staging debris'
rm "$fake_bin/cat"
cp "$custom_config" "$pstack_home/config.toml"

cp "$pstack_home/config.toml" "$fixture_root/config-valid"

marker_migration="$fixture_root/config-marker-migration.toml"
{
  sed -n '1,/^wire_api = "responses"$/p' "$custom_config"
  printf '\n'
  sed -n '/^\[marketplaces\.pstack-for-codex-local\]$/,/^enabled = true$/p' \
    "$custom_config"
  printf '%s\n\n' '# trellage-managed-codex-provider-end'
  printf '%s\n' '# trellage-codex-native-marketplaces-begin'
  sed -n '/^\[marketplaces\.user-owned\]$/,/# trellage-managed-codex-provider-end/p' \
    "$custom_config" | sed '$d'
  printf '%s\n' '# trellage-codex-native-marketplaces-end'
} >"$marker_migration"
cp "$marker_migration" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"
assert_command_fails doctor-marker-migration env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor pstack
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair pstack \
  >"$fixture_root/repair-marker-migration.out" \
  || fail 'repair rejected bounded marker migration layout'
cmp -s "$custom_config" "$pstack_home/config.toml" \
  || fail 'marker migration did not merge and preserve both native tails'
cp "$pstack_home/config.toml" "$fixture_root/config-valid"

assert_invalid_markers_rejected() {
  label="$1"
  before="$fixture_root/config-before-$label"
  cp "$pstack_home/config.toml" "$before"
  inode="$(file_inode "$pstack_home/config.toml")"
  assert_command_fails "doctor-$label" env HOME="$fixture_root/home" \
    "$fixture_launcher" doctor pstack
  assert_command_fails "repair-$label" env HOME="$fixture_root/home" \
    "$fixture_launcher" repair pstack
  cmp -s "$before" "$pstack_home/config.toml" \
    || fail "repair changed invalid $label config bytes"
  [ "$(file_inode "$pstack_home/config.toml")" = "$inode" ] \
    || fail "repair changed invalid $label config inode"
  [ -z "$(find "$pstack_home" -maxdepth 1 -name '.config*' -print -quit)" ] \
    || fail "repair left staging debris for $label"
}

grep -Fv '# trellage-profile-local-config-end' "$fixture_root/config-valid" \
  >"$pstack_home/config.toml"
assert_invalid_markers_rejected missing-marker
cp "$fixture_root/config-valid" "$pstack_home/config.toml"
printf '%s\n' '# trellage-profile-local-config-begin' >>"$pstack_home/config.toml"
assert_invalid_markers_rejected duplicate-marker
sed \
  -e 's/# trellage-profile-local-config-begin/# local-marker-temporary/' \
  -e 's/# trellage-profile-local-config-end/# trellage-profile-local-config-begin/' \
  -e 's/# local-marker-temporary/# trellage-profile-local-config-end/' \
  "$fixture_root/config-valid" >"$pstack_home/config.toml"
assert_invalid_markers_rejected out-of-order-markers
sed 's/\[marketplaces\.user-owned\]/[plugins.user-owned]/' \
  "$fixture_root/config-valid" >"$pstack_home/config.toml"
assert_invalid_markers_rejected non-marketplace-native-table
invalid_native_block="$fixture_root/invalid-native-block.toml"
write_config_with_invalid_native() {
  {
    sed '$d' "$fixture_root/config-valid"
    cat "$invalid_native_block"
    printf '%s\n' '# trellage-managed-codex-provider-end'
  } >"$pstack_home/config.toml"
}
cat >"$invalid_native_block" <<'EOF'
[marketplaces.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]
safe = true
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected oversized-native-marketplace-name
cat >"$invalid_native_block" <<'EOF'

[projects."/unsupported/trust"]
trust_level = "untrusted"
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected unsupported-native-project-trust
cat >"$invalid_native_block" <<'EOF'

[projects."/unsupported/extra-field"]
trust_level = "trusted"
extra = true
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected native-project-extra-field
cat >"$invalid_native_block" <<'EOF'
[plugins."Unsafe@user-owned"]
safe = true
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected unsafe-native-plugin-name
sed 's|source = "example/user-owned"|source = "bad\\q"|' \
  "$fixture_root/config-valid" >"$pstack_home/config.toml"
assert_invalid_markers_rejected malformed-marketplace-source-escape
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-scalar]
last_updated = "2026-07-30T20:15:36Z"
source_type = "local"
source = "\uD800"
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected surrogate-marketplace-source-escape
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-scalar]
last_updated = "2026-07-30T20:15:36Z"
source_type = "local"
source = "\U00110000"
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected out-of-range-marketplace-source-escape
sed '/source = "example\/user-owned"/c\
source = "safe"\
[plugins.table-breakout]
' "$fixture_root/config-valid" >"$pstack_home/config.toml"
assert_invalid_markers_rejected marketplace-source-table-breakout
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-syntax]
unsafe.key = "value"
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected dotted-native-field-name
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-syntax]
Unsafe = "value"
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected uppercase-native-field-name
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-syntax]
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = "value"
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected oversized-native-field-name
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-syntax]
unsafe = ["array"]
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected native-array-value
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-syntax]
unsafe = { value = true }
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected native-inline-table-value
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-syntax]
unsafe = 1
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected unsupported-native-number-value
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-syntax]
unsafe = """multiline"""
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected native-multiline-string-value
cat >"$invalid_native_block" <<'EOF'
[marketplaces.invalid-syntax]
safe = "first"
safe = "second"
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected duplicate-native-field-name
sed '/# trellage-managed-codex-provider-end/i\
[plugins."pstack-for-codex@pstack-for-codex-local"]\
enabled = true' "$fixture_root/config-valid" >"$pstack_home/config.toml"
assert_invalid_markers_rejected duplicate-native-plugin-table
cat >"$invalid_native_block" <<'EOF'
[plugins."valid-plugin@user-owned"]
enabled = false
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected escaped-equivalent-native-plugin-table
cat >"$invalid_native_block" <<'EOF'
[plugins."bad\q@user-owned"]
enabled = true
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected malformed-native-plugin-escape
cat >"$invalid_native_block" <<'EOF'
[plugins."bad\uD800@user-owned"]
enabled = true
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected surrogate-native-plugin-escape
cat >"$invalid_native_block" <<'EOF'
[plugins."empty@user-owned"]
EOF
write_config_with_invalid_native
assert_invalid_markers_rejected empty-native-plugin-table
sed '/\[plugins\."unrelated@user-owned"\]/{n;s/$/\nenabled = false/;}' \
  "$fixture_root/config-valid" >"$pstack_home/config.toml"
assert_invalid_markers_rejected duplicate-native-plugin-enabled
sed '/# trellage-codex-native-marketplaces-end/i\
[plugins."pstack-for-codex@pstack-for-codex-local"]\
enabled = true' "$marker_migration" >"$pstack_home/config.toml"
assert_invalid_markers_rejected duplicate-plugin-across-marker-regions
sed '/# trellage-managed-codex-provider-end/a\
unexpected-native-tail-content' "$marker_migration" >"$pstack_home/config.toml"
assert_invalid_markers_rejected invalid-marker-layout-separator
grep -Fv '# trellage-codex-native-marketplaces-end' "$marker_migration" \
  >"$pstack_home/config.toml"
assert_invalid_markers_rejected partial-marker-migration-layout
sed '/\[marketplaces\.pstack-for-codex-local\]/i\
provider_api_key = "must-reject"
' \
  "$fixture_root/config-valid" >"$pstack_home/config.toml"
assert_invalid_markers_rejected bare-provider-assignment-before-marketplace
cp "$fixture_root/config-valid" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

sed 's/model = "gpt-5.6-sol"/model = "publication-must-fail"/' \
  "$fixture_root/config-valid" >"$pstack_home/config.toml"
cp "$pstack_home/config.toml" "$fixture_root/config-before-publication-failure"
config_inode="$(file_inode "$pstack_home/config.toml")"
outside_config="$fixture_root/outside-config"
: >"$outside_config"
cat >"$fake_bin/chmod" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CHMOD" "$@" || exit $?
for argument in "$@"; do
  case "$argument" in
    */.config.*)
      "$CDX_TEST_REAL_MV" "$CDX_TEST_CONFIG_TARGET" "$CDX_TEST_CONFIG_SAVED" || exit $?
      "$CDX_TEST_REAL_LN" -s "$CDX_TEST_CONFIG_OUTSIDE" "$CDX_TEST_CONFIG_TARGET" || exit $?
      ;;
  esac
done
EOF
chmod +x "$fake_bin/chmod"
assert_command_fails config-post-stage-safety env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" CDX_TEST_REAL_CHMOD="$real_chmod" \
  CDX_TEST_REAL_MV="$real_mv" CDX_TEST_REAL_LN="$real_ln" \
  CDX_TEST_CONFIG_TARGET="$pstack_home/config.toml" \
  CDX_TEST_CONFIG_SAVED="$fixture_root/config-post-stage.saved" \
  CDX_TEST_CONFIG_OUTSIDE="$outside_config" "$fixture_launcher" repair pstack
grep -F -- "cdx: unsafe profile config path: $pstack_home/config.toml" \
  "$fixture_root/config-post-stage-safety.out" >/dev/null \
  || fail 'config post-stage safety diagnostic differs'
rm "$pstack_home/config.toml"
mv "$fixture_root/config-post-stage.saved" "$pstack_home/config.toml"
cmp -s "$fixture_root/config-before-publication-failure" "$pstack_home/config.toml" \
  || fail 'config post-stage safety failure changed prior bytes'
[ "$(file_inode "$pstack_home/config.toml")" = "$config_inode" ] \
  || fail 'config post-stage safety failure changed prior inode'
[ -z "$(find "$pstack_home" -maxdepth 1 -name '.config.*' -print -quit)" ] \
  || fail 'config post-stage safety failure left staging debris'
rm "$fake_bin/chmod"

cat >"$fake_bin/chmod" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CHMOD" "$@" || exit $?
for argument in "$@"; do
  case "$argument" in
    */.config.*) kill -TERM "$PPID" ;;
  esac
done
EOF
chmod +x "$fake_bin/chmod"
assert_command_fails config-stage-signal env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" CDX_TEST_REAL_CHMOD="$real_chmod" \
  "$fixture_launcher" repair pstack
cmp -s "$fixture_root/config-before-publication-failure" "$pstack_home/config.toml" \
  || fail 'config stage signal changed prior bytes'
[ "$(file_inode "$pstack_home/config.toml")" = "$config_inode" ] \
  || fail 'config stage signal changed prior inode'
[ -z "$(find "$pstack_home" -maxdepth 1 -name '.config.*' -print -quit)" ] \
  || fail 'config stage signal left staging debris'
rm "$fake_bin/chmod"

cat >"$fake_bin/mv" <<'EOF'
#!/usr/bin/env bash
for argument in "$@"; do
  case "${CDX_TEST_FAIL_MV:-}:$argument" in
    config:*/.config.*) exit 74 ;;
  esac
done
exec "$CDX_TEST_REAL_MV" "$@"
EOF
chmod +x "$fake_bin/mv"
assert_command_fails config-publication-failure env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" CDX_TEST_REAL_MV="$real_mv" CDX_TEST_FAIL_MV=config \
  "$fixture_launcher" repair pstack
cmp -s "$fixture_root/config-before-publication-failure" "$pstack_home/config.toml" \
  || fail 'failed config publication changed prior bytes'
[ "$(file_inode "$pstack_home/config.toml")" = "$config_inode" ] \
  || fail 'failed config publication changed prior inode'
[ -z "$(find "$pstack_home" -maxdepth 1 -name '.config.*' -print -quit)" ] \
  || fail 'failed config publication left staging debris'
rm "$fake_bin/mv"
cp "$fixture_root/config-valid" "$pstack_home/config.toml"
chmod 0600 "$pstack_home/config.toml"

config_inode="$(file_inode "$pstack_home/config.toml")"
sed 's/model = "gpt-5.6-sol"/model = "setup-must-not-replace"/' \
  "$fixture_root/config-valid" >"$pstack_home/config.toml"
cp "$pstack_home/config.toml" "$fixture_root/config-before-setup"
assert_command_fails setup-does-not-replace env HOME="$fixture_root/home" \
  "$fixture_launcher" setup pstack
cmp -s "$fixture_root/config-before-setup" "$pstack_home/config.toml" \
  || fail 'setup replaced existing profile config'
cp "$fixture_root/config-valid" "$pstack_home/config.toml"
chmod 0644 "$pstack_home/config.toml"
assert_command_fails config-mode env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor pstack
chmod 0600 "$pstack_home/config.toml"

mv "$pstack_home/config.toml" "$fixture_root/config-target.saved"
ln -s "$fixture_root/config-target.saved" "$pstack_home/config.toml"
assert_command_fails symlink-config env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor pstack
rm "$pstack_home/config.toml"
mv "$fixture_root/config-target.saved" "$pstack_home/config.toml"

mv "$pstack_home/config.toml" "$fixture_root/config-target.saved"
mkdir "$pstack_home/config.toml"
assert_command_fails non-regular-config env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor pstack
rmdir "$pstack_home/config.toml"
mv "$fixture_root/config-target.saved" "$pstack_home/config.toml"

race_home="$fixture_root/config-race-home"
prepare_test_home "$race_home"
race_source="$fixture_root/concurrent-config-winner"
printf '%s\n' 'concurrent = "winner"' >"$race_source"
chmod 0640 "$race_source"
race_source_inode="$(file_inode "$race_source")"
cat >"$fake_bin/chmod" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CHMOD" "$@" || exit $?
for argument in "$@"; do
  case "$argument" in
    */.config.*)
      target="${argument%/.config.*}/config.toml"
      "$CDX_TEST_REAL_LN" "$CDX_TEST_RACE_SOURCE" "$target" || exit $?
      ;;
  esac
done
EOF
chmod +x "$fake_bin/chmod"
assert_command_fails config-create-race env HOME="$race_home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" CDX_TEST_REAL_CHMOD="$real_chmod" \
  CDX_TEST_REAL_LN="$real_ln" CDX_TEST_RACE_SOURCE="$race_source" \
  "$fixture_launcher" setup pstack
race_config="$race_home/.local/share/trellage/profiles/codex/pstack/home/config.toml"
grep -F -- 'cdx: failed to publish profile config without replacing existing file' \
  "$fixture_root/config-create-race.out" >/dev/null \
  || fail 'config create race diagnostic differs'
cmp -s "$race_source" "$race_config" || fail 'config create race replaced concurrent bytes'
[ "$(file_inode "$race_config")" = "$race_source_inode" ] \
  || fail 'config create race replaced concurrent inode'
[ "$(file_mode "$race_config")" = '640' ] \
  || fail 'config create race changed concurrent mode'
race_profile_home="${race_config%/config.toml}"
[ -z "$(find "$race_profile_home" -maxdepth 1 -name '.config.*' -print -quit)" ] \
  || fail 'config create race left staging debris'
rm "$fake_bin/chmod"

unsafe_home="$fixture_root/unsafe-home"
prepare_test_home "$unsafe_home"
mkdir "$fixture_root/unsafe-home-target"
mv "$unsafe_home" "$fixture_root/unsafe-home-real"
ln -s "$fixture_root/unsafe-home-real" "$unsafe_home"
assert_command_fails symlink-home env HOME="$unsafe_home" "$fixture_launcher" setup pstack

unsafe_local_home="$fixture_root/unsafe-local-home"
prepare_test_home "$unsafe_local_home"
mkdir "$fixture_root/unsafe-local-target"
ln -s "$fixture_root/unsafe-local-target" "$unsafe_local_home/.local"
assert_command_fails symlink-parent env HOME="$unsafe_local_home" \
  "$fixture_launcher" setup superpowers

collision_home="$fixture_root/collision-home"
prepare_test_home "$collision_home"
: >"$collision_home/.local"
assert_command_fails non-directory-component env HOME="$collision_home" \
  "$fixture_launcher" setup pstack

symlink_profile_home="$fixture_root/symlink-profile-home"
prepare_test_home "$symlink_profile_home"
mkdir -p "$symlink_profile_home/.local/share/trellage/profiles/codex"
mkdir "$fixture_root/profile-target"
ln -s "$fixture_root/profile-target" \
  "$symlink_profile_home/.local/share/trellage/profiles/codex/pstack"
assert_command_fails symlink-profile-component env HOME="$symlink_profile_home" \
  "$fixture_launcher" setup pstack

symlink_leaf_home="$fixture_root/symlink-leaf-home"
prepare_test_home "$symlink_leaf_home"
mkdir -p "$symlink_leaf_home/.local/share/trellage/profiles/codex/superpowers"
mkdir "$fixture_root/leaf-target"
ln -s "$fixture_root/leaf-target" \
  "$symlink_leaf_home/.local/share/trellage/profiles/codex/superpowers/home"
assert_command_fails symlink-home-component env HOME="$symlink_leaf_home" \
  "$fixture_launcher" setup superpowers

fresh_home="$fixture_root/fresh-home"
prepare_test_home "$fresh_home"
codex_count="$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')"
if ! HOME="$fresh_home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" pstack --version \
  >"$fixture_root/launch-self-heals-before-setup.out" 2>&1; then
  fail 'launch before setup did not self-heal'
fi
[ "$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')" -gt "$codex_count" ] \
  || fail 'self-healed launch did not invoke Codex'
tail -n1 "$fixture_root/fake-codex.log" | jq -e '.args[-1] == "--version"' >/dev/null \
  || fail 'self-healed launch did not end with the requested launch invocation'
[ -d "$fresh_home/.local/share/trellage/profiles/codex/pstack/home" ] \
  || fail 'self-healed launch did not materialize the profile home'
codex_count="$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')"
assert_command_fails native-launch-before-setup env HOME="$fresh_home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_CODEX_LOGIN_STATUS=0 \
  "$fixture_launcher" --native-auth superpowers --version
# Native launch checks host login/auth-source availability before self-healing the
# profile home, so a legitimate `login status` probe is invoked (and logged) even
# though the launch ultimately fails on the missing native auth source; the profile
# must not have been self-healed as a side effect of that failed launch.
[ "$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')" -gt "$codex_count" ] \
  || fail 'native-auth precheck did not run Codex login status'
[ -d "$fresh_home/.local/share/trellage/profiles/codex/superpowers/home" ] \
  && fail 'missing native auth unexpectedly self-healed the profile home'
codex_count="$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')"
assert_command_fails unsafe-profile-slug env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" '../pstack' --version
[ "$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')" = "$codex_count" ] \
  || fail 'unsafe profile slug invoked Codex'

ln -s "$fixture_launcher" "$fake_bin/codex-recursive"
mv "$fake_bin/codex" "$fake_bin/codex-real"
ln -s "$fixture_launcher" "$fake_bin/codex"
assert_command_fails recursive-launcher env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" pstack --version
rm "$fake_bin/codex"
mv "$fake_bin/codex-real" "$fake_bin/codex"

jq -se '
  all(.[] | select(.args[0] == "--sandbox");
    ((.args | join(" ")) | test("marketplace add|plugin add|marketplace upgrade|plugin remove") | not))
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'launch invoked a forbidden marketplace or plugin mutation'

printf 'trellage Codex auth contract: PASS\n'
printf 'trellage Codex config contract: PASS\n'
printf 'trellage Codex launch contract: PASS\n'