#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(cd "$prototype_dir/../.." && pwd -P)"
entry="$prototype_dir/runtime-headlong-entry.sh"
root="$repo_root/.agent_work/headlong-entry-contract-$$"
fixture_ref='mcr.microsoft.com/devcontainers/javascript-node@sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af'
home_volume=''

cleanup() {
  local status=$?
  if [[ -d "$root" ]] && docker image inspect "$fixture_ref" >/dev/null 2>&1; then
    docker run --rm --network none --user '0:0' \
      --entrypoint /bin/chmod \
      --mount "type=bind,src=$root,dst=/cleanup" \
      "$fixture_ref" -R a+rwX /cleanup >/dev/null 2>&1 || true
  fi
  [[ -z "$home_volume" ]] || docker volume rm -f "$home_volume" >/dev/null 2>&1 || true
  rm -rf -- "$root"
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'Headlong entry contract: FAIL: %s\n' "$1" >&2
  exit 1
}

docker image inspect "$fixture_ref" >/dev/null 2>&1 \
  || fail "offline fixture image is unavailable: $fixture_ref"

seed="$root/seed"
seed_commit="$root/seed.commit"
skill_seed="$root/skill-seed"
home="$root/home"
output="$root/output"
fake_bin="$root/fake-bin"
control="$root/control"
tui_binary="$root/headlong-tui"
mkdir -p \
  "$seed/tools" "$seed/bin" "$seed/identities" \
  "$skill_seed/skills/always-on" "$skill_seed/skills/on-demand" \
  "$home" "$output" "$fake_bin" "$control"
chmod 777 "$home" "$output" "$control"
home_mount="type=bind,src=$home,dst=/home/agent"
if [[ "$(uname -s)" == Darwin ]]; then
  home_volume="trellage-headlong-entry-contract-$$"
  docker volume create "$home_volume" >/dev/null
  docker run --rm --network none --user '0:0' \
    --entrypoint /bin/chmod \
    --mount "type=volume,src=$home_volume,dst=/home/agent" \
    "$fixture_ref" 0777 /home/agent
  home_mount="type=volume,src=$home_volume,dst=/home/agent"
fi
printf '#!/usr/bin/env bash\nprintf "headlong tui\\n"\n' >"$tui_binary"
chmod 755 "$tui_binary"
printf 'seed one\n' >"$seed/README.md"
printf '%s\n' '.env' '.identities/' 'status.json' 'logs/' 'run/' >"$seed/.gitignore"
printf '#!/usr/bin/env bash\nexit 99\n' >"$seed/bin/llm"
chmod 755 "$seed/bin/llm"
# Marks this seed as a real checkout (mirrors upstream install.sh's own
# bootstrap-vs-checkout detection) so the fake installer below can refuse to
# run unless it is invoked directly against the verified local checkout.
: >"$seed/bin/shellm"
chmod 755 "$seed/bin/shellm"
printf '# Always On\n' >"$skill_seed/skills/always-on/SKILL.md"
printf '# On Demand\n' >"$skill_seed/skills/on-demand/SKILL.md"
printf 'always-on\t1\non-demand\t0\n' >"$skill_seed/managed-skills.tsv"
printf '1111111111111111111111111111111111111111\n' >"$seed_commit"
chmod 666 "$seed_commit"

cat >"$seed/tools/headlong-init" <<'FAKE_INIT'
#!/usr/bin/env bash
set -euo pipefail
umask 022
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "${HEADLONG_NO_THINKERS-}" \
  "${HEADLONG_NO_DASH-}" \
  "${HEADLONG_NO_TTY-}" \
  "${HEADLONG_WEB_ARGS-}" \
  "${ANTHROPIC_API_KEY-}" \
  "${OPENAI_API_KEY-}" \
  "${GEMINI_API_KEY-}" \
  "${OPENROUTER_API_KEY-}" >>"$TRELLAGE_TEST_OUTPUT/init.log"
printf '%s\t%s\t%s\n' "${LLM_API_URL-}" "${SHELLM_API_URL-}" "${SHELLM_MODEL-}" >>"$TRELLAGE_TEST_OUTPUT/proxy.log"
chmod 0666 "$TRELLAGE_TEST_OUTPUT/init.log" "$TRELLAGE_TEST_OUTPUT/proxy.log"
[[ "${HEADLONG_HOME-}" == /home/agent/.headlong ]]
[[ "${HEADLONG_APP_DIR-}" == /home/agent/.headlong/app ]]
[[ "${HEADLONG_UNSANDBOXED-}" == 1 ]]
[[ "$(command -v llm)" == /home/agent/.headlong/app/bin/llm ]]
if [[ "${HEADLONG_NO_TTY-}" == 1 && -f /test-control/block-restore ]]; then
  : >"$TRELLAGE_TEST_OUTPUT/restore.started"
  sleep 300
