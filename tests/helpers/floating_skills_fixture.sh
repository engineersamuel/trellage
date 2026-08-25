#!/usr/bin/env bash

seed_floating_skills_cache() {
  local home="$1"
  local cache="$home/.local/share/trellage/common/skills"

  mkdir -p "$cache/skills/fixture-personal" "$cache/skills/show-me"
  printf '%s\n' '# Fixture personal skill' >"$cache/skills/fixture-personal/SKILL.md"
  printf '%s\n' '# Fixture show-me skill' >"$cache/skills/show-me/SKILL.md"
  printf '%s\n' fixture-personal show-me >"$cache/managed-skills.txt"
  : >"$cache/always-on.md"
}

install_fixture_node() {
  local destination="$1"
  local node_path

  node_path="$(command -v node)" || {
    printf 'floating skill fixture: node is required\n' >&2
    return 1
  }
  ln -s "$node_path" "$destination/node"
}
