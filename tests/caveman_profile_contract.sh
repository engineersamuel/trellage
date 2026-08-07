#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'Caveman profile contract: FAIL: %s\n' "$1" >&2
  exit 1
}

expected_profiles=$'profiles/claude-blog/profile.toml\nprofiles/claude-council/profile.toml\nprofiles/claude-frontend-design/profile.toml\nprofiles/claude-qwen-local/profile.toml\nprofiles/claude-research/profile.toml\nprofiles/claude-social-media/profile.toml\nprofiles/codex-superpowers/profile.toml\nprofiles/copilot-hve/profile.toml\nprofiles/pi-oh-my-pi/profile.toml\nprofiles/prime-agent/profile.toml'
actual_profiles="$(find profiles -mindepth 2 -maxdepth 2 -name profile.toml -type f | LC_ALL=C sort)"
[[ "$actual_profiles" == "$expected_profiles" ]] \
  || fail 'every bundled profile must be Caveman-protected'

has_caveman_skill() {
  local profile="$1"
  awk '
    function complete() {
      return repository == "https://github.com/JuliusBrussee/caveman.git" \
        && ref == "v1.10.0" && select == "select = [\"caveman\"]" \
        && always_on == "always_on = true"
    }
    /^\[\[skills\]\]$/ {
      if (in_skill && complete()) found = 1
      in_skill = 1
      repository = ref = select = always_on = ""
      next
    }
    /^\[\[/ {
      if (in_skill && complete()) found = 1
      in_skill = 0
      next
    }
    in_skill && /^repository = / { repository = substr($0, 14); gsub(/"/, "", repository) }
    in_skill && /^ref = / { ref = substr($0, 7); gsub(/"/, "", ref) }
    in_skill && /^select = / { select = $0 }
    in_skill && /^always_on = / { always_on = $0 }
    END {
      if (in_skill && complete()) found = 1
      exit(found ? 0 : 1)
    }
  ' "$profile"
}

while IFS= read -r profile; do
  has_caveman_skill "$profile" \
    || fail "Caveman v1.10.0 with always_on = true is missing: $profile"
done <<<"$expected_profiles"

grep -Fq 'Every new Trellage Sandbox profile under `profiles/` MUST declare the pinned Caveman Agent Skill with `always_on = true`.' AGENTS.md \
  || fail 'AGENTS.md does not require always-on Caveman for future Sandbox profiles'

printf 'Caveman profile contract: PASS\n'