fi
mkdir -p \
  "$HEADLONG_APP_DIR/.identities/ada/skills" \
  "$HEADLONG_APP_DIR/.identities/ada/kernel"
if [[ ! -L "$HEADLONG_APP_DIR/.identities/default" ]]; then
  ln -s ada "$HEADLONG_APP_DIR/.identities/default"
fi
# Only bootstrap (the sole phase provider credentials may reach) ever writes
# the private .env; later phases must find it already there, untouched.
if [[ ! -s "$HEADLONG_HOME/.env" ]]; then
  printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY-}" >"$HEADLONG_HOME/.env"
fi
# Mirror upstream _env_set: chmod 600 unless a test deliberately asks this
# fixture to drift the mode, to prove the runtime rejects rather than
# silently repairs a wrong mode left by the initializer itself.
if [[ -f /test-control/env-mode-wrong ]]; then
  chmod 0644 "$HEADLONG_HOME/.env"
else
  chmod 0600 "$HEADLONG_HOME/.env"
fi
# Mirror pinned headlong-init: create the identity-name persona link beside
# the invoked $0 (the installed entry point), never inside the app tree.
entry_dir="$(dirname -- "$0")"
if [[ ! -L "$entry_dir/ada" ]]; then
  ln -s persona "$entry_dir/ada"
fi
FAKE_INIT
chmod 755 "$seed/tools/headlong-init"

cat >"$seed/bin/persona" <<'FAKE_PERSONA'
#!/usr/bin/env bash
set -euo pipefail
umask 022
if [[ "${1:-}" == dash ]]; then
  printf 'dash\n' >>"$TRELLAGE_TEST_OUTPUT/dash.log"
  chmod 0666 "$TRELLAGE_TEST_OUTPUT/dash.log"
  mkdir -p "$HEADLONG_HOME/run"
  sleep 300 &
  printf '%s\n' "$!" >"$HEADLONG_HOME/run/web.pid"
  printf 'http://0.0.0.0:8080\n'
  exit 0
fi
exit 98
FAKE_PERSONA
chmod 755 "$seed/bin/persona"

cat >"$seed/install.sh" <<'FAKE_INSTALL'
#!/usr/bin/env bash
set -euo pipefail
umask 022
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Mirror upstream install.sh: only a checkout (bin/shellm present) may
# install directly; anything else would be the forbidden network bootstrap.
if [[ ! -f "$script_dir/bin/shellm" ]]; then
  printf 'bootstrap-reexec\n' >>"$TRELLAGE_TEST_OUTPUT/install-bootstrap.log"
  exit 1
fi
if [[ -f /test-control/fail-install ]]; then
  printf 'forced-failure\n' >>"$TRELLAGE_TEST_OUTPUT/install.log"
  chmod 0666 "$TRELLAGE_TEST_OUTPUT/install.log"
  exit 1
fi
[[ "$#" -eq 4 && "$1" == --symlinks && "$2" == --prefix \
  && "$3" == /home/agent/.local/bin && "$4" == --no-init ]] \
  || {
    printf 'unexpected-args:%s\n' "$*" >>"$TRELLAGE_TEST_OUTPUT/install.log"
    chmod 0666 "$TRELLAGE_TEST_OUTPUT/install.log"
    exit 1
  }
printf '%s\t%s\n' "$PWD" "$*" >>"$TRELLAGE_TEST_OUTPUT/install.log"
chmod 0666 "$TRELLAGE_TEST_OUTPUT/install.log"
mkdir -p -- "$3"
ln -sf "$script_dir/bin/llm" "$3/llm"
# Mirror pinned install.sh --symlinks: it installs the entry point the
# initializer phases invoke, and the persona binary identity links target.
ln -sf "$script_dir/tools/headlong-init" "$3/headlong-init"
ln -sf "$script_dir/bin/persona" "$3/persona"
FAKE_INSTALL
chmod 755 "$seed/install.sh"
# Mutation cases mount these host-created fixtures as UID 10001. Keep the
# production-facing mounts read-only, but let the test owner inside Linux
# containers revise the fixture between runs.
chmod -R a+rwX "$seed" "$skill_seed"

