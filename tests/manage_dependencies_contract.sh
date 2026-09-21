#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
. "$repo_root/scripts/bun-runtime.sh"
trellage_bun_runtime "$repo_root"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/project/scripts" "$fixture/project/packages/application" "$fixture/dependency"
cp "$repo_root/scripts/check-package-manager.sh" "$fixture/project/scripts/"
cat >"$fixture/project/package.json" <<'EOF'
{
  "name": "dependency-hook-fixture",
  "version": "1.0.0",
  "workspaces": ["packages/*"],
  "scripts": {
    "preinstall": "bash scripts/check-package-manager.sh",
    "postinstall": "bash scripts/install-source-runtime.sh --prepare"
  }
}
EOF
printf '{"name":"fixture-application","version":"1.0.0"}\n' >"$fixture/project/packages/application/package.json"
printf '{"name":"fixture-dependency","version":"1.0.0"}\n' >"$fixture/dependency/package.json"
cat >"$fixture/project/scripts/install-source-runtime.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'prepare:%s\n' "$*" >>"$TEST_CALLS"
EOF
export TEST_CALLS="$fixture/calls"
for agent in 'bun/1.3.4' 'npm/11.0.0' ''; do
  if npm_config_user_agent="$agent" bash "$fixture/project/scripts/check-package-manager.sh" >"$fixture/output" 2>&1; then
    printf 'unsupported package manager was accepted: %s\n' "$agent" >&2
    exit 1
  fi
  grep -Fq 'Bun 1.4.2 is required' "$fixture/output"
done
cd "$fixture/project"
for action in install add update remove; do
  arguments=("$action")
  case "$action" in
    add) arguments+=("../dependency") ;;
    update|remove) arguments+=("fixture-dependency") ;;
  esac
  "${trellage_bun[0]}" --no-env-file "${arguments[@]}"
  grep -Fxq 'prepare:--prepare' "$TEST_CALLS"
  test "$(wc -l <"$TEST_CALLS" | tr -d ' ')" = 1
  rm "$TEST_CALLS"
done
"${trellage_bun[0]}" --no-env-file add --cwd "$fixture/project/packages/application" "$fixture/dependency"
grep -Fxq 'prepare:--prepare' "$TEST_CALLS"
test "$(wc -l <"$TEST_CALLS" | tr -d ' ')" = 1
printf 'automatic dependency hook contract: PASS\n'
