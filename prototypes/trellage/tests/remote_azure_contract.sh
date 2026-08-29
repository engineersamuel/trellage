#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."

fail() {
  printf 'remote Azure contract: FAIL: %s\n' "$1" >&2
  exit 1
}

fixture_root="$(mktemp -d)"
cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

fake_bin="$fixture_root/bin"
fake_home="$fixture_root/home"
fake_repo="$fixture_root/repo"
fake_worktree="$fixture_root/worktree"
fake_git_common="$fixture_root/git-common"
fake_script_dir="$fake_repo/prototypes/trellage"
fake_compiler_dir="$fake_repo/packages/trellage-cli/dist"
receipt_root="$fixture_root/local-cache/trellage/resolutions/v1/example/linux-arm64/$(printf 'a%.0s' {1..64})"
receipt="$receipt_root/profile.linux-arm64.lock.toml"
sidecar="$receipt.d/$(printf 'b%.0s' {1..64}).json"
metadata="$fixture_root/metadata.json"
log="$fixture_root/commands.log"

mkdir -p \
  "$fake_bin" \
  "$fake_home" \
  "$fake_script_dir" \
  "$fake_compiler_dir" \
  "$fake_worktree" \
  "$fake_git_common" \
  "$(dirname "$sidecar")"
cp prototypes/trellage/remote-azure-launch.sh "$fake_script_dir/remote-azure-launch.sh"
chmod 0755 "$fake_script_dir/remote-azure-launch.sh"
touch "$fake_compiler_dir/cli.js" "$fake_worktree/profile.toml"
printf 'receipt\n' >"$receipt"
printf 'sidecar\n' >"$sidecar"

jq -n \
  --arg image 'trellage-profile-example-linux-arm64:locked' \
  --arg directory "trellage/resolutions/v1/example/linux-arm64/$(printf 'a%.0s' {1..64})" \
  --arg receipt "$receipt" \
  --arg sidecar "$sidecar" \
  '{
    image: $image,
    development_resolution_bundle: {
      schema_version: 1,
      cache_relative_directory: $directory,
      files: [
        {source: $receipt, relative: "profile.linux-arm64.lock.toml"},
        {source: $sidecar, relative: ("profile.linux-arm64.lock.toml.d/" + ("b" * 64) + ".json")}
      ]
    }
  }' >"$metadata"

cat >"$fake_script_dir/trellage" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'trellage:%s\n' "$*" >>"$FAKE_LOG"
EOF

cat >"$fake_bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'rev-parse --show-toplevel') printf '%s\n' "$FAKE_WORKTREE" ;;
  'rev-parse --git-common-dir') printf '%s\n' "$FAKE_GIT_COMMON" ;;
  *) printf 'unexpected git command: %s\n' "$*" >&2; exit 1 ;;
esac
EOF

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1-}" in
  info)
    printf '%s\n' "${FAKE_DOCKER_PLATFORM:-linux/aarch64}"
    ;;
  save)
    printf 'docker:save:%s\n' "${2-}" >>"$FAKE_LOG"
    printf 'image-stream\n'
    ;;
  *)
    printf 'unexpected docker command: %s\n' "$*" >&2
    exit 1
    ;;
esac
EOF

cat >"$fake_bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'node:%s\n' "$*" >>"$FAKE_LOG"
cat "$FAKE_METADATA"
EOF

cat >"$fake_bin/az" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'az:%s\n' "$*" >>"$FAKE_LOG"
case "$*" in
  'group exists '*)
    printf 'true\n'
    ;;
  'vm show '*'-d '*)
    printf '203.0.113.10\n'
    ;;
  'vm show '*)
    ;;
  *)
    printf 'unexpected az command: %s\n' "$*" >&2
    exit 1
    ;;
esac
EOF

cat >"$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh:%s\n' "$*" >>"$FAKE_LOG"
case "$*" in
  *'mktemp -d '*)
    printf '/home/azureuser/.cache/trellage/.incoming/receipt.fixture\n'
    ;;
  *'docker load'*)
    cat >/dev/null
    ;;
  *' bash -s -- '*)
    cat >/dev/null
    ;;
esac
EOF

cat >"$fake_bin/rsync" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'rsync:%s\n' "$*" >>"$FAKE_LOG"
source_path=
for argument in "$@"; do
  if [[ "$argument" == */receipt/ ]]; then
    source_path="$argument"
  fi
done
if [[ -n "$source_path" ]]; then
  find "$source_path" -type f -print | sed "s#^$source_path#rsync-file:#" >>"$FAKE_LOG"
fi
EOF

cat >"$fake_bin/scp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'scp:%s\n' "$*" >>"$FAKE_LOG"
EOF

cat >"$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'auth token' ]]
printf 'fixture-token\n'
EOF

chmod 0755 "$fake_script_dir/trellage" "$fake_bin"/*

export PATH="$fake_bin:$PATH"
export HOME="$fake_home"
export FAKE_LOG="$log"
export FAKE_METADATA="$metadata"
export FAKE_WORKTREE="$fake_worktree"
export FAKE_GIT_COMMON="$fake_git_common"

"$fake_script_dir/remote-azure-launch.sh" "$fake_worktree/profile.toml" \
  --profile "$fake_worktree/profile.toml" -p probe

grep -Fq 'trellage:build ' "$log" || fail 'local resolved image was not built'
grep -Fq 'rsync-file:profile.linux-arm64.lock.toml' "$log" \
  || fail 'development receipt was not transferred'
grep -Fq "rsync-file:profile.linux-arm64.lock.toml.d/$(printf 'b%.0s' {1..64}).json" "$log" \
  || fail 'development sidecar was not transferred'
grep -Fq 'docker:save:trellage-profile-example-linux-arm64:locked' "$log" \
  || fail 'resolved image was not transferred'
grep -Fq "XDG_CACHE_HOME='/home/azureuser/.cache'" "$log" \
  || fail 'remote launch did not use the transferred XDG cache'
grep -Fq 'bash -s -- /home/azureuser/.cache/trellage/.incoming/receipt.fixture /home/azureuser/.cache/trellage/resolutions/v1/example/linux-arm64/' "$log" \
  || fail 'remote receipt bundle was not published'

: >"$log"
if FAKE_DOCKER_PLATFORM=linux/x86_64 \
  "$fake_script_dir/remote-azure-launch.sh" "$fake_worktree/profile.toml" \
  >"$fixture_root/amd64.out" 2>&1; then
  fail 'amd64 local Docker server was accepted'
fi
grep -Fq 'requires a linux/arm64 local Docker server: linux/amd64' "$fixture_root/amd64.out" \
  || fail 'amd64 rejection diagnostic differs'
[[ ! -s "$log" ]] || fail 'amd64 rejection occurred after remote work started'

rm -f -- "$sidecar"
if "$fake_script_dir/remote-azure-launch.sh" "$fake_worktree/profile.toml" \
  >"$fixture_root/missing-sidecar.out" 2>&1; then
  fail 'missing development sidecar was accepted'
fi
grep -Fq 'development receipt bundle file is unsafe' "$fixture_root/missing-sidecar.out" \
  || fail 'missing sidecar rejection diagnostic differs'

printf 'remote Azure contract: PASS\n'