cat >"$fake_bin/attach-shell" <<'FAKE_SHELL'
#!/usr/bin/env bash
set -euo pipefail
umask 022
# The public seam: an attached shell must never observe a provider
# credential, regardless of which phase or branch preceded it.
for var in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY \
  LLM_API_URL SHELLM_API_URL SHELLM_MODEL; do
  [[ -z "${!var-}" ]] || { printf 'leaked:%s\n' "$var" >&2; exit 97; }
done
printf '%s\n' "$PWD" >"$TRELLAGE_TEST_OUTPUT/shell.cwd"
printf '%s\n' "$@" >"$TRELLAGE_TEST_OUTPUT/shell.argv"
chmod 0666 "$TRELLAGE_TEST_OUTPUT/shell.cwd" "$TRELLAGE_TEST_OUTPUT/shell.argv"
FAKE_SHELL
chmod 755 "$fake_bin/attach-shell"

run_entry() {
  local status=0
  docker run --rm \
    --network none \
    --read-only \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$entry,dst=/test/runtime-headlong-entry.sh,readonly" \
    --mount "type=bind,src=$seed,dst=/usr/local/share/trellage/headlong-seed,readonly" \
    --mount "type=bind,src=$seed_commit,dst=/usr/local/share/trellage/headlong-seed.commit,readonly" \
    --mount "type=bind,src=$skill_seed,dst=/usr/local/share/trellage/headlong-skills,readonly" \
    --mount "type=bind,src=$tui_binary,dst=/usr/local/share/trellage/headlong-tui,readonly" \
    --mount "$home_mount" \
    --mount "type=bind,src=$output,dst=/test-output" \
    --mount "type=bind,src=$fake_bin,dst=/test-bin,readonly" \
    --mount "type=bind,src=$control,dst=/test-control" \
    --env 'PATH=/test-bin:/usr/local/bin:/usr/bin:/bin' \
    --env 'SHELL=/test-bin/attach-shell' \
    --env 'TRELLAGE_TEST_OUTPUT=/test-output' \
    --env "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY-}" \
    --env "OPENAI_API_KEY=${OPENAI_API_KEY-}" \
    --env "GEMINI_API_KEY=${GEMINI_API_KEY-}" \
    --env "OPENROUTER_API_KEY=${OPENROUTER_API_KEY-}" \
    "$fixture_ref" /test/runtime-headlong-entry.sh "$@" 2>"$output/stderr.log" || status=$?
  return "$status"
}

run_service_for() {
  local seconds="$1"
  local status=0
  shift
  docker run --rm \
    --network none \
    --read-only \
    --user '10001:10001' \
    --entrypoint /usr/bin/timeout \
    --mount "type=bind,src=$entry,dst=/test/runtime-headlong-entry.sh,readonly" \
    --mount "type=bind,src=$seed,dst=/usr/local/share/trellage/headlong-seed,readonly" \
    --mount "type=bind,src=$seed_commit,dst=/usr/local/share/trellage/headlong-seed.commit,readonly" \
    --mount "type=bind,src=$skill_seed,dst=/usr/local/share/trellage/headlong-skills,readonly" \
    --mount "type=bind,src=$tui_binary,dst=/usr/local/share/trellage/headlong-tui,readonly" \
    --mount "$home_mount" \
    --mount "type=bind,src=$output,dst=/test-output" \
    --mount "type=bind,src=$fake_bin,dst=/test-bin,readonly" \
    --mount "type=bind,src=$control,dst=/test-control" \
    --env 'PATH=/test-bin:/usr/local/bin:/usr/bin:/bin' \
    --env 'TRELLAGE_TEST_OUTPUT=/test-output' \
    "$fixture_ref" "$seconds" /test/runtime-headlong-entry.sh service "$@" \
    || status=$?
  [[ "$status" -eq 124 ]] || return "$status"
}

in_fixture() {
  docker run --rm --network none --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "$home_mount" \
    --mount "type=bind,src=$output,dst=/test-output" \
    --mount "type=bind,src=$seed,dst=/usr/local/share/trellage/headlong-seed" \
    --mount "type=bind,src=$seed_commit,dst=/usr/local/share/trellage/headlong-seed.commit" \
    --mount "type=bind,src=$skill_seed,dst=/usr/local/share/trellage/headlong-skills" \
    --mount "type=bind,src=$tui_binary,dst=/usr/local/share/trellage/headlong-tui" \
    --mount "type=bind,src=$control,dst=/test-control" \
    "$fixture_ref" -ceu "$1"
}

