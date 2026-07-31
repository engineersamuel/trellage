#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: materialize-awesome-plugin.sh SOURCE_ROOT OUTPUT_ROOT PLUGIN...}"
output_root="${2:?usage: materialize-awesome-plugin.sh SOURCE_ROOT OUTPUT_ROOT PLUGIN...}"
shift 2

[[ $# -gt 0 ]] || {
  printf 'awesome copilot adapter: at least one plugin is required\n' >&2
  exit 64
}
[[ -d "$source_root/plugins" && -d "$source_root/agents" && -d "$source_root/skills" ]] || {
  printf 'awesome copilot adapter: invalid source repository: %s\n' "$source_root" >&2
  exit 66
}

mkdir -p "$output_root"

copy_agent() {
  local manifest_entry="$1"
  local plugin_output="$2"
  local relative_path source_path source_stem target_path

  [[ "$manifest_entry" =~ ^\./agents/[a-z0-9][a-z0-9-]*\.md$ ]] || {
    printf 'awesome copilot adapter: unsafe agent path: %s\n' "$manifest_entry" >&2
    exit 65
  }

  relative_path="${manifest_entry#./}"
  source_stem="${relative_path%.md}"
  source_path="$source_root/${source_stem}.agent.md"
  target_path="$plugin_output/$relative_path"
  [[ -f "$source_path" && ! -L "$source_path" ]] || {
    printf 'awesome copilot adapter: missing source agent: %s\n' "$source_path" >&2
    exit 66
  }

  mkdir -p "$(dirname "$target_path")"
  cp "$source_path" "$target_path"
}

copy_skill() {
  local manifest_entry="$1"
  local plugin_output="$2"
  local relative_path source_path target_path

  [[ "$manifest_entry" =~ ^\./skills/[a-z0-9][a-z0-9-]*/$ ]] || {
    printf 'awesome copilot adapter: unsafe skill path: %s\n' "$manifest_entry" >&2
    exit 65
  }

  relative_path="${manifest_entry#./}"
  relative_path="${relative_path%/}"
  source_path="$source_root/$relative_path"
  target_path="$plugin_output/$relative_path"
  [[ -d "$source_path" && -f "$source_path/SKILL.md" ]] || {
    printf 'awesome copilot adapter: missing source skill: %s\n' "$source_path" >&2
    exit 66
  }
  if find "$source_path" -type l -print -quit | grep -q .; then
    printf 'awesome copilot adapter: symbolic links are unsupported in skill: %s\n' "$source_path" >&2
    exit 65
  fi

  mkdir -p "$target_path"
  cp -a "$source_path/." "$target_path/"
}

for plugin_name in "$@"; do
  [[ "$plugin_name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || {
    printf 'awesome copilot adapter: invalid plugin name: %s\n' "$plugin_name" >&2
    exit 64
  }

  plugin_source="$source_root/plugins/$plugin_name"
  manifest="$plugin_source/.github/plugin/plugin.json"
  plugin_output="$output_root/$plugin_name"

  [[ -f "$manifest" && ! -L "$manifest" ]] || {
    printf 'awesome copilot adapter: missing plugin manifest: %s\n' "$manifest" >&2
    exit 66
  }
  jq -e --arg name "$plugin_name" '
    .name == $name
    and (.description | type == "string" and length > 0)
    and (.version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
    and ((.agents // []) | type == "array")
    and ((.skills // []) | type == "array")
  ' "$manifest" >/dev/null || {
    printf 'awesome copilot adapter: invalid plugin manifest: %s\n' "$manifest" >&2
    exit 65
  }

  for unsupported_surface in mcpServers commands hooks extensions; do
    if jq -e --arg key "$unsupported_surface" 'has($key)' "$manifest" >/dev/null; then
      printf 'awesome copilot adapter: unsupported %s in plugin: %s\n' \
        "$unsupported_surface" "$plugin_name" >&2
      exit 65
    fi
  done

  mkdir -p "$plugin_output/.github/plugin"
  cp "$manifest" "$plugin_output/.github/plugin/plugin.json"
  if [[ -f "$plugin_source/README.md" && ! -L "$plugin_source/README.md" ]]; then
    cp "$plugin_source/README.md" "$plugin_output/README.md"
  fi

  while IFS= read -r agent_entry; do
    copy_agent "$agent_entry" "$plugin_output"
  done < <(jq -r '.agents[]?' "$manifest")

  while IFS= read -r skill_entry; do
    copy_skill "$skill_entry" "$plugin_output"
  done < <(jq -r '.skills[]?' "$manifest")
done