status=0
run_entry invalid || status=$?
[[ "$status" -ne 0 ]] || fail 'unsupported mode was accepted'

in_fixture '
  mkdir -p /home/agent/.headlong/identities/legacy
  printf "name=legacy\nroot_trajectory=legacy-root\n" \
    >/home/agent/.headlong/identities/legacy/info.txt
'
run_service_for 2
[[ ! -e "$output/init.log" ]] \
  || fail 'service prompted or initialized before the first interactive attach'
in_fixture '
  test -d /home/agent/.headlong/app/.git
  test -d /home/agent/.headlong/app/.identities
  test ! -L /home/agent/.headlong/app/.identities
  test -L /home/agent/.headlong/identities
  test "$(readlink /home/agent/.headlong/identities)" = app/.identities
  grep -Fqx "root_trajectory=legacy-root" \
    /home/agent/.headlong/app/.identities/legacy/info.txt
  test -z "$(git -C /home/agent/.headlong/app remote)"
  test -z "$(git -C /home/agent/.headlong/app status --porcelain=v1 --untracked-files=all)"
' || fail 'initial hydration did not create the isolated local baseline'
in_fixture '
  test -L /home/agent/.local/bin/llm
  test "$(readlink /home/agent/.local/bin/llm)" = /home/agent/.headlong/app/bin/llm
  test -x /home/agent/.local/bin/headlong-init
  test -x /home/agent/.local/bin/persona
  test -x /home/agent/.local/bin/headlong-tui
  test "$(cat /home/agent/.local/bin/headlong-tui)" = "$(cat /usr/local/share/trellage/headlong-tui)"
  test "$(cat /home/agent/.headlong/.trellage/source.commit)" = 1111111111111111111111111111111111111111
  test "$(stat -c %a /test-output/install.log)" = 666
' || fail 'initial hydration did not run the managed checkout installer locally, or did not install headlong-init/persona'
[[ "$(cat "$output/install.log")" == $'/home/agent/.headlong/app\t--symlinks --prefix /home/agent/.local/bin --no-init' ]] \
  || fail 'checkout installer did not receive the required local-only invocation'
[[ ! -e "$output/install-bootstrap.log" ]] \
  || fail 'checkout installer took the forbidden upstream network bootstrap path'
: >"$output/install.log"

in_fixture 'printf "operator edit\n" >>/home/agent/.headlong/app/README.md'
run_service_for 2
in_fixture 'grep -Fqx "operator edit" /home/agent/.headlong/app/README.md' \
  || fail 'same-seed service launch replaced a local source edit'
in_fixture 'cp /usr/local/share/trellage/headlong-seed/README.md /home/agent/.headlong/app/README.md'

ANTHROPIC_API_KEY='fixture-anthropic' OPENAI_API_KEY='fixture-openai' \
  GEMINI_API_KEY='fixture-gemini' OPENROUTER_API_KEY='fixture-openrouter' \
  run_entry attach
expected_init_log=$'1\t1\t\t\ttrellage-local-proxy\t\t\t\n\t\t1\t--host 0.0.0.0 --port 8080\ttrellage-local-proxy\t\t\t'
[[ "$(cat "$output/init.log")" == "$expected_init_log" ]] \
  || fail 'first attach did not route both initializer phases only through the managed proxy'
[[ "$(cat "$output/proxy.log")" == $'http://copilot-proxy-rs:8080/v1/messages\thttp://copilot-proxy-rs:8080/v1/messages\tclaude-sonnet-5\nhttp://copilot-proxy-rs:8080/v1/messages\thttp://copilot-proxy-rs:8080/v1/messages\tclaude-sonnet-5' ]] \
  || fail 'first attach did not pin the Headlong proxy URL and model'
[[ "$(cat "$output/shell.cwd")" == /home/agent/.headlong/app ]] \
  || fail 'attach shell did not start in the persistent application'
[[ "$(cat "$output/shell.argv")" == -l ]] \
  || fail 'attach did not start a login shell'
in_fixture '
  test "$(stat -c %a /test-output/init.log)" = 666
  test "$(stat -c %a /test-output/proxy.log)" = 666
  test "$(stat -c %a /test-output/dash.log)" = 666
  test "$(stat -c %a /test-output/shell.cwd)" = 666
  test "$(stat -c %a /test-output/shell.argv)" = 666
  test "$(stat -c %a /home/agent/.headlong/.env)" = 600
  test -f /home/agent/.headlong/.trellage/initialized
  test "$(readlink /home/agent/.headlong/identities/ada/kernel/always-on)" = /home/agent/.headlong/.trellage/skills/always-on
  test "$(readlink /home/agent/.headlong/identities/ada/skills/on-demand)" = /home/agent/.headlong/.trellage/skills/on-demand
  test -f /home/agent/.headlong/identities/ada/kernel/always-on/SKILL.md
  test -f /home/agent/.headlong/identities/ada/skills/on-demand/SKILL.md
  grep -Fqx "ANTHROPIC_API_KEY=trellage-local-proxy" /home/agent/.headlong/.env
  test -L /home/agent/.local/bin/ada
  test "$(readlink /home/agent/.local/bin/ada)" = persona
  test -z "$(git -C /home/agent/.headlong/app status --porcelain=v1 --untracked-files=all)"
' || fail 'managed skills, kernel, marker, secured environment, or the outside-app persona link were not synchronized'
[[ "$(cat "$output/dash.log")" == dash ]] \
  || fail 'first attach did not ensure the dashboard was running'

: >"$output/init.log"
: >"$output/dash.log"
run_service_for 2
[[ "$(cat "$output/init.log")" == $'\t\t1\t--host 0.0.0.0 --port 8080\ttrellage-local-proxy\t\t\t' ]] \
  || fail 'initialized service did not restore through the managed proxy'
[[ "$(cat "$output/dash.log")" == dash ]] \
  || fail 'initialized service did not start the dashboard by default'
: >"$output/dash.log"
run_service_for 2
[[ "$(cat "$output/dash.log")" == dash ]] \
  || fail 'restarted service did not restore the dashboard'

# An initialized attachment must reach its shell without synchronously
# recovering a stopped dashboard or repeating model setup.
in_fixture 'rm -f /home/agent/.headlong/run/web.pid'
: >"$output/init.log"
: >"$output/dash.log"
run_entry attach
[[ ! -s "$output/init.log" ]] \
  || fail 'initialized attach repeated Headlong model initialization'
[[ ! -s "$output/dash.log" ]] \
  || fail 'initialized attach synchronously started the dashboard'

# A slow service restore must not hold the state lock and block an initialized
# user attachment from reaching its login shell.
in_fixture ': >/test-control/block-restore'
rm -f "$output/restore.started"
run_service_for 5 &
service_runner=$!
for _ in $(seq 1 50); do
  [[ -f "$output/restore.started" ]] && break
  sleep 0.1
done
[[ -f "$output/restore.started" ]] \
  || fail 'blocked service restore fixture did not start'
SECONDS=0
run_entry attach
attach_seconds=$SECONDS
wait "$service_runner"
in_fixture 'rm -f /test-control/block-restore'
rm -f "$output/restore.started"
[[ "$attach_seconds" -lt 3 ]] \
  || fail 'slow service restore held the state lock and blocked an initialized attachment'

# .env must fail closed on a loosened mode (never silently re-secured) and
# must reject unsafe path types outright, without ever being modified by
# the rejected attach.
in_fixture 'chmod 644 /home/agent/.headlong/.env'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'attach accepted a pre-existing .env broader than mode 600 instead of failing closed'
in_fixture '
  test "$(stat -c %a /home/agent/.headlong/.env)" = 644
  grep -Fqx "ANTHROPIC_API_KEY=trellage-local-proxy" /home/agent/.headlong/.env
' || fail 'a rejected loosened .env mode was silently repaired or its content was modified'
in_fixture 'chmod 600 /home/agent/.headlong/.env'

in_fixture '
  cp -p /home/agent/.headlong/.env /home/agent/.headlong/.env.bak
  rm -f /home/agent/.headlong/.env
  ln -s .env.bak /home/agent/.headlong/.env
'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'attach accepted a symlinked .env'
in_fixture 'test -L /home/agent/.headlong/.env && test "$(readlink /home/agent/.headlong/.env)" = .env.bak' \
  || fail 'unsafe symlinked .env was not left untouched'
in_fixture '
  rm -f /home/agent/.headlong/.env
  mv /home/agent/.headlong/.env.bak /home/agent/.headlong/.env
  chmod 600 /home/agent/.headlong/.env
'

in_fixture '
  cp -p /home/agent/.headlong/.env /home/agent/.headlong/.env.bak
  rm -f /home/agent/.headlong/.env
  mkdir /home/agent/.headlong/.env
'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'attach accepted a directory in place of .env'
in_fixture 'test -d /home/agent/.headlong/.env && test ! -L /home/agent/.headlong/.env' \
  || fail 'unsafe directory .env was not left untouched'
in_fixture '
  rmdir /home/agent/.headlong/.env
  mv /home/agent/.headlong/.env.bak /home/agent/.headlong/.env
  chmod 600 /home/agent/.headlong/.env
'

# The post-initializer mode check must also fail closed: if the invoked
# entry point itself leaves .env broader than mode 600, the runtime must
# reject it rather than silently chmod it back to 600.
in_fixture ': >/test-control/env-mode-wrong'
status=0
run_service_for 2 || status=$?
[[ "$status" -ne 0 ]] || fail 'a restore initializer that loosened .env mode was not rejected'
in_fixture '
  test "$(stat -c %a /home/agent/.headlong/.env)" = 644
  grep -Fqx "ANTHROPIC_API_KEY=trellage-local-proxy" /home/agent/.headlong/.env
' || fail 'a rejected initializer-drifted .env mode was silently repaired or its content was modified'
in_fixture '
  rm -f /test-control/env-mode-wrong
  chmod 600 /home/agent/.headlong/.env
  test "$(stat -c %a /home/agent/.headlong/.env)" = 600
'
run_service_for 2

in_fixture 'mv /usr/local/share/trellage/headlong-skills/managed-skills.tsv /usr/local/share/trellage/headlong-skills/managed-skills.saved'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'attach accepted a missing managed skill manifest'
in_fixture 'mv /usr/local/share/trellage/headlong-skills/managed-skills.saved /usr/local/share/trellage/headlong-skills/managed-skills.tsv'

in_fixture 'printf "always-on\t2\n" >/usr/local/share/trellage/headlong-skills/managed-skills.tsv'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'attach accepted a malformed managed skill manifest'
in_fixture 'printf "on-demand\t0\nalways-on\t1\n" >/usr/local/share/trellage/headlong-skills/managed-skills.tsv'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'attach accepted an unsorted managed skill manifest'
in_fixture 'printf "always-on\t1\non-demand\t0\n" >/usr/local/share/trellage/headlong-skills/managed-skills.tsv'

in_fixture '
  mkdir -p /usr/local/share/trellage/headlong-skills/skills/collision
  printf "# Collision\n" >/usr/local/share/trellage/headlong-skills/skills/collision/SKILL.md
  printf "always-on\t1\ncollision\t0\non-demand\t0\n" >/usr/local/share/trellage/headlong-skills/managed-skills.tsv
  printf "operator-owned\n" >/home/agent/.headlong/identities/ada/skills/collision
'
grep -Fqx $'collision\t0' "$skill_seed/managed-skills.tsv" \
  || fail 'collision fixture manifest was not updated'
in_fixture '
  test -f /home/agent/.headlong/identities/ada/skills/collision
  test ! -L /home/agent/.headlong/identities/ada/skills/collision
  grep -Fqx "$(printf "collision\t0")" /usr/local/share/trellage/headlong-skills/managed-skills.tsv
' \
  || fail 'collision fixture is not visible in the runtime mount'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'unmanaged managed-skill collision was accepted'
in_fixture 'test "$(cat /home/agent/.headlong/identities/ada/skills/collision)" = operator-owned' \
  || fail 'unmanaged managed-skill collision was modified'
in_fixture '
  rm -rf /usr/local/share/trellage/headlong-skills/skills/collision
  printf "always-on\t1\non-demand\t0\n" >/usr/local/share/trellage/headlong-skills/managed-skills.tsv
  rm -f /home/agent/.headlong/identities/ada/skills/collision
'

in_fixture '
  mkdir -p /home/agent/.headlong/app/logs /home/agent/.headlong/app/web/viewer
  printf "generated\n" >/home/agent/.headlong/app/logs/generated.log
  printf "{}\n" >/home/agent/.headlong/app/web/viewer/package-lock.json
  printf "seed two\n" >/usr/local/share/trellage/headlong-seed/README.md
'
run_entry attach
in_fixture 'test "$(cat /home/agent/.headlong/app/README.md)" = "seed two"' \
  || fail 'changed seed did not update clean application state'
in_fixture '
  test -d /home/agent/.headlong/app/.identities/ada
  test ! -L /home/agent/.headlong/app/.identities
  test "$(readlink /home/agent/.headlong/identities)" = app/.identities
' || fail 'changed seed did not preserve the dashboard-discoverable identity directory'
in_fixture 'test ! -e /home/agent/.headlong/app/logs/generated.log' \
  || fail 'changed seed retained a reviewed ignored generated path'
in_fixture 'test ! -e /home/agent/.headlong/app/web/viewer/package-lock.json' \
  || fail 'changed seed retained the generated dashboard package lock'
in_fixture '
  test -z "$(git -C /home/agent/.headlong/app remote)"
  test -z "$(git -C /home/agent/.headlong/app status --porcelain=v1 --untracked-files=all)"
  test -z "$(find /home/agent/.headlong/.trellage -maxdepth 1 \( -name "app.stage.*" -o -name "app.backup.*" -o -name "markers.backup.*" -o -name "skills.stage.*" -o -name "skills.backup.*" \) -print -quit)"
' || fail 'changed-seed transaction left an unsafe baseline or temporary path'
# The identity persona link lives outside the app tree entirely, so a
# restore against the regenerated checkout leaves the tree perfectly clean
# while still regenerating the link beside the installed entry point.
run_service_for 2
in_fixture '
  test -z "$(git -C /home/agent/.headlong/app status --porcelain=v1 --untracked-files=all)"
  test -L /home/agent/.local/bin/ada
  test "$(readlink /home/agent/.local/bin/ada)" = persona
' || fail 'restore left the app tree dirty, or did not regenerate the outside-app persona link'

# File modes are part of the locked source inventory and therefore part of
# runtime seed identity. A mode-only seed revision must replace a clean app.
chmod 0744 "$seed/bin/persona"
in_fixture '
  printf "3333333333333333333333333333333333333333\n" >/usr/local/share/trellage/headlong-seed.commit
'
run_entry attach
mode_only_state="$(in_fixture '
  printf "%s\t%s\n" \
    "$(stat -c %a /home/agent/.headlong/app/bin/persona)" \
    "$(cat /home/agent/.headlong/.trellage/source.commit)"
')"
[[ "$mode_only_state" == $'744\t3333333333333333333333333333333333333333' ]] \
  || fail "mode-only Headlong source revision was not installed: $mode_only_state"

# A new locked source commit can have an identical tree. The source marker
# must still advance so the persistent app exactly identifies the image lock.
in_fixture 'printf "4444444444444444444444444444444444444444\n" >/usr/local/share/trellage/headlong-seed.commit'
run_entry attach
in_fixture '
  test "$(cat /home/agent/.headlong/.trellage/source.commit)" = 4444444444444444444444444444444444444444
  test "$(stat -c %a /home/agent/.headlong/app/bin/persona)" = 744
' || fail 'commit-only Headlong source revision was not installed'

# There is no persona exemption inside the app tree at all: an untracked
# symlink under app/tools/<name> blocks an automatic upgrade and is left
# completely untouched, no matter what it is named or targets.
in_fixture '
  ln -s wrong-target /home/agent/.headlong/app/tools/ada
  printf "seed two persona-bad-target\n" >/usr/local/share/trellage/headlong-seed/README.md
'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'an untracked app/tools symlink was silently accepted'
in_fixture 'test "$(readlink /home/agent/.headlong/app/tools/ada)" = wrong-target' \
  || fail 'an untracked app/tools symlink was not left untouched'
in_fixture 'test "$(cat /home/agent/.headlong/app/README.md)" != "seed two persona-bad-target"' \
  || fail 'a blocked upgrade nonetheless replaced application source'
in_fixture 'rm -f /home/agent/.headlong/app/tools/ada'

# An untracked regular file under app/tools/<name> blocks an upgrade in the
# same way and is left untouched.
in_fixture 'printf "user file\n" >/home/agent/.headlong/app/tools/ada'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'an untracked app/tools regular file was silently accepted'
in_fixture 'test "$(cat /home/agent/.headlong/app/tools/ada)" = "user file"' \
  || fail 'an untracked app/tools regular file was not left untouched'
in_fixture 'rm -f /home/agent/.headlong/app/tools/ada'

# A symlink identical in shape to the outside-app persona link (same name,
# same "persona" target) blocks an upgrade just as completely when it is
# placed inside the app tree, proving no exemption survived there.
in_fixture 'ln -s persona /home/agent/.headlong/app/tools/ada'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'an in-app symlink shaped like the persona launcher was silently accepted'
in_fixture '
  test -L /home/agent/.headlong/app/tools/ada
  test "$(readlink /home/agent/.headlong/app/tools/ada)" = persona
' || fail 'an in-app symlink shaped like the persona launcher was not left untouched'
in_fixture '
  rm -f /home/agent/.headlong/app/tools/ada
  printf "seed two persona-ok\n" >/usr/local/share/trellage/headlong-seed/README.md
'
run_entry attach
in_fixture 'test "$(cat /home/agent/.headlong/app/README.md)" = "seed two persona-ok"' \
  || fail 'application did not recover to a clean upgradeable state'

# A managed checkout installer failure during an upgrade must roll back the
# application AND its seed/baseline/source markers together: never old app
# paired with a new marker, or new app paired with an old marker.
before_seed_marker="$(in_fixture 'cat /home/agent/.headlong/.trellage/seed.sha256')"
before_baseline_marker="$(in_fixture 'cat /home/agent/.headlong/.trellage/baseline.commit')"
before_source_marker="$(in_fixture 'cat /home/agent/.headlong/.trellage/source.commit')"
in_fixture '
  printf "seed rollback-attempt\n" >/usr/local/share/trellage/headlong-seed/README.md
  printf "2222222222222222222222222222222222222222\n" >/usr/local/share/trellage/headlong-seed.commit
'
in_fixture ': >/test-control/fail-install'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'a failed checkout installer run did not fail the attach'
in_fixture "
  test \"\$(cat /home/agent/.headlong/app/README.md)\" != 'seed rollback-attempt'
  test -d /home/agent/.headlong/app/.identities/ada
  test ! -L /home/agent/.headlong/app/.identities
  test \"\$(readlink /home/agent/.headlong/identities)\" = app/.identities
  test \"\$(cat /home/agent/.headlong/.trellage/seed.sha256)\" = '$before_seed_marker'
  test \"\$(cat /home/agent/.headlong/.trellage/baseline.commit)\" = '$before_baseline_marker'
  test \"\$(cat /home/agent/.headlong/.trellage/source.commit)\" = '$before_source_marker'
  test -z \"\$(find /home/agent/.headlong/.trellage -maxdepth 1 \( -name 'app.stage.*' -o -name 'app.backup.*' -o -name 'markers.backup.*' \) -print -quit)\"
" || fail 'a failed checkout installer run left the application or its markers inconsistently paired'
in_fixture 'rm -f /test-control/fail-install'
in_fixture 'printf "2222222222222222222222222222222222222222\n" >/usr/local/share/trellage/headlong-seed.commit'
run_entry attach \
  || { cat "$output/stderr.log" >&2; fail 'a retried upgrade after a fixed installer failed'; }
in_fixture '
  test "$(cat /home/agent/.headlong/app/README.md)" = "seed rollback-attempt"
  test "$(cat /home/agent/.headlong/.trellage/source.commit)" = 2222222222222222222222222222222222222222
' || fail 'a retried upgrade after a fixed installer did not complete and update markers'

# A dirty-upgrade failure must name both the currently installed and the
# newly offered source commit, and must direct the operator to inspect and
# back up state rather than silently discarding it.
old_source="$(in_fixture 'cat /home/agent/.headlong/.trellage/source.commit')"
in_fixture '
  printf "dirty tracked\n" >>/home/agent/.headlong/app/README.md
  printf "seed three\n" >/usr/local/share/trellage/headlong-seed/README.md
  printf "3333333333333333333333333333333333333333\n" >/usr/local/share/trellage/headlong-seed.commit
'
in_fixture 'git -C /home/agent/.headlong/app status --porcelain=v1 --untracked-files=all | grep -Fq "README.md"' \
  || fail 'tracked-dirty fixture did not make the baseline dirty'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'changed seed overwrote dirty tracked source'
in_fixture 'grep -Fqx "dirty tracked" /home/agent/.headlong/app/README.md' \
  || fail 'dirty tracked source was reset or deleted'
grep -Fq "$old_source" "$output/stderr.log" \
  || fail 'dirty-upgrade failure did not name the currently installed source commit'
grep -Fq '3333333333333333333333333333333333333333' "$output/stderr.log" \
  || fail 'dirty-upgrade failure did not name the newly offered source commit'
grep -Fq 'trellage shell headlong' "$output/stderr.log" \
  || fail 'dirty-upgrade failure did not direct the operator to inspect and back up state'
in_fixture '
  printf "seed two\n" >/home/agent/.headlong/app/README.md
  printf "untracked\n" >/home/agent/.headlong/app/operator-source.txt
'
status=0
run_entry attach || status=$?
[[ "$status" -ne 0 ]] || fail 'changed seed overwrote dirty untracked source'
in_fixture 'test "$(cat /home/agent/.headlong/app/operator-source.txt)" = untracked' \
  || fail 'dirty untracked source was deleted'


printf 'Headlong entry contract: PASS\n'
