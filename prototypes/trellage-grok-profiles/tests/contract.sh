#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
prototype_root="$PWD"

fail() {
  printf 'trellage Grok profiles contract: FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local needle="$1"
  local file="$2"
  grep -Fq -- "$needle" "$file" || fail "missing '$needle' in $file"
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  if grep -Fq -- "$needle" "$file"; then
    fail "unexpected '$needle' in $file"
  fi
}

assert_line() {
  local expected="$1"
  local file="$2"
  grep -Fxq -- "$expected" "$file" || fail "missing exact line '$expected' in $file"
}

sha256_digest() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    fail 'no SHA-256 command available'
  fi
}

sha256_file() {
  sha256_digest <"$1"
}

profile_tree_hash() {
  local root="$1"
  local scope="${2:-all}"
  local entry
  local mode

  (
    cd "$root"
    while IFS= read -r entry; do
      if [ "$scope" = 'outside-auth' ]; then
        case "$entry" in
          ./auth.json|./.auth.*) continue ;;
        esac
      fi
      mode="$(path_mode "$entry")"
      if [ -L "$entry" ]; then
        printf 'symlink\t%s\t%s\t%s\n' "$mode" "$entry" "$(readlink "$entry")"
      elif [ -d "$entry" ]; then
        printf 'directory\t%s\t%s\n' "$mode" "$entry"
      elif [ -f "$entry" ]; then
        if [ -r "$entry" ]; then
          printf 'file\t%s\t%s\t' "$mode" "$entry"
          sha256_file "$entry"
        else
          printf 'unreadable-file\t%s\t%s\n' "$mode" "$entry"
        fi
      else
        printf 'other\t%s\t%s\n' "$mode" "$entry"
      fi
    done < <(find . -mindepth 1 -print 2>/dev/null | LC_ALL=C sort)
  ) | sha256_digest
}

path_mode() {
  local value

  case "$(uname -s)" in
    Darwin) value="$(stat -f '%Lp' "$1")" || return 1 ;;
    Linux) value="$(stat -c '%a' "$1")" || return 1 ;;
    *) return 1 ;;
  esac
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$value"
}

path_inode() {
  local value

  case "$(uname -s)" in
    Darwin) value="$(stat -f '%i' "$1")" || return 1 ;;
    Linux) value="$(stat -c '%i' "$1")" || return 1 ;;
    *) return 1 ;;
  esac
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$value"
}

wait_for_file() {
  local path="$1"
  local attempts=0

  while [ ! -e "$path" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 200 ] || fail "timed out waiting for $path"
    sleep 0.05
  done
}

readme="$prototype_root/README.md"
assert_contains 'GROK_HOME' "$readme"
assert_contains 'http://127.0.0.1:8080/v1' "$readme"
assert_contains '`grok-4.5`' "$readme"
assert_contains '`-m` or `--model`' "$readme"
assert_line 'Profile launches default to `--permission-mode bypassPermissions`. An explicit' "$readme"
assert_line 'permission mode, approval flag, allow rule, or deny rule is forwarded unchanged' "$readme"
assert_line 'and suppresses that default.' "$readme"
assert_contains 'Plain `grok`' "$readme"
assert_contains 'profile-local user-scoped MCP servers' "$readme"
assert_contains 'does not import MCP servers from `~/.grok/config.toml`' "$readme"
assert_contains 'not a security boundary' "$readme"
assert_contains 'grx setup --all' "$readme"
assert_contains 'grx update --check --all' "$readme"
assert_contains 'grx repair hve' "$readme"
assert_contains '~/.local/share/trellage/profiles/grok/<profile>/home/' "$readme"
assert_contains 'repository `CLAUDE.md`' "$readme"
assert_contains 'profile homes' "$readme"
assert_line '- Grok Build CLI 0.2.112 or later (tested with 0.2.112).' "$readme"
assert_line 'grx does not enforce the CLI version; other versions are unverified.' "$readme"
assert_line 'The installer does not modify `PATH`.' "$readme"
assert_line '`~/.local/bin` must already be on `PATH`, or invoke `~/.local/bin/grx` directly.' "$readme"
assert_line "Source authentication must be a readable, regular, non-symlink file; its source mode may be arbitrary." "$readme"
assert_line 'Each profile copy is created with mode `0600`.' "$readme"
assert_line 'Before every selected-profile Grok invocation, `grx` atomically refreshes the profile `auth.json` from `~/.grok/auth.json`.' "$readme"
assert_line 'When source and profile authentication already match, `grx` preserves the profile `auth.json` inode while enforcing mode `0600`.' "$readme"
assert_line 'Refreshes for the same profile are serialized. If host authentication rotates' "$readme"
assert_line 'stale lock is diagnosed and left in place for explicit inspection rather than' "$readme"
assert_line 'Setup and repair rewrite managed `requirements.toml` to catalog policy.' "$readme"
assert_line 'They normalize the profile home to mode `0700` and managed `requirements.toml` to mode `0644`.' "$readme"
assert_line '`fail_closed = true` is the first top-level key in the managed policy.' "$readme"
assert_line 'It prevents the Grok Build 0.2.112 session-start managed-config refresh from clearing the local isolation policy when no team principal owns it.' "$readme"
assert_line 'They preserve existing sessions, memory, and permissions.' "$readme"
assert_line 'Repair restores managed policy and a missing cataloged plugin; it is not generic recovery for every doctor failure.' "$readme"
assert_line 'Launch self-heals repairable managed policy and plugin drift after setup.' "$readme"
assert_line 'Unsafe profile or authentication paths still fail closed.' "$readme"
assert_line '`inspect --json` may retain personal Claude or Cursor entries; they are operationally disabled either by entry-level `disabled: true` plus `compatibilityStatus: "disabled"` or by the matching disabled `externalCompat` vendor/surface cell. Plugin container metadata is allowed only when every provided invocable surface is disabled.' "$readme"
assert_line '`grx update --check` requires `curl` and uses network access to fetch official manifests for installed profiles.' "$readme"
assert_line 'Exit status: 0 means current; 1 means update available or not installed; 2 means an operational error.' "$readme"
assert_line 'Status 1 is expected in automation and is not an operational failure.' "$readme"
assert_line 'This is clean user-state separation, not containment and not a security boundary.' "$readme"
assert_line 'Uninstall preserves all profile homes, including authentication, plugins, sessions, memory, and permissions.' "$readme"

readme_commands="$(awk '
  $0 == "## Commands" { in_commands = 1; next }
  in_commands && $0 == "```sh" { in_block = 1; next }
  in_block && $0 == "```" { exit }
  in_block { print }
' "$readme")"
expected_readme_commands="$(printf '%s\n' \
  'grx list' \
  'grx inventory hve --json' \
  'grx setup hve' \
  'grx setup superpowers' \
  'grx setup --all' \
  'grx hve' \
  'grx superpowers -p "Review this repository"' \
  'grx doctor hve' \
  'grx update --check hve' \
  'grx update --check --all' \
  'grx update hve' \
  'grx update --all' \
  'grx repair hve')"
[ "$readme_commands" = "$expected_readme_commands" ] \
  || fail 'README command block does not match the supported grx command forms'

jq -e '
  .schemaVersion == 1
  and (.profiles | keys | sort) == ["hve", "superpowers"]
  and .profiles.hve == {
    "description": "Grok Build with HVE Core skills for RPI evidence and broad engineering workflows, Grok-native sessions and subagents, and a separate Caveman plugin.",
    "source": "microsoft/hve-core#plugins/hve-core-all",
    "manifestUrl": "https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json",
    "plugin": "hve-core-all",
    "standaloneMcps": []
  }
  and .profiles.superpowers == {
    "description": "Grok Build with Superpowers’ design, TDD, debugging, review, verification, and branch-finishing skills, plus a separate Caveman plugin.",
    "source": "obra/superpowers",
    "manifestUrl": "https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json",
    "plugin": "superpowers",
    "standaloneMcps": []
  }
' "$prototype_root/catalog.json" >/dev/null \
  || fail 'catalog does not match the approved profile contract'

fixture_root="$(mktemp -d)"
cleanup() {
  chmod -R u+rwx "$fixture_root" 2>/dev/null || true
  rm -rf "$fixture_root"
}
trap cleanup EXIT

fixture_home="$fixture_root/home"
fake_bin="$fixture_root/fake-bin"
fake_grok_log="$fixture_root/fake-grok.log"
mkdir -p "$fixture_home" "$fake_bin"
: >"$fake_grok_log"

HOME="$fixture_home" "$prototype_root/bin/grx" list >"$fixture_root/list.out" \
  || fail 'list failed'
cmp -s "$fixture_root/list.out" <(printf '%s\n' \
  $'hve\thve-core-all' \
  $'superpowers\tsuperpowers') \
  || fail 'list output differs'
HOME="$fixture_home" "$prototype_root/bin/grx" list --json >"$fixture_root/list.json" \
  || fail 'JSON list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "grx"
  and .harness == "grok"
  and [.profiles[].name] == ["hve", "superpowers"]
  and all(.profiles[]; (.description | type == "string" and length > 0))
  and .profiles[0].plugin == "hve-core-all"
  and .profiles[0].source == "microsoft/hve-core#plugins/hve-core-all"
  and .profiles[0].marketplace == null
  and .profiles[0].standaloneMcps == []
  and .profiles[1].source == "obra/superpowers"
  and .profiles[1].standaloneMcps == []
' "$fixture_root/list.json" >/dev/null || fail 'JSON list output differs'

real_jq="$(command -v jq)"
export REAL_JQ="$real_jq"
cat >"$fake_bin/jq" <<'FAKE_JQ'
#!/bin/bash
set -euo pipefail

if [ "${FAKE_JQ_PROFILE_LIST_FAILURE:-}" = '1' ]; then
  for argument in "$@"; do
    if [ "$argument" = '.profiles | keys | sort[]' ]; then
      printf 'fixture profile-list failure\n' >&2
      exit 69
    fi
  done
fi

exec "$REAL_JQ" "$@"
FAKE_JQ
chmod 0555 "$fake_bin/jq"

cat >"$fake_bin/grok" <<'FAKE_GROK'
#!/bin/bash
set -euo pipefail

: "${GROK_HOME:?GROK_HOME is required}"
: "${FAKE_GROK_LOG:?FAKE_GROK_LOG is required}"

case "$GROK_HOME" in
  "$HOME/.local/share/trellage/profiles/grok/"*/home)
    [ -f "$GROK_HOME/auth.json" ] && [ ! -L "$GROK_HOME/auth.json" ] || exit 92
    cmp -s "$HOME/.grok/auth.json" "$GROK_HOME/auth.json" || exit 93
    case "$(uname -s)" in
      Darwin) auth_mode="$(stat -f '%Lp' "$GROK_HOME/auth.json")" || exit 94 ;;
      Linux) auth_mode="$(stat -c '%a' "$GROK_HOME/auth.json")" || exit 94 ;;
      *) exit 94 ;;
    esac
    [ "$auth_mode" = '600' ] || exit 94
    ;;
esac

if [ -n "${FAKE_GROK_TTY_LOG:-}" ]; then
  if [ -t 0 ]; then
    printf '1\n' >>"$FAKE_GROK_TTY_LOG"
  else
    printf '0\n' >>"$FAKE_GROK_TTY_LOG"
  fi
fi

jq -cn \
  --arg grokHome "$GROK_HOME" \
  --arg home "$HOME" \
  --arg cwd "$PWD" \
  --arg modelsBaseUrl "${GROK_MODELS_BASE_URL:-}" \
  --arg defaultModel "${GROK_DEFAULT_MODEL:-}" \
  --arg xaiApiKey "${XAI_API_KEY:-}" \
  --args '{
    grokHome:$grokHome,
    home:$home,
    cwd:$cwd,
    modelsBaseUrl:$modelsBaseUrl,
    defaultModel:$defaultModel,
    xaiApiKey:$xaiApiKey,
    args:$ARGS.positional
  }' \
  -- "$@" >>"$FAKE_GROK_LOG"

if [ "${1:-}" = '--permission-mode' ] \
  && [ "${2:-}" = 'bypassPermissions' ]; then
  shift 2
fi

state_dir="$GROK_HOME/fake-state"
plugins_file="$state_dir/plugins.json"

write_native_plugin() {
  local name="$1"
  local version="$2"
  local repo_key="$3"
  local repo_url="$4"
  local manifest_relative="$5"
  local installed_path="$GROK_HOME/installed-plugins/$repo_key"
  local manifest="$installed_path/$manifest_relative"

  mkdir -p "$state_dir" "$(dirname "$manifest")"
  jq -cn \
    --arg name "$name" \
    --arg version "$version" \
    --arg repository "$repo_url" \
    '{name:$name,version:$version,repository:$repository}' \
    >"$manifest"
  mkdir -p "$installed_path/skills/package-one"
  printf '%s\n' '# Package one' >"$installed_path/skills/package-one/SKILL.md"
  jq -cn \
    --arg name "$name" \
    --arg repoKey "$repo_key" \
    --arg path "$installed_path" \
    --arg source "$repo_url" \
    '[{status:"installed",name:$name,repo_key:$repoKey,version:null,path:$path,source:$source,marketplace:null}]' \
    >"$plugins_file"
}

if [ "${1:-}" = 'plugin' ] && [ "${2:-}" = 'list' ]; then
  if [ "${FAKE_GROK_LIST_FAILURE_HOME:-}" = "$GROK_HOME" ]; then
    printf 'fixture plugin-list failure\n' >&2
    exit 66
  fi
  if [ -f "$plugins_file" ]; then
    if [ "${FAKE_GROK_PLUGIN_RAW_NUL_HOME:-}" = "$GROK_HOME" ]; then
      printf '\000'
    fi
    cat "$plugins_file"
  else
    printf '[]\n'
  fi
  exit 0
fi

if [ "${1:-}" = 'plugin' ] && [ "${2:-}" = 'install' ]; then
  source="${3:-}"
  if [ "${4:-}" != '--trust' ] || [ "$#" -ne 4 ]; then
    printf 'missing --trust\n' >&2
    exit 67
  fi

  case "$source" in
    'microsoft/hve-core#plugins/hve-core-all')
      name='hve-core-all'
      version='3.3.101'
      repo_key='hve-core-fixture'
      repo_url='https://github.com/microsoft/hve-core'
      manifest_relative='plugins/hve-core-all/.github/plugin/plugin.json'
      ;;
    'obra/superpowers')
      name='superpowers'
      version='6.2.0'
      repo_key='superpowers-fixture'
      repo_url='https://github.com/obra/superpowers'
      manifest_relative='.claude-plugin/plugin.json'
      ;;
    *)
      printf 'unexpected source: %s\n' "$source" >&2
      exit 68
      ;;
  esac

  write_native_plugin "$name" "$version" "$repo_key" "$repo_url" \
    "$manifest_relative"
  exit 0
fi

if [ "${1:-}" = 'plugin' ] && [ "${2:-}" = 'uninstall' ]; then
  plugin="${3:-}"
  if [ "${4:-}" != '--yes' ] || [ "$#" -ne 4 ]; then
    printf 'missing noninteractive confirmation\n' >&2
    exit 69
  fi
  jq --arg plugin "$plugin" '[.[] | select(.name != $plugin)]' \
    "$plugins_file" >"$plugins_file.next"
  mv "$plugins_file.next" "$plugins_file"
  exit 0
fi

if [ "${1:-}" = 'plugin' ] && [ "${2:-}" = 'update' ]; then
  plugin="${3:-}"
  if [ "$#" -ne 3 ]; then
    printf 'unexpected plugin update arguments\n' >&2
    exit 69
  fi

  case "$plugin" in
    'hve-core-all')
      version='3.3.101'
      repo_key='hve-core-fixture'
      repo_url='https://github.com/microsoft/hve-core'
      manifest_relative='plugins/hve-core-all/.github/plugin/plugin.json'
      ;;
    'superpowers')
      version='6.2.0'
      repo_key='superpowers-fixture'
      repo_url='https://github.com/obra/superpowers'
      manifest_relative='.claude-plugin/plugin.json'
      ;;
    *)
      printf 'unexpected plugin: %s\n' "$plugin" >&2
      exit 69
      ;;
  esac

  write_native_plugin "$plugin" "$version" "$repo_key" "$repo_url" \
    "$manifest_relative"
  exit 0
fi

if [ "${1:-}" = 'mcp' ] && [ "${2:-}" = 'list' ]; then
  if [ "${FAKE_GROK_MCP_RAW_NUL_HOME:-}" = "$GROK_HOME" ]; then
    printf '\000'
  fi
  if [ -n "${FAKE_GROK_MCP_JSON:-}" ]; then
    printf '%s\n' "$FAKE_GROK_MCP_JSON"
  else
    printf '%s\n' '[{"name":"native-mcp","scope":"native","enabled":true},{"name":"plugin-mcp","scope":"plugin","enabled":true},{"name":"repository-mcp","scope":"repository","enabled":true}]'
  fi
  exit 0
fi

if [ "${1:-}" = 'inspect' ] && [ "${2:-}" = '--json' ]; then
  profile_isolated=false
  agents_ignored=false
  [ "$GROK_HOME" != "$HOME/.grok" ] && profile_isolated=true
  grep -Fxq 'ignore = ["~/.agents/skills", "~/.agents/commands"]' \
    "$GROK_HOME/requirements.toml" 2>/dev/null && agents_ignored=true
  compatibility_cell_is_disabled() {
    local vendor="$1"
    local surface="$2"
    awk -v section="[compat.$vendor]" -v surface="$surface" '
      $0 == section { in_section = 1; next }
      in_section && /^\[/ { exit }
      in_section && $0 == (surface " = false") { disabled += 1 }
      in_section && $0 ~ ("^" surface " = ") { assignments += 1 }
      END { exit disabled == 1 && assignments == 1 ? 0 : 1 }
    ' "$GROK_HOME/requirements.toml"
  }
  external_cells='[]'
  for vendor in cursor claude; do
    for surface in skills rules agents mcps hooks sessions; do
      cell_enabled=true
      compatibility_cell_is_disabled "$vendor" "$surface" \
        && cell_enabled=false
      external_cells="$(printf '%s\n' "$external_cells" | jq -c \
        --arg vendor "$vendor" \
        --arg surface "$surface" \
        --argjson enabled "$cell_enabled" \
        '. + [{vendor:$vendor,surface:$surface,enabled:$enabled,source:"config"}]')"
    done
  done
  cell_enabled=true
  compatibility_cell_is_disabled codex sessions && cell_enabled=false
  external_cells="$(printf '%s\n' "$external_cells" | jq -c \
    --argjson enabled "$cell_enabled" \
    '. + [{vendor:"codex",surface:"sessions",enabled:$enabled,source:"config"}]')"
  personal_surfaces='[]'
  for personal_vendor in grok agents claude cursor; do
    for personal_surface in skills agents hooks plugins mcps; do
      personal_path="$HOME/.$personal_vendor/$personal_surface"
      if [ -d "$personal_path" ]; then
        personal_surfaces="$(printf '%s\n' "$personal_surfaces" | jq -c \
          --arg vendor "$personal_vendor" \
          --arg surface "$personal_surface" \
          '. + [{vendor:$vendor,surface:$surface}]')"
      fi
    done
  done

  jq -cn \
    --arg grokHome "$GROK_HOME" \
    --arg home "$HOME" \
    --arg repository "$PWD" \
    --argjson profileIsolated "$profile_isolated" \
    --argjson agentsIgnored "$agents_ignored" \
    --argjson externalCells "$external_cells" \
    --argjson personalSurfaces "$personal_surfaces" '
    def active($name; $origin; $path): {
      name: $name,
      origin: $origin,
      enabled: true,
      disabled: false,
      compatibilityStatus: "native",
      source: {type: $origin, path: $path}
    };
    def builtin($name): {
      name: $name,
      source: {type: "builtin"}
    };
    def retained($name; $vendor; $path): {
      name: $name,
      vendor: $vendor,
      origin: "compatibility",
      enabled: false,
      disabled: true,
      compatibilityStatus: "disabled",
      source: {type: "user", path: $path}
    };
    def retained_by_cell($name; $vendor; $path): {
      name: $name,
      vendor: $vendor,
      origin: "compatibility",
      source: {type: "user", path: $path}
    };
    def cell_disabled($vendor; $surface):
      any($externalCells[];
        .vendor == $vendor and .surface == $surface and .enabled == false);
    def surface_present($vendor; $surface):
      any($personalSurfaces[];
        .vendor == $vendor and .surface == $surface);
    def personal($name; $vendor; $surface; $path; $entryFlags):
      if cell_disabled($vendor; $surface) then
        if $entryFlags then retained($name; $vendor; $path)
        else retained_by_cell($name; $vendor; $path)
        end
      else active($name; "personal"; $path) + {vendor: $vendor}
      end;
    def personal_grok_entries($class):
      (if $profileIsolated or (surface_present("grok"; $class) | not) then [] else [
        active(("personal-grok-" + $class); "user"; ($home + "/.grok/" + $class + "/personal-grok"))
      ] end);
    def compat_entries($class; $surface; $entryFlags):
      (if surface_present("claude"; $class) then [
        personal(("personal-claude-" + $class); "claude"; $surface; ($home + "/.claude/" + $class + "/personal-claude"); $entryFlags)
      ] else [] end)
      + (if surface_present("cursor"; $class) then [
        personal(("personal-cursor-" + $class); "cursor"; $surface; ($home + "/.cursor/" + $class + "/personal-cursor"); $entryFlags)
      ] else [] end);
    def plugin_child($vendor; $class; $surface; $entryFlags):
      personal(
        ("personal-" + $vendor + "-plugin-" + $class);
        $vendor;
        $surface;
        ($home + "/." + $vendor + "/plugins/personal-" + $vendor + "/" + $class + "/child");
        $entryFlags
      )
      | .source.type = "plugin"
      | .source.plugin_name = ("personal-" + $vendor + "-plugin");
    def plugin_children($class; $surface; $entryFlags):
      (if surface_present("claude"; "plugins") then [
        plugin_child("claude"; $class; $surface; $entryFlags)
      ] else [] end)
      + (if surface_present("cursor"; "plugins") then [
        plugin_child("cursor"; $class; $surface; $entryFlags)
      ] else [] end);
    def personal_plugin($vendor): {
      name: ("personal-" + $vendor + "-plugin"),
      scope: "user",
      path: ($home + "/." + $vendor + "/plugins/personal-" + $vendor),
      enabled: true,
      provides: {skills: 1, agents: 1, hooks: true, mcpServers: 1}
    };
    {
      skills: ([
        (active("plugin-skill"; "plugin"; ($grokHome + "/installed-plugins/plugin/skills/plugin-skill"))
          | .source.plugin_name = "hve-core-all"),
        (active("support-skill"; "plugin"; ($grokHome + "/installed-plugins/support-plugin/skills/support"))
          | .source.plugin_name = "support-plugin"),
        active("repository-grok-skill"; "repository"; ($repository + "/.grok/skills/grok-skill")),
        active("repository-agents-skill"; "repository"; ($repository + "/.agents/skills/agents-skill"))
      ]
      + personal_grok_entries("skills")
      + (if $agentsIgnored or (surface_present("agents"; "skills") | not) then [] else [
          active("personal-agents-skill"; "user"; ($home + "/.agents/skills/personal-agents"))
        ] end)
      + compat_entries("skills"; "skills"; true)
      + plugin_children("skills"; "skills"; true)),
      agents: ([
        builtin("builtin-agent"),
        active("plugin-agent"; "plugin"; ($grokHome + "/installed-plugins/plugin/agents/plugin-agent")),
        active("repository-agent"; "repository"; ($repository + "/.agents/agents/repository-agent"))
      ]
      + personal_grok_entries("agents")
      + compat_entries("agents"; "agents"; false)
      + plugin_children("agents"; "agents"; false)),
      hooks: ([
        active("plugin-hook"; "plugin"; ($grokHome + "/installed-plugins/plugin/hooks/plugin-hook")),
        active("repository-hook"; "repository"; ($repository + "/.grok/hooks/repository-hook"))
      ]
      + personal_grok_entries("hooks")
      + compat_entries("hooks"; "hooks"; true)
      + plugin_children("hooks"; "hooks"; true)),
      plugins: ([{
        name: "hve-core-all",
        scope: "user",
        path: ($grokHome + "/installed-plugins/hve-core-fixture"),
        enabled: true,
        provides: {skills: 1, agents: 1, hooks: false, mcpServers: 0}
      }, {
        name: "support-plugin",
        scope: "user",
        path: ($grokHome + "/installed-plugins/support-plugin"),
        enabled: true,
        provides: {skills: 1, agents: 0, hooks: false, mcpServers: 0}
      }, {
        name: "repository-plugin",
        scope: "project",
        path: ($repository + "/.grok/plugins/repository-plugin"),
        enabled: true,
        provides: {skills: 1, agents: 0, hooks: false, mcpServers: 0}
      }]
      + (if $profileIsolated then [] else [{
          name: "personal-grok-plugin",
          scope: "user",
          path: ($home + "/.grok/plugins/personal-grok"),
          enabled: true,
          provides: {skills: 1, agents: 1, hooks: true, mcpServers: 1}
        }] end)
      + (if surface_present("claude"; "plugins") then [personal_plugin("claude")] else [] end)
      + (if surface_present("cursor"; "plugins") then [personal_plugin("cursor")] else [] end)),
      mcpServers: ([
        active("plugin-mcp"; "plugin"; ($grokHome + "/installed-plugins/plugin/mcps/plugin-mcp")),
        active("repository-mcp"; "repository"; ($repository + "/.grok/mcps/repository-mcp"))
      ]
      + personal_grok_entries("mcps")
      + compat_entries("mcps"; "mcps"; false)
      + plugin_children("mcps"; "mcps"; false)),
      externalCompat: {
        cells: $externalCells
      }
    }'
  exit 0
fi

is_management_call() {
  case "${1:-}" in
    inspect|plugin|mcp) return 0 ;;
    *) return 1 ;;
  esac
}

policy_fails_closed() {
  awk '
    /^[[:space:]]*\[/ { exit }
    $0 == "fail_closed = true" { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$GROK_HOME/requirements.toml"
}

if ! is_management_call "${1:-}" \
  && [ -f "$GROK_HOME/requirements.toml" ] \
  && ! policy_fails_closed; then
  rm -f "$GROK_HOME/requirements.toml"
fi

if [ "${1:-}" = '--fixture-capability-inventory' ]; then
  if [ -f "$plugins_file" ]; then
    jq -r '.[] | select(.status == "installed") | "plugin:\(.name)"' "$plugins_file"
  fi

  requirements="$GROK_HOME/requirements.toml"
  if [ "$GROK_HOME" = "$HOME/.grok" ] && [ -d "$HOME/.grok/skills" ]; then
    printf 'personal:grok-skill\n'
  fi
  if ! grep -Fxq 'ignore = ["~/.agents/skills", "~/.agents/commands"]' "$requirements" 2>/dev/null; then
    [ ! -d "$HOME/.agents/skills" ] || printf 'personal:agents-skill\n'
    [ ! -d "$HOME/.agents/commands" ] || printf 'personal:agents-command\n'
  fi
  [ ! -d "$PWD/.grok/skills" ] || printf 'repository:grok-skill\n'
  [ ! -d "$PWD/.agents/skills" ] || printf 'repository:agents-skill\n'
  [ ! -f "$PWD/AGENTS.md" ] || printf 'repository:AGENTS.md\n'
  [ ! -f "$PWD/CLAUDE.md" ] || printf 'repository:CLAUDE.md\n'
  if ! grep -Fxq 'skills = false' "$requirements" 2>/dev/null; then
    [ ! -d "$HOME/.claude/skills" ] || printf 'personal:claude-skill\n'
    [ ! -d "$HOME/.cursor/skills" ] || printf 'personal:cursor-skill\n'
    [ ! -d "$PWD/.claude/skills" ] || printf 'repository:claude-skill\n'
    [ ! -d "$PWD/.cursor/skills" ] || printf 'repository:cursor-skill\n'
  fi
  exit 0
fi

printf "GROK_HOME=%s\nHOME=%s\nCWD=%s\n" "$GROK_HOME" "$HOME" "$PWD"
for arg in "$@"; do
  printf "ARG=%s\n" "$arg"
done
FAKE_GROK
chmod 0555 "$fake_bin/grok"

cat >"$fake_bin/curl" <<'FAKE_CURL'
#!/bin/bash
set -euo pipefail

url="${!#}"
if [ "${FAKE_CURL_FAILURE_URL:-}" = "$url" ]; then
  printf 'fixture curl failure: %s\n' "$url" >&2
  exit 22
fi

if [ "${FAKE_CURL_RAW_NUL_URL:-}" = "$url" ]; then
  printf '\000'
fi

case "$url" in
  'https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json')
    if [ -n "${FAKE_CURL_HVE_MANIFEST_JSON:-}" ]; then
      printf '%s\n' "$FAKE_CURL_HVE_MANIFEST_JSON"
    else
      printf '%s\n' '{"plugins":[{"name":"hve-core-all","version":"3.3.101"}]}'
    fi
    ;;
  'https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json')
    printf '%s\n' '{"plugins":[{"name":"superpowers","version":"6.2.0"}]}'
    ;;
  *)
    printf 'fixture curl unknown URL: %s\n' "$url" >&2
    exit 22
    ;;
esac
FAKE_CURL
chmod 0555 "$fake_bin/curl"

export HOME="$fixture_home"
export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export FAKE_GROK_LOG="$fake_grok_log"

mkdir -p \
  "$HOME/.grok/skills/personal-grok" \
  "$HOME/.grok/agents/personal-grok" \
  "$HOME/.grok/hooks/personal-grok" \
  "$HOME/.grok/plugins/personal-grok" \
  "$HOME/.grok/mcps/personal-grok" \
  "$HOME/.agents/skills/personal-agents" \
  "$HOME/.agents/agents/personal-agents" \
  "$HOME/.agents/hooks/personal-agents" \
  "$HOME/.agents/plugins/personal-agents" \
  "$HOME/.agents/mcps/personal-agents" \
  "$HOME/.agents/commands" \
  "$HOME/.claude/skills/personal-claude" \
  "$HOME/.claude/agents/personal-claude" \
  "$HOME/.claude/hooks/personal-claude" \
  "$HOME/.claude/plugins/personal-claude" \
  "$HOME/.claude/mcps/personal-claude" \
  "$HOME/.cursor/skills/personal-cursor" \
  "$HOME/.cursor/agents/personal-cursor" \
  "$HOME/.cursor/hooks/personal-cursor" \
  "$HOME/.cursor/plugins/personal-cursor" \
  "$HOME/.cursor/mcps/personal-cursor"
printf 'personal command\n' >"$HOME/.agents/commands/personal.md"
printf 'source-auth\n' >"$HOME/.grok/auth.json"
chmod 0600 "$HOME/.grok/auth.json"

[ -x ./bin/grx ] || fail 'missing executable launcher'

help_output="$fixture_root/help.out"
./bin/grx --help >"$help_output"
assert_line '  grx setup PROFILE|--all' "$help_output"
assert_line '  grx PROFILE [GROK_ARGS...]' "$help_output"
assert_line '  grx list' "$help_output"
assert_line '  grx list --json' "$help_output"
assert_line '  grx doctor PROFILE' "$help_output"
assert_line '  grx update --check PROFILE|--all' "$help_output"
assert_line '  grx update PROFILE|--all' "$help_output"
assert_line '  grx repair PROFILE' "$help_output"

assert_invalid_catalog() {
  local invalid_catalog="$1"
  local fixture_name="$2"
  local stderr_file="$fixture_root/$fixture_name.err"

  if GRX_CATALOG="$invalid_catalog" ./bin/grx list \
    >"$fixture_root/$fixture_name.out" 2>"$stderr_file"; then
    fail "$fixture_name catalog unexpectedly succeeded"
  fi
  assert_line "grx: invalid catalog: $invalid_catalog" "$stderr_file"
}

unsafe_key_catalog="$fixture_root/unsafe-key.json"
jq --arg profile '../../../../../../tmp/grx-escape' \
  '.profiles = {($profile): .profiles.hve}' \
  "$prototype_root/catalog.json" >"$unsafe_key_catalog"
assert_invalid_catalog "$unsafe_key_catalog" 'unsafe profile key'

reserved_key_catalog="$fixture_root/reserved-key.json"
jq --arg profile 'list' \
  '.profiles = {($profile): .profiles.hve}' \
  "$prototype_root/catalog.json" >"$reserved_key_catalog"
assert_invalid_catalog "$reserved_key_catalog" 'reserved profile key'

changed_trust_catalog="$fixture_root/changed-trust-catalog.json"
jq '
  .profiles.hve.source = "fixture/alternate#plugins/alternate"
  | .profiles.hve.manifestUrl = "https://example.test/alternate.json"
  | .profiles.hve.plugin = "alternate"
' "$prototype_root/catalog.json" >"$changed_trust_catalog"
calls_before_changed_trust="$(wc -l <"$fake_grok_log" | tr -d ' ')"
if GRX_CATALOG="$changed_trust_catalog" ./bin/grx setup hve \
  >"$fixture_root/changed-trust.out" 2>"$fixture_root/changed-trust.err"; then
  fail 'launcher accepted an otherwise-valid changed trust catalog'
fi
assert_line "grx: invalid catalog: $changed_trust_catalog" \
  "$fixture_root/changed-trust.err"
calls_after_changed_trust="$(wc -l <"$fake_grok_log" | tr -d ' ')"
[ "$calls_after_changed_trust" = "$calls_before_changed_trust" ] \
  || fail 'changed trust catalog reached Grok'

unsafe_source_index=0
for unsafe_source in \
  'microsoft/hve-core#../hve-core-all' \
  'microsoft/hve-core#/plugins/hve-core-all' \
  'microsoft/hve-core#plugins//hve-core-all' \
  'microsoft/hve-core#plugins/./hve-core-all' \
  $'microsoft/hve-core\nmicrosoft/hve-core'; do
  unsafe_source_catalog="$fixture_root/unsafe-source-$(printf '%s' "$unsafe_source" | sha256_digest).json"
  jq --arg source "$unsafe_source" '.profiles.hve.source = $source' \
    "$prototype_root/catalog.json" >"$unsafe_source_catalog"
  assert_invalid_catalog "$unsafe_source_catalog" \
    "unsafe-plugin-source-$unsafe_source_index"
  unsafe_source_index=$((unsafe_source_index + 1))
done

catalog_unexpected_then_valid="$fixture_root/catalog-unexpected-then-valid.json"
{
  printf '%s\n' '{}'
  cat "$prototype_root/catalog.json"
} >"$catalog_unexpected_then_valid"
assert_invalid_catalog "$catalog_unexpected_then_valid" \
  'catalog-unexpected-then-valid-document'

catalog_valid_then_unexpected="$fixture_root/catalog-valid-then-unexpected.json"
{
  cat "$prototype_root/catalog.json"
  printf '%s\n' '{}'
} >"$catalog_valid_then_unexpected"
assert_invalid_catalog "$catalog_valid_then_unexpected" \
  'catalog-valid-then-unexpected-document'

worktree_with_spaces="$fixture_root/worktree with spaces"
mkdir -p "$worktree_with_spaces"
calls_before_unready_launch="$(wc -l <"$fake_grok_log" | tr -d ' ')"
if ./bin/grx hve --version >"$fixture_root/unready-launch.out" \
  2>"$fixture_root/unready-launch.err"; then
  fail 'launch accepted a profile that was not set up'
fi
assert_line 'grx: profile is not set up: hve' \
  "$fixture_root/unready-launch.err"
calls_after_unready_launch="$(wc -l <"$fake_grok_log" | tr -d ' ')"
[ "$calls_after_unready_launch" = "$calls_before_unready_launch" ] \
  || fail 'unready launch invoked Grok'

calls_before_root_home_launch="$(wc -l <"$fake_grok_log" | tr -d ' ')"
if HOME=/ ./bin/grx hve --version >"$fixture_root/root-home-launch.out" \
  2>"$fixture_root/root-home-launch.err"; then
  fail 'launch accepted HOME=/'
fi
assert_line 'grx: unsafe profile home path: /.local/share/trellage/profiles/grok/hve/home' \
  "$fixture_root/root-home-launch.err"
calls_after_root_home_launch="$(wc -l <"$fake_grok_log" | tr -d ' ')"
[ "$calls_after_root_home_launch" = "$calls_before_root_home_launch" ] \
  || fail 'root-HOME launch invoked Grok'

if jq -s -e 'any(.[]; .args[0:2] == ["plugin","install"] or .args[0:2] == ["plugin","update"])' \
  "$fake_grok_log" >/dev/null; then
  fail 'normal launches installed or updated a plugin'
fi

calls_before_list="$(wc -l <"$fake_grok_log" | tr -d ' ')"
list_output="$fixture_root/list.out"
./bin/grx list >"$list_output"
if ! cmp -s "$list_output" <(printf 'hve\thve-core-all\nsuperpowers\tsuperpowers\n'); then
  fail 'list output does not match the catalog'
fi
calls_after_list="$(wc -l <"$fake_grok_log" | tr -d ' ')"
[ "$calls_after_list" = "$calls_before_list" ] || fail 'list invoked Grok'

unknown_stderr="$fixture_root/unknown.err"
if ./bin/grx not-a-profile >"$fixture_root/unknown.out" 2>"$unknown_stderr"; then
  fail 'unknown profile unexpectedly succeeded'
fi
assert_contains 'grx: unknown profile: not-a-profile' "$unknown_stderr"

missing_check_output="$fixture_root/missing-check.out"
missing_check_stderr="$fixture_root/missing-check.err"
missing_check_status=0
./bin/grx update --check superpowers >"$missing_check_output" 2>"$missing_check_stderr" \
  || missing_check_status=$?
[ "$missing_check_status" -eq 1 ] \
  || fail "missing profile update check exited $missing_check_status instead of 1"
if ! cmp -s "$missing_check_output" <(printf 'superpowers: not installed\n'); then
  [ ! -s "$missing_check_stderr" ] || sed -n '1p' "$missing_check_stderr" >&2
  fail 'missing profile update check did not report exact not-installed output'
fi
[ ! -s "$missing_check_stderr" ] \
  || fail 'missing profile update check wrote stderr'
[ ! -e "$HOME/.local/share/trellage/profiles/grok" ] \
  || fail 'missing profile update check created managed state'

expected_policy="$fixture_root/expected-requirements.toml"
cat >"$expected_policy" <<'EXPECTED_POLICY'
fail_closed = true

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.codex]
sessions = false

[skills]
ignore = ["~/.agents/skills", "~/.agents/commands"]
EXPECTED_POLICY

hve_home="$HOME/.local/share/trellage/profiles/grok/hve/home"
hve_setup_output="$fixture_root/hve-setup.out"
./bin/grx setup hve >"$hve_setup_output"
assert_line 'hve: ready' "$hve_setup_output"
if ! cmp -s "$hve_setup_output" <(printf 'hve: ready\n'); then
  fail 'setup emitted output other than the exact ready line'
fi
cmp -s "$HOME/.grok/auth.json" "$hve_home/auth.json" \
  || fail 'setup did not copy source authentication'
[ "$(path_mode "$hve_home/auth.json")" = '600' ] \
  || fail 'setup did not set authentication mode 0600'
cmp -s "$expected_policy" "$hve_home/requirements.toml" \
  || fail 'setup did not write the exact capability policy'
jq -s -e --arg home "$hve_home" '
  any(.[];
    .grokHome == $home
    and .args == ["plugin","install","microsoft/hve-core#plugins/hve-core-all","--trust"]
  )
' "$fake_grok_log" >/dev/null || fail 'setup did not install the exact trusted HVE source'
if ! jq -s -e 'all(.[];
  .modelsBaseUrl == ""
  and .defaultModel == ""
  and .xaiApiKey == ""
)' "$fake_grok_log" >/dev/null; then
  fail 'setup received proxy routing variables'
fi
./bin/grx inventory hve --json >"$fixture_root/inventory-hve.json"
jq -e '
  .schemaVersion == 1
  and .launcher == "grx"
  and .harness == "grok"
  and .profile == "hve"
  and .readiness == "healthy"
  and .plugins == [
    {name:"hve-core-all",version:"3.3.101"},
    {name:"support-plugin",version:"unknown"}
  ]
  and .skills == {packageCount:1,visibleCount:8}
  and .mcps == ["native-mcp","plugin-mcp","repository-mcp"]
' "$fixture_root/inventory-hve.json" >/dev/null \
  || {
    cat "$fixture_root/inventory-hve.json" >&2
    fail 'Grok inventory output differs'
  }
./bin/grx inventory superpowers --json >"$fixture_root/inventory-not-setup.json"
jq -e '
  .profile == "superpowers"
  and .readiness == "not-setup"
  and .plugins == []
  and .skills == {packageCount:null,visibleCount:null}
  and .mcps == []
' "$fixture_root/inventory-not-setup.json" >/dev/null \
  || fail 'Grok not-setup inventory differs'

mkdir -p "$hve_home/sessions" "$hve_home/mcp-state"
printf 'session sentinel\n' >"$hve_home/sessions/keep"
printf 'mcp sentinel\n' >"$hve_home/mcp-state/keep"
printf 'profile config sentinel\n' >"$hve_home/config.toml"

assert_auth_refresh_preserves_profile_state() {
  local label="$1"
  local expected_auth="$2"
  local before_hash="$3"
  local before_outside_auth_hash="$4"

  cmp -s "$HOME/.grok/auth.json" "$hve_home/auth.json" \
    || fail "$label did not refresh authentication exactly"
  [ "$(path_mode "$hve_home/auth.json")" = '600' ] \
    || fail "$label did not leave authentication mode 0600"
  [ "$(profile_tree_hash "$hve_home")" != "$before_hash" ] \
    || fail "$label did not change stale authentication"
  [ "$(profile_tree_hash "$hve_home" outside-auth)" = "$before_outside_auth_hash" ] \
    || fail "$label changed profile config, MCP, session, or plugin state outside auth.json"
  assert_line "$expected_auth" "$hve_home/auth.json"
  assert_line 'session sentinel' "$hve_home/sessions/keep"
  assert_line 'mcp sentinel' "$hve_home/mcp-state/keep"
  assert_line 'profile config sentinel' "$hve_home/config.toml"
}

printf 'refresh-launch\n' >"$HOME/.grok/auth.json"
hve_refresh_before="$(profile_tree_hash "$hve_home")"
hve_refresh_outside_auth_before="$(profile_tree_hash "$hve_home" outside-auth)"
./bin/grx hve --auth-refresh-launch >"$fixture_root/auth-refresh-launch.out"
assert_auth_refresh_preserves_profile_state launch refresh-launch "$hve_refresh_before" "$hve_refresh_outside_auth_before"

printf 'refresh-doctor\n' >"$HOME/.grok/auth.json"
hve_refresh_before="$(profile_tree_hash "$hve_home")"
hve_refresh_outside_auth_before="$(profile_tree_hash "$hve_home" outside-auth)"
./bin/grx doctor hve >"$fixture_root/auth-refresh-doctor.out"
assert_auth_refresh_preserves_profile_state doctor refresh-doctor "$hve_refresh_before" "$hve_refresh_outside_auth_before"

printf 'refresh-update-check\n' >"$HOME/.grok/auth.json"
hve_refresh_before="$(profile_tree_hash "$hve_home")"
hve_refresh_outside_auth_before="$(profile_tree_hash "$hve_home" outside-auth)"
./bin/grx update --check hve >"$fixture_root/auth-refresh-update-check.out"
assert_auth_refresh_preserves_profile_state update-check refresh-update-check "$hve_refresh_before" "$hve_refresh_outside_auth_before"

printf 'refresh-update\n' >"$HOME/.grok/auth.json"
hve_refresh_before="$(profile_tree_hash "$hve_home")"
hve_refresh_outside_auth_before="$(profile_tree_hash "$hve_home" outside-auth)"
./bin/grx update hve >"$fixture_root/auth-refresh-update.out"
assert_auth_refresh_preserves_profile_state update refresh-update "$hve_refresh_before" "$hve_refresh_outside_auth_before"

printf 'refresh-repair\n' >"$HOME/.grok/auth.json"
hve_refresh_before="$(profile_tree_hash "$hve_home")"
hve_refresh_outside_auth_before="$(profile_tree_hash "$hve_home" outside-auth)"
./bin/grx repair hve >"$fixture_root/auth-refresh-repair.out"
assert_auth_refresh_preserves_profile_state repair refresh-repair "$hve_refresh_before" "$hve_refresh_outside_auth_before"

chmod 0644 "$hve_home/auth.json"
hve_auth_inode="$(path_inode "$hve_home/auth.json")"
./bin/grx update --check hve >"$fixture_root/auth-identical-update-check.out"
[ "$(path_inode "$hve_home/auth.json")" = "$hve_auth_inode" ] \
  || fail 'identical authentication refresh replaced destination inode'
[ "$(path_mode "$hve_home/auth.json")" = '600' ] \
  || fail 'identical authentication refresh did not enforce mode 0600'

printf 'refresh-list-must-not-copy\n' >"$HOME/.grok/auth.json"
hve_auth_inode="$(path_inode "$hve_home/auth.json")"
cp "$hve_home/auth.json" "$fixture_root/auth-before-list"
managed_stale_guard_status=0
GROK_HOME="$hve_home" "$fake_bin/grok" --managed-stale-auth-control \
  >"$fixture_root/managed-stale-auth-control.out" \
  2>"$fixture_root/managed-stale-auth-control.err" \
  || managed_stale_guard_status=$?
[ "$managed_stale_guard_status" -eq 93 ] \
  || fail "managed stale-auth control exited $managed_stale_guard_status instead of 93"
calls_before_auth_list="$(wc -l <"$fake_grok_log" | tr -d ' ')"
./bin/grx list >"$fixture_root/auth-refresh-list.out"
cmp -s "$fixture_root/auth-before-list" "$hve_home/auth.json" \
  || fail 'list refreshed profile authentication'
[ "$(path_inode "$hve_home/auth.json")" = "$hve_auth_inode" ] \
  || fail 'list replaced profile authentication inode'
calls_after_auth_list="$(wc -l <"$fake_grok_log" | tr -d ' ')"
[ "$calls_after_auth_list" = "$calls_before_auth_list" ] \
  || fail 'list invoked Grok while checking authentication refresh behavior'

calls_before_auth_failure="$(wc -l <"$fake_grok_log" | tr -d ' ')"
mv "$HOME/.grok/auth.json" "$fixture_root/source-auth-saved"
ln -s "$fixture_root/source-auth-saved" "$HOME/.grok/auth.json"
if ./bin/grx hve --source-auth-symlink >"$fixture_root/source-auth-symlink.out" \
  2>"$fixture_root/source-auth-symlink.err"; then
  fail 'launch accepted symlinked source authentication'
fi
assert_line "grx: source authentication is missing or unreadable: $HOME/.grok/auth.json" \
  "$fixture_root/source-auth-symlink.err"
rm "$HOME/.grok/auth.json"
mv "$fixture_root/source-auth-saved" "$HOME/.grok/auth.json"
[ "$(wc -l <"$fake_grok_log" | tr -d ' ')" = "$calls_before_auth_failure" ] \
  || fail 'symlinked source authentication invoked Grok'

mv "$hve_home/auth.json" "$fixture_root/profile-auth-saved"
printf 'outside auth sentinel\n' >"$fixture_root/outside-auth"
ln -s "$fixture_root/outside-auth" "$hve_home/auth.json"
if ./bin/grx hve --destination-auth-symlink \
  >"$fixture_root/destination-auth-symlink.out" \
  2>"$fixture_root/destination-auth-symlink.err"; then
  fail 'launch accepted symlinked destination authentication'
fi
assert_line 'outside auth sentinel' "$fixture_root/outside-auth"
rm "$hve_home/auth.json"
mv "$fixture_root/profile-auth-saved" "$hve_home/auth.json"
[ "$(wc -l <"$fake_grok_log" | tr -d ' ')" = "$calls_before_auth_failure" ] \
  || fail 'symlinked destination authentication invoked Grok'

printf 'refresh-publication-failure\n' >"$HOME/.grok/auth.json"
cp "$hve_home/auth.json" "$fixture_root/auth-before-publication-failure"
hve_auth_inode="$(path_inode "$hve_home/auth.json")"
real_mv="$(command -v mv)"
cat >"$fake_bin/mv" <<'FAKE_MV'
#!/bin/bash
for argument in "$@"; do
  case "$argument" in
    */.auth.backup.*) ;;
    */.auth.*) exit 73 ;;
  esac
done
exec "$GRX_TEST_REAL_MV" "$@"
FAKE_MV
chmod 0555 "$fake_bin/mv"
if GRX_TEST_REAL_MV="$real_mv" ./bin/grx hve --auth-publication-failure \
  >"$fixture_root/auth-publication-failure.out" \
  2>"$fixture_root/auth-publication-failure.err"; then
  fail 'authentication publication failure unexpectedly launched Grok'
fi
assert_line 'grx: failed to publish profile authentication' \
  "$fixture_root/auth-publication-failure.err"
cmp -s "$fixture_root/auth-before-publication-failure" "$hve_home/auth.json" \
  || fail 'failed authentication publication changed prior bytes'
[ "$(path_inode "$hve_home/auth.json")" = "$hve_auth_inode" ] \
  || fail 'failed authentication publication changed prior inode'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'failed authentication publication left staging debris'
rm "$fake_bin/mv"
cp "$HOME/.grok/auth.json" "$hve_home/auth.json"
chmod 0600 "$hve_home/auth.json"

mv "$HOME/.grok/auth.json" "$fixture_root/missing-update-auth-saved"
missing_update_auth_status=0
./bin/grx update --check hve >"$fixture_root/missing-update-auth.out" \
  2>"$fixture_root/missing-update-auth.err" || missing_update_auth_status=$?
[ "$missing_update_auth_status" -eq 2 ] \
  || fail "missing-auth update check exited $missing_update_auth_status instead of 2"
assert_line "grx: source authentication is missing or unreadable: $HOME/.grok/auth.json" \
  "$fixture_root/missing-update-auth.err"
mv "$fixture_root/missing-update-auth-saved" "$HOME/.grok/auth.json"

chmod 0000 "$HOME/.grok/auth.json"
unreadable_update_auth_status=0
./bin/grx update --check hve >"$fixture_root/unreadable-update-auth.out" \
  2>"$fixture_root/unreadable-update-auth.err" || unreadable_update_auth_status=$?
[ "$unreadable_update_auth_status" -eq 2 ] \
  || fail "unreadable-auth update check exited $unreadable_update_auth_status instead of 2"
assert_line "grx: source authentication is missing or unreadable: $HOME/.grok/auth.json" \
  "$fixture_root/unreadable-update-auth.err"
chmod 0600 "$HOME/.grok/auth.json"

mkdir "$hve_home/.auth.lock-owned.stale"
printf '.auth.lock-owned.stale\n' >"$hve_home/.auth.lock-owned.stale/token"
printf '999999999\n' >"$hve_home/.auth.lock-owned.stale/pid"
ln "$hve_home/.auth.lock-owned.stale/token" "$hve_home/.auth.lock"
stale_auth_lock_status=0
./bin/grx update --check hve >"$fixture_root/stale-auth-lock.out" \
  2>"$fixture_root/stale-auth-lock.err" || stale_auth_lock_status=$?
[ "$stale_auth_lock_status" -eq 2 ] \
  || fail "stale auth lock update check exited $stale_auth_lock_status instead of 2"
assert_line "grx: stale profile authentication lock: $hve_home/.auth.lock" \
  "$fixture_root/stale-auth-lock.err"
rm "$hve_home/.auth.lock" "$hve_home/.auth.lock-owned.stale/pid" \
  "$hve_home/.auth.lock-owned.stale/token"
rmdir "$hve_home/.auth.lock-owned.stale"

for auth_signal in HUP INT TERM; do
  printf 'signal-source-%s\n' "$auth_signal" >"$HOME/.grok/auth.json"
  printf 'signal-target-before\n' >"$hve_home/auth.json"
  chmod 0600 "$hve_home/auth.json"
  signal_auth_inode="$(path_inode "$hve_home/auth.json")"
  signal_status=0
  GRX_AUTH_TEST_SIGNAL_AFTER_STAGE="$auth_signal" \
    ./bin/grx update --check hve >"$fixture_root/auth-signal-$auth_signal.out" \
    2>"$fixture_root/auth-signal-$auth_signal.err" || signal_status=$?
  case "$auth_signal:$signal_status" in
    HUP:129|INT:130|TERM:143) ;;
    *) fail "$auth_signal-interrupted auth refresh exited $signal_status" ;;
  esac
  assert_line 'signal-target-before' "$hve_home/auth.json"
  [ "$(path_inode "$hve_home/auth.json")" = "$signal_auth_inode" ] \
    || fail "$auth_signal-interrupted auth refresh replaced prior target"
  [ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
    || fail "$auth_signal-interrupted auth refresh left credential staging debris"
  [ ! -e "$hve_home/.auth.lock" ] && [ ! -L "$hve_home/.auth.lock" ] \
    || fail "$auth_signal-interrupted auth refresh left its lock"
done

for signal_window in LOCK_ACQUIRE AFTER_PUBLISH LOCK_RELEASE; do
  for auth_signal in HUP INT TERM; do
    printf 'window-source-%s-%s\n' "$signal_window" "$auth_signal" >"$HOME/.grok/auth.json"
    printf 'window-target-before\n' >"$hve_home/auth.json"
    chmod 0640 "$hve_home/auth.json"
    window_inode="$(path_inode "$hve_home/auth.json")"
    window_status=0
    env "GRX_AUTH_TEST_SIGNAL_${signal_window}=$auth_signal" \
      ./bin/grx update --check hve >"$fixture_root/window-$signal_window-$auth_signal.out" \
      2>"$fixture_root/window-$signal_window-$auth_signal.err" || window_status=$?
    case "$auth_signal:$window_status" in HUP:129|INT:130|TERM:143) ;; *)
      fail "$signal_window/$auth_signal exited $window_status" ;; esac
    if [ "$signal_window" = 'LOCK_RELEASE' ]; then
      assert_line "window-source-$signal_window-$auth_signal" "$hve_home/auth.json"
      [ "$(path_mode "$hve_home/auth.json")" = '600' ] \
        || fail "$signal_window/$auth_signal did not retain committed target mode"
    else
      assert_line 'window-target-before' "$hve_home/auth.json"
      [ "$(path_inode "$hve_home/auth.json")" = "$window_inode" ] \
        || fail "$signal_window/$auth_signal changed entry inode"
      [ "$(path_mode "$hve_home/auth.json")" = '640' ] \
        || fail "$signal_window/$auth_signal changed entry mode"
    fi
    [ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
      || fail "$signal_window/$auth_signal left auth debris"
  done
done

printf 'release-window-first\n' >"$HOME/.grok/auth.json"
printf 'release-window-entry\n' >"$hve_home/auth.json"
release_window_marker="$fixture_root/release-window-marker"
GRX_AUTH_TEST_RELEASE_MARKER="$release_window_marker" \
  ./bin/grx update --check hve >"$fixture_root/release-window-first.out" \
  2>"$fixture_root/release-window-first.err" &
release_window_pid=$!
wait_for_file "$release_window_marker"
printf 'release-window-second\n' >"$HOME/.grok/auth.json"
release_window_second_status=0
./bin/grx update --check hve >"$fixture_root/release-window-second.out" \
  2>"$fixture_root/release-window-second.err" || release_window_second_status=$?
[ "$release_window_second_status" -eq 0 ] \
  || fail "release-window second refresh exited $release_window_second_status"
kill -TERM "$release_window_pid"
release_window_first_status=0
wait "$release_window_pid" || release_window_first_status=$?
[ "$release_window_first_status" -eq 143 ] \
  || fail "release-window first refresh exited $release_window_first_status"
assert_line 'release-window-second' "$hve_home/auth.json"
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'release-window concurrency left auth debris'

for auth_signal in HUP INT TERM; do
  printf 'absent-source-%s\n' "$auth_signal" >"$HOME/.grok/auth.json"
  rm -f "$hve_home/auth.json"
  absent_status=0
  GRX_AUTH_TEST_SIGNAL_AFTER_PUBLISH="$auth_signal" \
    ./bin/grx update --check hve >"$fixture_root/absent-$auth_signal.out" \
    2>"$fixture_root/absent-$auth_signal.err" || absent_status=$?
  case "$auth_signal:$absent_status" in HUP:129|INT:130|TERM:143) ;; *)
    fail "absent AFTER_PUBLISH/$auth_signal exited $absent_status" ;; esac
  [ ! -e "$hve_home/auth.json" ] && [ ! -L "$hve_home/auth.json" ] \
    || fail "absent AFTER_PUBLISH/$auth_signal created auth target"
  [ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
    || fail "absent AFTER_PUBLISH/$auth_signal left auth debris"
done

printf 'rotation-source-0\n' >"$HOME/.grok/auth.json"
printf 'rotation-entry-state\n' >"$hve_home/auth.json"
chmod 0640 "$hve_home/auth.json"
rotation_inode="$(path_inode "$hve_home/auth.json")"
real_mv="$(command -v mv)"
cat >"$fake_bin/mv" <<'FAKE_MV_ROTATE'
#!/bin/bash
first=''
last=''
for argument in "$@"; do
  case "$argument" in -*) ;; *) [ -n "$first" ] || first="$argument"; last="$argument" ;; esac
done
"$GRX_TEST_REAL_MV" "$@" || exit $?
case "$first:$last" in
  */.auth.backup.*:*) ;;
  */.auth.*:"$GRX_TEST_AUTH_TARGET")
    count=0
    [ ! -f "$GRX_TEST_ROTATION_COUNT" ] || count="$(cat "$GRX_TEST_ROTATION_COUNT")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$GRX_TEST_ROTATION_COUNT"
    printf 'rotation-source-%s\n' "$count" >"$GRX_TEST_AUTH_SOURCE"
    ;;
esac
FAKE_MV_ROTATE
chmod 0555 "$fake_bin/mv"
rotation_status=0
GRX_TEST_REAL_MV="$real_mv" GRX_TEST_AUTH_TARGET="$hve_home/auth.json" \
  GRX_TEST_AUTH_SOURCE="$HOME/.grok/auth.json" \
  GRX_TEST_ROTATION_COUNT="$fixture_root/rotation-count" \
  ./bin/grx update --check hve >"$fixture_root/rotation-exhaustion.out" \
  2>"$fixture_root/rotation-exhaustion.err" || rotation_status=$?
[ "$rotation_status" -eq 2 ] || fail "rotation exhaustion exited $rotation_status"
assert_line "grx: source authentication did not stabilize: $HOME/.grok/auth.json" \
  "$fixture_root/rotation-exhaustion.err"
assert_line 'rotation-entry-state' "$hve_home/auth.json"
[ "$(path_inode "$hve_home/auth.json")" = "$rotation_inode" ] \
  || fail 'rotation exhaustion did not restore entry inode'
[ "$(path_mode "$hve_home/auth.json")" = '640' ] \
  || fail 'rotation exhaustion did not restore entry mode'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'rotation exhaustion left auth debris'

printf 'rotation-absent-source-0\n' >"$HOME/.grok/auth.json"
rm -f "$hve_home/auth.json" "$fixture_root/rotation-count"
rotation_absent_status=0
GRX_TEST_REAL_MV="$real_mv" GRX_TEST_AUTH_TARGET="$hve_home/auth.json" \
  GRX_TEST_AUTH_SOURCE="$HOME/.grok/auth.json" \
  GRX_TEST_ROTATION_COUNT="$fixture_root/rotation-count" \
  ./bin/grx update --check hve >"$fixture_root/rotation-absent.out" \
  2>"$fixture_root/rotation-absent.err" || rotation_absent_status=$?
[ "$rotation_absent_status" -eq 2 ] \
  || fail "absent rotation exhaustion exited $rotation_absent_status"
assert_line "grx: source authentication did not stabilize: $HOME/.grok/auth.json" \
  "$fixture_root/rotation-absent.err"
[ ! -e "$hve_home/auth.json" ] && [ ! -L "$hve_home/auth.json" ] \
  || fail 'absent rotation exhaustion created auth target'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'absent rotation exhaustion left auth debris'
rm "$fake_bin/mv"

printf 'fast-path-stable\n' >"$HOME/.grok/auth.json"
printf 'fast-path-entry-before\n' >"$hve_home/auth.json"
chmod 0640 "$hve_home/auth.json"
fast_path_real_cp="$(command -v cp)"
cat >"$fake_bin/mv" <<'FAKE_MV_FAST_PATH'
#!/bin/bash
first=''
last=''
for argument in "$@"; do
  case "$argument" in -*) ;; *) [ -n "$first" ] || first="$argument"; last="$argument" ;; esac
done
"$GRX_TEST_REAL_MV" "$@" || exit $?
case "$first:$last" in
  */.auth.backup.*:*) ;;
  */.auth.*:"$GRX_TEST_AUTH_TARGET")
    if [ ! -e "$GRX_TEST_FAST_PATH_MARKER" ]; then
      "$GRX_TEST_REAL_CP" "$GRX_TEST_AUTH_SOURCE" "$GRX_TEST_AUTH_SOURCE.swap"
      "$GRX_TEST_REAL_MV" -f "$GRX_TEST_AUTH_SOURCE.swap" "$GRX_TEST_AUTH_SOURCE"
      : >"$GRX_TEST_FAST_PATH_MARKER"
    fi
    ;;
esac
FAKE_MV_FAST_PATH
chmod 0555 "$fake_bin/mv"
fast_path_status=0
GRX_TEST_REAL_MV="$real_mv" GRX_TEST_REAL_CP="$fast_path_real_cp" \
  GRX_TEST_AUTH_TARGET="$hve_home/auth.json" \
  GRX_TEST_AUTH_SOURCE="$HOME/.grok/auth.json" \
  GRX_TEST_FAST_PATH_MARKER="$fixture_root/fast-path-marker" \
  ./bin/grx update --check hve >"$fixture_root/fast-path.out" \
  2>"$fixture_root/fast-path.err" || fast_path_status=$?
[ "$fast_path_status" -eq 0 ] || fail "fast-path stabilization exited $fast_path_status"
assert_line 'fast-path-stable' "$hve_home/auth.json"
[ "$(path_mode "$hve_home/auth.json")" = '600' ] \
  || fail 'fast-path stabilization did not commit target mode'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'fast-path stabilization left auth debris'
rm "$fake_bin/mv"

printf 'race-old\n' >"$HOME/.grok/auth.json"
printf 'race-target-before\n' >"$hve_home/auth.json"
chmod 0600 "$HOME/.grok/auth.json" "$hve_home/auth.json"
real_cp="$(command -v cp)"
cat >"$fake_bin/cp" <<'FAKE_CP_RACE'
#!/bin/bash
"$GRX_TEST_REAL_CP" "$@" || exit $?
case "${1:-}" in
  */.grok/auth.json)
    if [ -n "${GRX_TEST_RACE_MARKER:-}" ] \
      && [ ! -e "$GRX_TEST_RACE_MARKER" ]; then
      : >"$GRX_TEST_RACE_MARKER"
      while [ ! -e "$GRX_TEST_RACE_RELEASE" ]; do sleep 0.05; done
    fi
    ;;
esac
FAKE_CP_RACE
chmod 0555 "$fake_bin/cp"
real_sed="$(command -v sed)"
cat >"$fake_bin/sed" <<'FAKE_SED_AUTH_LOCK'
#!/bin/bash
lock_path="${@: -1}"
if [ "${GRX_TEST_LOCK_READ_MODE:-}" = 'release-before-read' ] \
  && [ "$lock_path" = "$GRX_TEST_AUTH_LOCK" ]; then
  : >"$GRX_TEST_LOCK_READ_MARKER"
  while [ ! -e "$GRX_TEST_LOCK_READ_CONTINUE" ]; do sleep 0.05; done
fi
if [ "${GRX_TEST_LOCK_READ_MODE:-}" = 'capture-before-handoff' ] \
  && [ "$lock_path" = "$GRX_TEST_AUTH_LOCK" ]; then
  captured_lock_target="$("$GRX_TEST_REAL_SED" "$@")"
  captured_status=$?
  : >"$GRX_TEST_LOCK_READ_MARKER"
  while [ ! -e "$GRX_TEST_LOCK_READ_CONTINUE" ]; do sleep 0.05; done
  printf '%s\n' "$captured_lock_target"
  exit "$captured_status"
fi
exec "$GRX_TEST_REAL_SED" "$@"
FAKE_SED_AUTH_LOCK
chmod 0555 "$fake_bin/sed"
race_marker="$fixture_root/auth-race-copied-old"
race_release="$fixture_root/auth-race-release"
GRX_TEST_REAL_CP="$real_cp" GRX_TEST_RACE_MARKER="$race_marker" \
  GRX_TEST_RACE_RELEASE="$race_release" \
  ./bin/grx update --check hve \
  >"$fixture_root/auth-race-old.out" 2>"$fixture_root/auth-race-old.err" &
race_old_pid=$!
wait_for_file "$race_marker"
printf 'race-new\n' >"$HOME/.grok/auth.json"
GRX_TEST_REAL_CP="$real_cp" GRX_TEST_RACE_MARKER="$race_marker" \
  GRX_TEST_RACE_RELEASE="$race_release" \
  GRX_TEST_REAL_SED="$real_sed" \
  GRX_TEST_LOCK_READ_MODE='release-before-read' \
  GRX_TEST_AUTH_LOCK="$hve_home/.auth.lock" \
  GRX_TEST_LOCK_READ_MARKER="$fixture_root/auth-race-lock-read" \
  GRX_TEST_LOCK_READ_CONTINUE="$fixture_root/auth-race-lock-read-continue" \
  ./bin/grx update --check hve \
  >"$fixture_root/auth-race-new.out" 2>"$fixture_root/auth-race-new.err" &
race_new_pid=$!
wait_for_file "$fixture_root/auth-race-lock-read"
: >"$race_release"
race_old_status=0
wait "$race_old_pid" || race_old_status=$?
: >"$fixture_root/auth-race-lock-read-continue"
race_new_status=0
wait "$race_new_pid" || race_new_status=$?
[ "$race_old_status" -eq 0 ] && [ "$race_new_status" -eq 0 ] \
  || fail "concurrent auth refreshes failed: old=$race_old_status new=$race_new_status"
assert_line 'race-new' "$hve_home/auth.json"
cmp -s "$HOME/.grok/auth.json" "$hve_home/auth.json" \
  || fail 'concurrent auth refresh returned with stale destination bytes'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'concurrent auth refresh left staging debris'
[ ! -e "$hve_home/.auth.lock" ] && [ ! -L "$hve_home/.auth.lock" ] \
  || fail 'concurrent auth refresh left its lock'

printf 'handoff-new\n' >"$HOME/.grok/auth.json"
printf 'handoff-target-before\n' >"$hve_home/auth.json"
chmod 0600 "$HOME/.grok/auth.json" "$hve_home/auth.json"
handoff_owner_one_marker="$fixture_root/auth-handoff-owner-one"
handoff_owner_one_release="$fixture_root/auth-handoff-owner-one-release"
GRX_TEST_REAL_CP="$real_cp" \
  GRX_TEST_RACE_MARKER="$handoff_owner_one_marker" \
  GRX_TEST_RACE_RELEASE="$handoff_owner_one_release" \
  ./bin/grx update --check hve \
  >"$fixture_root/auth-handoff-owner-one.out" \
  2>"$fixture_root/auth-handoff-owner-one.err" &
handoff_owner_one_pid=$!
wait_for_file "$handoff_owner_one_marker"

handoff_waiter_cp_marker="$fixture_root/auth-handoff-waiter-cp-skip"
: >"$handoff_waiter_cp_marker"
GRX_TEST_REAL_CP="$real_cp" \
  GRX_TEST_RACE_MARKER="$handoff_waiter_cp_marker" \
  GRX_TEST_RACE_RELEASE="$fixture_root/auth-handoff-waiter-unused-release" \
  GRX_TEST_REAL_SED="$real_sed" \
  GRX_TEST_LOCK_READ_MODE='capture-before-handoff' \
  GRX_TEST_AUTH_LOCK="$hve_home/.auth.lock" \
  GRX_TEST_LOCK_READ_MARKER="$fixture_root/auth-handoff-lock-captured" \
  GRX_TEST_LOCK_READ_CONTINUE="$fixture_root/auth-handoff-lock-continue" \
  ./bin/grx update --check hve \
  >"$fixture_root/auth-handoff-waiter.out" \
  2>"$fixture_root/auth-handoff-waiter.err" &
handoff_waiter_pid=$!
wait_for_file "$fixture_root/auth-handoff-lock-captured"

: >"$handoff_owner_one_release"
handoff_owner_one_status=0
wait "$handoff_owner_one_pid" || handoff_owner_one_status=$?

printf 'handoff-owner-two\n' >"$HOME/.grok/auth.json"
handoff_owner_two_marker="$fixture_root/auth-handoff-owner-two"
handoff_owner_two_release="$fixture_root/auth-handoff-owner-two-release"
GRX_TEST_REAL_CP="$real_cp" \
  GRX_TEST_RACE_MARKER="$handoff_owner_two_marker" \
  GRX_TEST_RACE_RELEASE="$handoff_owner_two_release" \
  ./bin/grx update --check hve \
  >"$fixture_root/auth-handoff-owner-two.out" \
  2>"$fixture_root/auth-handoff-owner-two.err" &
handoff_owner_two_pid=$!
wait_for_file "$handoff_owner_two_marker"
: >"$fixture_root/auth-handoff-lock-continue"
: >"$handoff_owner_two_release"

handoff_owner_two_status=0
wait "$handoff_owner_two_pid" || handoff_owner_two_status=$?
handoff_waiter_status=0
wait "$handoff_waiter_pid" || handoff_waiter_status=$?
[ "$handoff_owner_one_status" -eq 0 ] \
  && [ "$handoff_owner_two_status" -eq 0 ] \
  && [ "$handoff_waiter_status" -eq 0 ] \
  || fail "lock-owner handoff failed: first=$handoff_owner_one_status second=$handoff_owner_two_status waiter=$handoff_waiter_status"
assert_line 'handoff-owner-two' "$hve_home/auth.json"
[ -z "$(find "$hve_home" -maxdepth 1 -name '.auth.*' -print -quit)" ] \
  || fail 'lock-owner handoff left auth debris'
[ ! -e "$hve_home/.auth.lock" ] && [ ! -L "$hve_home/.auth.lock" ] \
  || fail 'lock-owner handoff left its lock'
rm "$fake_bin/cp" "$fake_bin/sed"

launch_output="$fixture_root/launch.out"
launch_tty_log="$fixture_root/launch-tty.log"
expected_launch_tty=0
if [ -t 0 ]; then
  expected_launch_tty=1
fi
(
  cd "$worktree_with_spaces"
  FAKE_GROK_TTY_LOG="$launch_tty_log" \
    "$prototype_root/bin/grx" hve --model 'grok-code-fast-1' -p 'hello world' -- --literal
) >"$launch_output"
expected_launch_json="$(jq -cn \
  --arg grokHome "$hve_home" \
  --arg home "$HOME" \
  --arg cwd "$worktree_with_spaces" \
  '{
    grokHome:$grokHome,
    home:$home,
    cwd:$cwd,
    modelsBaseUrl:"http://127.0.0.1:8080/v1",
    defaultModel:"grok-4.5",
    xaiApiKey:"local-copilot-proxy",
    args:["--permission-mode","bypassPermissions","--model","grok-code-fast-1","-p","hello world","--","--literal"]
  }')"
last_launch_json="$(tail -n 1 "$fake_grok_log")"
[ "$last_launch_json" = "$expected_launch_json" ] \
  || fail 'launch did not set proxy routing while preserving profile home, HOME, cwd, and ordered arguments'
assert_line "$expected_launch_tty" "$launch_tty_log"

./bin/grx hve -m 'gpt-5.2-codex' -p 'short model flag' \
  >"$fixture_root/short-model-launch.out"
jq -s -e '
  last
  | .modelsBaseUrl == "http://127.0.0.1:8080/v1"
  and .defaultModel == "grok-4.5"
  and .xaiApiKey == "local-copilot-proxy"
  and .args == ["--permission-mode","bypassPermissions","-m","gpt-5.2-codex","-p","short model flag"]
' "$fake_grok_log" >/dev/null \
  || fail 'launch did not preserve the explicit short model override'

./bin/grx hve --permission-mode plan -p 'explicit permission mode' \
  >"$fixture_root/explicit-permission-mode-launch.out"
jq -s -e '
  last
  | .args == ["--permission-mode","plan","-p","explicit permission mode"]
' "$fake_grok_log" >/dev/null \
  || fail 'launch did not preserve an explicit permission mode'

./bin/grx hve --deny shell -p 'explicit deny rule' \
  >"$fixture_root/explicit-deny-launch.out"
jq -s -e '
  last
  | .args == ["--deny","shell","-p","explicit deny rule"]
' "$fake_grok_log" >/dev/null \
  || fail 'launch did not preserve an explicit deny rule'

for permission_option in \
  '--permission-mode=default' \
  '--always-approve' \
  '--allow=shell' \
  '--allowedTools=shell' \
  '--deny=shell' \
  '--disallowedTools=shell'; do
  ./bin/grx hve "$permission_option" -p 'explicit permission option' \
    >"$fixture_root/explicit-permission-option-launch.out"
  jq -s -e --arg option "$permission_option" '
    last
    | .args == [$option,"-p","explicit permission option"]
  ' "$fake_grok_log" >/dev/null \
    || fail "launch did not preserve explicit permission option: $permission_option"
done

./bin/grx hve -p 'literal permission option' -- --permission-mode=plan \
  >"$fixture_root/literal-permission-option-launch.out"
jq -s -e '
  last
  | .args == ["--permission-mode","bypassPermissions","-p","literal permission option","--","--permission-mode=plan"]
' "$fake_grok_log" >/dev/null \
  || fail 'a literal permission-looking argument suppressed the default permission mode'

hve_policy_before_live_launch="$fixture_root/hve-policy-before-live-launch.toml"
cp "$hve_home/requirements.toml" "$hve_policy_before_live_launch"
./bin/grx hve --fixture-live-session >"$fixture_root/hve-live-launch.out"
[ -f "$hve_home/requirements.toml" ] \
  || fail 'live launch removed the managed requirements policy'
cmp -s "$hve_policy_before_live_launch" "$hve_home/requirements.toml" \
  || fail 'live launch changed the managed requirements policy'
[ "$(path_mode "$hve_home/requirements.toml")" = '644' ] \
  || fail 'live launch changed the managed requirements policy mode'
./bin/grx doctor hve >"$fixture_root/hve-after-live-doctor.out"
assert_line 'hve: healthy (plugin hve-core-all, version 3.3.101)' \
  "$fixture_root/hve-after-live-doctor.out"
jq -s -e '
  [ .[] | select(
      .args == ["plugin","list","--json"]
      or .args == ["mcp","list","--json"]
      or .args == ["inspect","--json"]
    ) ]
  | all(.[];
      .modelsBaseUrl == ""
      and .defaultModel == ""
      and .xaiApiKey == "")
' "$fake_grok_log" >/dev/null \
  || fail 'lifecycle validation received proxy routing variables'

assert_launch_repairs_current_policy() {
  local fixture_name="$1"
  local calls_before
  local calls_after

  calls_before="$(wc -l <"$fake_grok_log" | tr -d ' ')"
  ./bin/grx hve inspect --json >"$fixture_root/$fixture_name-inspect.out" \
    2>"$fixture_root/$fixture_name-inspect.err" \
    || fail "launch did not repair the $fixture_name policy"
  cmp -s "$expected_policy" "$hve_home/requirements.toml" \
    || fail "launch did not restore the $fixture_name policy"
  calls_after="$(wc -l <"$fake_grok_log" | tr -d ' ')"
  [ "$calls_after" -gt "$calls_before" ] \
    || fail "launch did not invoke Grok after repairing the $fixture_name policy"
}

hve_old_policy="$fixture_root/hve-old-requirements.toml"
sed '1,2d' "$expected_policy" >"$hve_old_policy"
cp "$hve_old_policy" "$hve_home/requirements.toml"
if ./bin/grx doctor hve >"$fixture_root/missing-fail-closed.out" \
  2>"$fixture_root/missing-fail-closed.err"; then
  fail 'doctor accepted policy without fail_closed'
fi
assert_line 'grx: requirements policy does not match: hve' \
  "$fixture_root/missing-fail-closed.err"
assert_launch_repairs_current_policy 'missing-fail-closed'
cmp -s "$expected_policy" "$hve_home/requirements.toml" \
  || fail 'launch did not restore missing fail_closed = true'
cp "$hve_old_policy" "$hve_home/requirements.toml"
./bin/grx setup hve >"$fixture_root/hve-old-policy-upgrade.out"
assert_line 'hve: ready' "$fixture_root/hve-old-policy-upgrade.out"
cmp -s "$expected_policy" "$hve_home/requirements.toml" \
  || fail 'setup did not upgrade the otherwise-safe old policy'

hve_plugins_file="$hve_home/fake-state/plugins.json"
hve_install_path="$hve_home/installed-plugins/hve-core-fixture"
hve_local_manifest="$hve_install_path/plugins/hve-core-all/.github/plugin/plugin.json"
jq -e --arg path "$hve_install_path" '. == [{
  status:"installed",
  name:"hve-core-all",
  repo_key:"hve-core-fixture",
  version:null,
  path:$path,
  source:"https://github.com/microsoft/hve-core",
  marketplace:null
}]' "$hve_plugins_file" >/dev/null \
  || fail 'fake Grok did not emit native HVE inventory'
jq -e '. == {
  name:"hve-core-all",
  version:"3.3.101",
  repository:"https://github.com/microsoft/hve-core"
}' "$hve_local_manifest" >/dev/null \
  || fail 'fake Grok did not materialize the HVE plugin manifest'

hve_doctor_output="$fixture_root/hve-doctor.out"
./bin/grx doctor hve >"$hve_doctor_output"
if ! cmp -s "$hve_doctor_output" <(printf 'hve: healthy (plugin hve-core-all, version 3.3.101)\n'); then
  fail 'doctor did not report the exact healthy HVE version'
fi

hve_poisoned_base_inventory="$(cat "$hve_plugins_file")"
hve_poisoned_inventory="$(printf '%s\n' "$hve_poisoned_base_inventory" | jq -c '. + [{
  status: "installed",
  name: "rogue-personal-plugin",
  repo_key: "rogue-personal-plugin",
  version: "1.0.0",
  path: "/tmp/rogue-personal-plugin",
  source: "https://github.com/fixture/rogue-personal-plugin",
  marketplace: null
}]')"
assert_poisoned_lifecycle_rejected() {
  local lifecycle="$1"
  local poison="$2"
  local expected="$3"
  local fixture_name="poisoned-$lifecycle-$poison"
  local tree_before
  local calls_before
  local new_log="$fixture_root/$fixture_name-grok.jsonl"

  printf '%s\n' "$hve_poisoned_base_inventory" >"$hve_plugins_file"
  unset FAKE_GROK_MCP_JSON || true
  rm -rf "$hve_home/skills" "$hve_home/commands"
  case "$poison" in
    plugin)
      printf '%s\n' "$hve_poisoned_inventory" >"$hve_plugins_file"
      ;;
    skills)
      mkdir -p "$hve_home/skills"
      printf 'personal leakage\n' >"$hve_home/skills/personal"
      ;;
    commands)
      mkdir -p "$hve_home/commands"
      printf 'personal leakage\n' >"$hve_home/commands/personal"
      ;;
    *) fail "unknown poisoned lifecycle fixture: $poison" ;;
  esac

  tree_before="$(profile_tree_hash "$hve_home")"
  calls_before="$(wc -l <"$fake_grok_log" | tr -d ' ')"
  case "$lifecycle" in
    launch)
      if ./bin/grx hve --poisoned-launch >"$fixture_root/$fixture_name.out" \
        2>"$fixture_root/$fixture_name.err"; then
        fail "launch accepted $poison state"
      fi
      ;;
    setup|repair|update)
      if ./bin/grx "$lifecycle" hve >"$fixture_root/$fixture_name.out" \
        2>"$fixture_root/$fixture_name.err"; then
        fail "$lifecycle accepted $poison state"
      fi
      ;;
    *) fail "unknown poisoned lifecycle: $lifecycle" ;;
  esac
  assert_line "$expected" "$fixture_root/$fixture_name.err"
  [ "$(profile_tree_hash "$hve_home")" = "$tree_before" ] \
    || fail "$lifecycle mutated the $poison profile before rejection"
  tail -n "+$((calls_before + 1))" "$fake_grok_log" >"$new_log"
  if jq -s -e 'any(.[].args; .[0:2] == ["plugin","install"] or .[0:2] == ["plugin","update"])' \
    "$new_log" >/dev/null; then
    fail "$lifecycle invoked a plugin mutation for $poison state"
  fi
  if [ "$lifecycle" = 'launch' ] \
    && jq -s -e 'any(.[].args; . == ["--poisoned-launch"])' "$new_log" >/dev/null; then
    fail "launch forwarded user arguments for $poison state"
  fi

  unset FAKE_GROK_MCP_JSON || true
  printf '%s\n' "$hve_poisoned_base_inventory" >"$hve_plugins_file"
  rm -rf "$hve_home/skills" "$hve_home/commands"
}

assert_poisoned_lifecycle_rejected update skills \
  "grx: standalone capability directory is not empty: $hve_home/skills"
assert_poisoned_lifecycle_rejected update commands \
  "grx: standalone capability directory is not empty: $hve_home/commands"

printf 'profile-auth\n' >"$hve_home/auth.json"
chmod 0600 "$hve_home/auth.json"
chmod 0600 "$hve_home/requirements.toml"
installs_before_repeat="$(jq -s --arg home "$hve_home" '[.[] | select(.grokHome == $home and .args[0:2] == ["plugin","install"])] | length' "$fake_grok_log")"
./bin/grx setup hve >"$fixture_root/hve-repeat-setup.out"
installs_after_repeat="$(jq -s --arg home "$hve_home" '[.[] | select(.grokHome == $home and .args[0:2] == ["plugin","install"])] | length' "$fake_grok_log")"
[ "$installs_after_repeat" = "$installs_before_repeat" ] \
  || fail 'repeated setup reinstalled an existing plugin'
cmp -s "$HOME/.grok/auth.json" "$hve_home/auth.json" \
  || fail 'repeated setup did not refresh authentication'
[ "$(path_mode "$hve_home/requirements.toml")" = '644' ] \
  || fail 'repeated setup did not normalize policy mode 0644'

hve_hash_before_check="$(profile_tree_hash "$hve_home")"
./bin/grx update --check hve >"$fixture_root/hve-current.out"
if ! cmp -s "$fixture_root/hve-current.out" <(printf 'hve: current (3.3.101)\n'); then
  fail 'healthy HVE update check did not report the exact current version'
fi
hve_hash_after_check="$(profile_tree_hash "$hve_home")"
[ "$hve_hash_after_check" = "$hve_hash_before_check" ] \
  || fail 'healthy HVE update check mutated the profile tree'

assert_hve_inventory_check_failure() {
  local fixture_name="$1"
  local inventory="$2"
  local status=0

  printf '%s\n' "$inventory" >"$hve_plugins_file"
  ./bin/grx update --check hve >"$fixture_root/$fixture_name.out" \
    2>"$fixture_root/$fixture_name.err" || status=$?
  [ "$status" -eq 2 ] \
    || fail "$fixture_name inventory check exited $status instead of 2"
  assert_line 'grx: failed to read installed plugin version for hve' \
    "$fixture_root/$fixture_name.err"
}

hve_native_inventory="$(cat "$hve_plugins_file")"
hve_native_manifest="$(cat "$hve_local_manifest")"
hve_wrong_source_inventory="$(printf '%s\n' "$hve_native_inventory" \
  | jq -c '.[0].source = "https://github.com/fixture/wrong-source"')"
assert_hve_inventory_check_failure 'hve-wrong-source' "$hve_wrong_source_inventory"
hve_updates_before_invalid="$(jq -s --arg home "$hve_home" \
  '[.[] | select(.grokHome == $home and .args[0:2] == ["plugin","update"])] | length' \
  "$fake_grok_log")"
if ./bin/grx update hve >"$fixture_root/hve-invalid-update.out" \
  2>"$fixture_root/hve-invalid-update.err"; then
  fail 'update accepted an installed plugin with the wrong source'
fi
hve_updates_after_invalid="$(jq -s --arg home "$hve_home" \
  '[.[] | select(.grokHome == $home and .args[0:2] == ["plugin","update"])] | length' \
  "$fake_grok_log")"
[ "$hve_updates_after_invalid" = "$hve_updates_before_invalid" ] \
  || fail 'invalid plugin provenance invoked native update'

printf '%s\n' "$hve_native_inventory" >"$hve_plugins_file"
assert_hve_inventory_check_failure 'hve-object-inventory' \
  "$(printf '%s\n' "$hve_native_inventory" | jq -c '.[0]')"
assert_hve_inventory_check_failure 'hve-empty-version' \
  "$(printf '%s\n' "$hve_native_inventory" | jq -c '.[0].version = ""')"
assert_hve_inventory_check_failure 'hve-duplicate-inventory' \
  "$(printf '%s\n' "$hve_native_inventory" | jq -c '. + .')"
assert_hve_inventory_check_failure 'hve-unexpected-then-valid-document' \
  "$(printf '{}\n%s\n' "$hve_native_inventory")"
assert_hve_inventory_check_failure 'hve-valid-then-unexpected-document' \
  "$(printf '%s\n{}\n' "$hve_native_inventory")"
assert_hve_inventory_check_failure 'hve-unexpected-then-empty-document' \
  "$(printf '{}\n[]\n')"
assert_hve_inventory_check_failure 'hve-empty-then-unexpected-document' \
  "$(printf '[]\n{}\n')"
assert_hve_inventory_check_failure 'hve-missing-path' \
  "$(printf '%s\n' "$hve_native_inventory" | jq -c 'del(.[0].path)')"

hve_outside_install="$fixture_root/outside-hve-plugin"
mkdir -p "$hve_outside_install/plugins/hve-core-all/.github/plugin"
printf '%s\n' "$hve_native_manifest" \
  >"$hve_outside_install/plugins/hve-core-all/.github/plugin/plugin.json"
assert_hve_inventory_check_failure 'hve-path-outside-profile' \
  "$(printf '%s\n' "$hve_native_inventory" \
    | jq -c --arg path "$hve_outside_install" '.[0].path = $path')"

hve_symlink_install="$hve_home/installed-plugins/hve-symlink-escape"
ln -s "$hve_outside_install" "$hve_symlink_install"
assert_hve_inventory_check_failure 'hve-path-symlink-escape' \
  "$(printf '%s\n' "$hve_native_inventory" \
    | jq -c --arg path "$hve_symlink_install" '.[0].path = $path')"
rm "$hve_symlink_install"

mv "$hve_local_manifest" "$fixture_root/hve-local-manifest.saved"
assert_hve_inventory_check_failure 'hve-missing-local-manifest' "$hve_native_inventory"
mv "$fixture_root/hve-local-manifest.saved" "$hve_local_manifest"

printf '{not-json\n' >"$hve_local_manifest"
assert_hve_inventory_check_failure 'hve-malformed-local-manifest' "$hve_native_inventory"
printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

printf '{}\n%s\n' "$hve_native_manifest" >"$hve_local_manifest"
assert_hve_inventory_check_failure 'hve-local-manifest-unexpected-then-valid' \
  "$hve_native_inventory"
printf '%s\n{}\n' "$hve_native_manifest" >"$hve_local_manifest"
assert_hve_inventory_check_failure 'hve-local-manifest-valid-then-unexpected' \
  "$hve_native_inventory"
printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

printf '%s\n' "$hve_native_manifest" \
  | jq '.name = "wrong-plugin"' >"$fixture_root/hve-wrong-manifest-name.json"
mv "$fixture_root/hve-wrong-manifest-name.json" "$hve_local_manifest"
assert_hve_inventory_check_failure 'hve-local-manifest-name-mismatch' "$hve_native_inventory"
printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

printf '%s\n' "$hve_native_manifest" \
  | jq '.repository = "https://github.com/fixture/wrong-repository"' \
    >"$fixture_root/hve-wrong-manifest-repository.json"
mv "$fixture_root/hve-wrong-manifest-repository.json" "$hve_local_manifest"
assert_hve_inventory_check_failure 'hve-local-manifest-repository-mismatch' \
  "$hve_native_inventory"
printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

printf '%s\n' "$hve_native_manifest" | jq '.repository = 42' \
  >"$fixture_root/hve-number-manifest-repository.json"
mv "$fixture_root/hve-number-manifest-repository.json" "$hve_local_manifest"
assert_hve_inventory_check_failure 'hve-local-manifest-repository-number' \
  "$hve_native_inventory"
printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

printf '%s\n' "$hve_native_manifest" | jq '.repository = {url:"https://github.com/microsoft/hve-core"}' \
  >"$fixture_root/hve-object-manifest-repository.json"
mv "$fixture_root/hve-object-manifest-repository.json" "$hve_local_manifest"
assert_hve_inventory_check_failure 'hve-local-manifest-repository-object' \
  "$hve_native_inventory"
printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

printf '%s\n' "$hve_native_manifest" | jq '.repository = null' \
  >"$fixture_root/hve-null-manifest-repository.json"
mv "$fixture_root/hve-null-manifest-repository.json" "$hve_local_manifest"
./bin/grx update --check hve >"$fixture_root/hve-null-manifest-repository.out"
assert_line 'hve: current (3.3.101)' \
  "$fixture_root/hve-null-manifest-repository.out"

printf '%s\n' "$hve_native_manifest" | jq 'del(.repository)' \
  >"$fixture_root/hve-absent-manifest-repository.json"
mv "$fixture_root/hve-absent-manifest-repository.json" "$hve_local_manifest"
./bin/grx update --check hve >"$fixture_root/hve-absent-manifest-repository.out"
assert_line 'hve: current (3.3.101)' \
  "$fixture_root/hve-absent-manifest-repository.out"
printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

printf '%s\n' "$hve_native_manifest" \
  | jq '.version = ""' >"$fixture_root/hve-empty-manifest-version.json"
mv "$fixture_root/hve-empty-manifest-version.json" "$hve_local_manifest"
assert_hve_inventory_check_failure 'hve-local-manifest-version-mismatch' "$hve_native_inventory"
printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

assert_hve_inventory_check_failure 'hve-inventory-manifest-version-mismatch' \
  "$(printf '%s\n' "$hve_native_inventory" | jq -c '.[0].version = "9.9.9"')"

hve_legacy_inventory="$(printf '%s\n' "$hve_native_inventory" | jq -c '
  .[0].source = "microsoft/hve-core#plugins/hve-core-all"
  | .[0].version = "3.3.101"
')"
printf '%s\n' "$hve_legacy_inventory" >"$hve_plugins_file"
./bin/grx update --check hve >"$fixture_root/hve-legacy-current.out"
assert_line 'hve: current (3.3.101)' "$fixture_root/hve-legacy-current.out"
printf '%s\n' "$hve_native_inventory" | jq -c 'del(.[0].version)' \
  >"$hve_plugins_file"
./bin/grx update --check hve >"$fixture_root/hve-missing-version-current.out"
assert_line 'hve: current (3.3.101)' \
  "$fixture_root/hve-missing-version-current.out"
printf '%s\n' "$hve_native_inventory" >"$hve_plugins_file"

assert_read_only_lifecycle_preflight() {
  local lifecycle="$1"
  local unsafe_kind="$2"
  local fixture_name="$lifecycle-preflight-$unsafe_kind"
  local before_hash
  local after_hash
  local native_mutations_before
  local native_mutations_after

  printf 'preflight policy sentinel\n' >"$hve_home/requirements.toml"
  cp "$HOME/.grok/auth.json" "$hve_home/auth.json"
  chmod 0711 "$hve_home"
  chmod 0600 "$hve_home/requirements.toml"
  chmod 0600 "$hve_home/auth.json"
  printf '%s\n' "$hve_native_inventory" >"$hve_plugins_file"
  printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

  case "$unsafe_kind" in
    source)
      printf '%s\n' "$hve_native_inventory" \
        | jq '.[0].source = "https://github.com/fixture/wrong-source"' \
          >"$hve_plugins_file"
      ;;
    path)
      printf '%s\n' "$hve_native_inventory" \
        | jq --arg path "$hve_outside_install" '.[0].path = $path' \
          >"$hve_plugins_file"
      ;;
    manifest)
      printf '{not-json\n' >"$hve_local_manifest"
      ;;
    *) fail "unknown lifecycle preflight fixture: $unsafe_kind" ;;
  esac

  before_hash="$(profile_tree_hash "$hve_home")"
  native_mutations_before="$(jq -s --arg home "$hve_home" '
    [.[] | select(
      .grokHome == $home
      and (.args[0:2] == ["plugin","install"] or .args[0:2] == ["plugin","update"])
    )] | length
  ' "$fake_grok_log")"

  if ./bin/grx "$lifecycle" hve >"$fixture_root/$fixture_name.out" \
    2>"$fixture_root/$fixture_name.err"; then
    fail "$lifecycle accepted unsafe existing $unsafe_kind plugin state"
  fi

  after_hash="$(profile_tree_hash "$hve_home")"
  [ "$after_hash" = "$before_hash" ] \
    || fail "$lifecycle changed existing profile tree before rejecting unsafe $unsafe_kind"
  native_mutations_after="$(jq -s --arg home "$hve_home" '
    [.[] | select(
      .grokHome == $home
      and (.args[0:2] == ["plugin","install"] or .args[0:2] == ["plugin","update"])
    )] | length
  ' "$fake_grok_log")"
  [ "$native_mutations_after" = "$native_mutations_before" ] \
    || fail "$lifecycle invoked install or update for unsafe existing $unsafe_kind state"
  assert_line 'preflight policy sentinel' "$hve_home/requirements.toml"
  cmp -s "$HOME/.grok/auth.json" "$hve_home/auth.json" \
    || fail "$lifecycle changed authentication while rejecting unsafe $unsafe_kind plugin state"
  [ "$(path_mode "$hve_home")" = '711' ] \
    || fail "$lifecycle changed profile mode before rejecting unsafe $unsafe_kind"
  [ "$(path_mode "$hve_home/requirements.toml")" = '600' ] \
    || fail "$lifecycle changed policy mode before rejecting unsafe $unsafe_kind"
  [ "$(path_mode "$hve_home/auth.json")" = '600' ] \
    || fail "$lifecycle changed auth mode before rejecting unsafe $unsafe_kind"

  chmod 0700 "$hve_home"
  printf '%s\n' "$hve_native_inventory" >"$hve_plugins_file"
  printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"
  cp "$expected_policy" "$hve_home/requirements.toml"
  chmod 0644 "$hve_home/requirements.toml"
  cp "$HOME/.grok/auth.json" "$hve_home/auth.json"
  chmod 0600 "$hve_home/auth.json"
}

for lifecycle in setup repair; do
  for unsafe_kind in source path manifest; do
    assert_read_only_lifecycle_preflight "$lifecycle" "$unsafe_kind"
  done
done

assert_filesystem_preflight_failure() {
  local lifecycle="$1"
  local unsafe_kind="$2"
  local fixture_name="$lifecycle-filesystem-preflight-$unsafe_kind"
  local outside_target="$fixture_root/$fixture_name-target"
  local before_hash
  local after_hash
  local native_mutations_before
  local native_mutations_after

  chmod 0700 "$hve_home"
  chmod -R u+rwx "$hve_home/skills" "$hve_home/commands" 2>/dev/null || true
  rm -rf "$hve_home/skills" "$hve_home/commands"
  rm -rf "$hve_home/auth.json" "$hve_home/requirements.toml"
  printf 'preflight policy sentinel\n' >"$hve_home/requirements.toml"
  cp "$HOME/.grok/auth.json" "$hve_home/auth.json"
  chmod 0711 "$hve_home"
  chmod 0600 "$hve_home/requirements.toml"
  chmod 0600 "$hve_home/auth.json"
  printf '%s\n' "$hve_native_inventory" >"$hve_plugins_file"
  printf '%s\n' "$hve_native_manifest" >"$hve_local_manifest"

  case "$unsafe_kind" in
    auth-mode)
      chmod 0644 "$hve_home/auth.json"
      ;;
    auth-symlink)
      rm "$hve_home/auth.json"
      printf 'outside auth sentinel\n' >"$outside_target"
      ln -s "$outside_target" "$hve_home/auth.json"
      ;;
    policy-directory)
      rm "$hve_home/requirements.toml"
      mkdir "$hve_home/requirements.toml"
      ;;
    policy-symlink)
      rm "$hve_home/requirements.toml"
      printf 'outside policy sentinel\n' >"$outside_target"
      ln -s "$outside_target" "$hve_home/requirements.toml"
      ;;
    skills-symlink)
      mkdir "$outside_target"
      ln -s "$outside_target" "$hve_home/skills"
      ;;
    commands-file)
      printf 'not a directory\n' >"$hve_home/commands"
      ;;
    skills-nonempty)
      mkdir -p "$hve_home/skills"
      printf 'unexpected\n' >"$hve_home/skills/unexpected"
      ;;
    commands-unreadable)
      mkdir -p "$hve_home/commands"
      chmod 0000 "$hve_home/commands"
      ;;
    *) fail "unknown filesystem preflight fixture: $unsafe_kind" ;;
  esac

  before_hash="$(profile_tree_hash "$hve_home")"
  native_mutations_before="$(jq -s --arg home "$hve_home" '
    [.[] | select(
      .grokHome == $home
      and (.args[0:2] == ["plugin","install"] or .args[0:2] == ["plugin","update"])
    )] | length
  ' "$fake_grok_log")"

  if ./bin/grx "$lifecycle" hve >"$fixture_root/$fixture_name.out" \
    2>"$fixture_root/$fixture_name.err"; then
    fail "$lifecycle accepted unsafe existing filesystem state: $unsafe_kind"
  fi

  after_hash="$(profile_tree_hash "$hve_home")"
  [ "$after_hash" = "$before_hash" ] \
    || fail "$lifecycle changed profile tree before rejecting $unsafe_kind"
  native_mutations_after="$(jq -s --arg home "$hve_home" '
    [.[] | select(
      .grokHome == $home
      and (.args[0:2] == ["plugin","install"] or .args[0:2] == ["plugin","update"])
    )] | length
  ' "$fake_grok_log")"
  [ "$native_mutations_after" = "$native_mutations_before" ] \
    || fail "$lifecycle invoked install or update before rejecting $unsafe_kind"

  chmod 0700 "$hve_home"
  chmod -R u+rwx "$hve_home/skills" "$hve_home/commands" 2>/dev/null || true
  rm -rf "$hve_home/skills" "$hve_home/commands"
  rm -rf "$hve_home/auth.json" "$hve_home/requirements.toml"
  cp "$expected_policy" "$hve_home/requirements.toml"
  chmod 0644 "$hve_home/requirements.toml"
  cp "$HOME/.grok/auth.json" "$hve_home/auth.json"
  chmod 0600 "$hve_home/auth.json"
}

for lifecycle in setup repair; do
  for unsafe_kind in \
    auth-mode \
    auth-symlink \
    policy-directory \
    policy-symlink \
    skills-symlink \
    commands-file \
    skills-nonempty \
    commands-unreadable; do
    assert_filesystem_preflight_failure "$lifecycle" "$unsafe_kind"
  done
done

assert_launch_readiness_refusal() {
  local unsafe_kind="$1"
  local expected="$2"
  local fixture_name="launch-readiness-$unsafe_kind"
  local outside="$fixture_root/$fixture_name-outside"
  local calls_before
  local calls_after
  local tree_before
  local tree_after

  cp "$expected_policy" "$hve_home/requirements.toml"
  chmod 0644 "$hve_home/requirements.toml"
  printf 'profile-auth\n' >"$hve_home/auth.json"
  chmod 0600 "$hve_home/auth.json"
  chmod 0700 "$hve_home"

  case "$unsafe_kind" in
    missing-policy)
      rm "$hve_home/requirements.toml"
      ;;
    policy-symlink)
      rm "$hve_home/requirements.toml"
      printf 'outside policy\n' >"$outside"
      ln -s "$outside" "$hve_home/requirements.toml"
      ;;
    auth-mode)
      chmod 0644 "$hve_home/auth.json"
      ;;
    auth-unreadable)
      chmod 0000 "$hve_home/auth.json"
      ;;
    auth-symlink)
      rm "$hve_home/auth.json"
      printf 'outside auth\n' >"$outside"
      ln -s "$outside" "$hve_home/auth.json"
      ;;
    profile-mode)
      chmod 0711 "$hve_home"
      ;;
    policy-mode)
      chmod 0600 "$hve_home/requirements.toml"
      ;;
    *) fail "unknown launch readiness fixture: $unsafe_kind" ;;
  esac

  tree_before="$(profile_tree_hash "$hve_home")"
  calls_before="$(wc -l <"$fake_grok_log" | tr -d ' ')"
  if ./bin/grx hve --version >"$fixture_root/$fixture_name.out" \
    2>"$fixture_root/$fixture_name.err"; then
    fail "launch accepted unsafe readiness state: $unsafe_kind"
  fi
  assert_line "$expected" "$fixture_root/$fixture_name.err"
  tree_after="$(profile_tree_hash "$hve_home")"
  [ "$tree_after" = "$tree_before" ] \
    || fail "launch changed unsafe readiness state: $unsafe_kind"
  calls_after="$(wc -l <"$fake_grok_log" | tr -d ' ')"
  [ "$calls_after" = "$calls_before" ] \
    || fail "launch invoked Grok for unsafe readiness state: $unsafe_kind"

  if [ "$unsafe_kind" = auth-unreadable ]; then
    chmod 0600 "$hve_home/auth.json"
    assert_line 'profile-auth' "$hve_home/auth.json"
    chmod 0000 "$hve_home/auth.json"
  fi

  chmod 0700 "$hve_home"
  rm -f "$hve_home/auth.json" "$hve_home/requirements.toml" "$outside"
  cp "$expected_policy" "$hve_home/requirements.toml"
  chmod 0644 "$hve_home/requirements.toml"
  printf 'profile-auth\n' >"$hve_home/auth.json"
  chmod 0600 "$hve_home/auth.json"
}

assert_launch_readiness_refusal policy-symlink \
  "grx: unsafe requirements path: $hve_home/requirements.toml"
assert_launch_readiness_refusal auth-mode \
  'grx: profile authentication must have mode 0600: hve'
assert_launch_readiness_refusal auth-unreadable \
  'grx: profile authentication is missing or unreadable: hve'
assert_launch_readiness_refusal auth-symlink \
  'grx: profile authentication is missing or unreadable: hve'

rm "$hve_home/requirements.toml"
./bin/grx hve --version >/dev/null \
  || fail 'launch did not restore missing requirements policy'
cmp -s "$expected_policy" "$hve_home/requirements.toml" \
  || fail 'launch restored incorrect requirements policy'

chmod 0711 "$hve_home"
./bin/grx hve --version >/dev/null \
  || fail 'launch did not restore profile home mode'
[ "$(path_mode "$hve_home")" = '700' ] \
  || fail 'launch restored incorrect profile home mode'

chmod 0600 "$hve_home/requirements.toml"
./bin/grx hve --version >/dev/null \
  || fail 'launch did not restore requirements policy mode'
[ "$(path_mode "$hve_home/requirements.toml")" = '644' ] \
  || fail 'launch restored incorrect requirements policy mode'

hve_launch_safe_home="$fixture_root/hve-launch-safe-home"
hve_launch_safe_hash_before="$(profile_tree_hash "$hve_home")"
mv "$hve_home" "$hve_launch_safe_home"
ln -s "$hve_launch_safe_home" "$hve_home"
calls_before_symlink_home_launch="$(wc -l <"$fake_grok_log" | tr -d ' ')"
if ./bin/grx hve --version >"$fixture_root/symlink-home-launch.out" \
  2>"$fixture_root/symlink-home-launch.err"; then
  fail 'launch accepted a symlinked profile home'
fi
assert_line "grx: unsafe profile home path: $hve_home" \
  "$fixture_root/symlink-home-launch.err"
calls_after_symlink_home_launch="$(wc -l <"$fake_grok_log" | tr -d ' ')"
[ "$calls_after_symlink_home_launch" = "$calls_before_symlink_home_launch" ] \
  || fail 'symlinked-home launch invoked Grok'
hve_launch_safe_hash_after="$(profile_tree_hash "$hve_launch_safe_home")"
[ "$hve_launch_safe_hash_after" = "$hve_launch_safe_hash_before" ] \
  || fail 'symlinked-home launch changed the profile target'
rm "$hve_home"
mv "$hve_launch_safe_home" "$hve_home"

assert_hve_manifest_failure() {
  local fixture_name="$1"
  local manifest="$2"
  local status=0

  export FAKE_CURL_HVE_MANIFEST_JSON="$manifest"
  ./bin/grx update --check hve >"$fixture_root/$fixture_name.out" \
    2>"$fixture_root/$fixture_name.err" || status=$?
  unset FAKE_CURL_HVE_MANIFEST_JSON
  [ "$status" -eq 2 ] \
    || fail "$fixture_name manifest check exited $status instead of 2"
  assert_line 'grx: failed to fetch or parse official manifest for hve' \
    "$fixture_root/$fixture_name.err"
}

assert_hve_manifest_failure 'hve-malformed-duplicate' \
  '{"plugins":[{"name":"hve-core-all","version":"3.3.101"},{"name":"hve-core-all","version":null}]}'
assert_hve_manifest_failure 'hve-array-manifest' \
  '[{"plugins":[{"name":"hve-core-all","version":"3.3.101"}]}]'
assert_hve_manifest_failure 'hve-object-plugins' \
  '{"plugins":{"name":"hve-core-all","version":"3.3.101"}}'
assert_hve_manifest_failure 'hve-scalar-plugins' \
  '{"plugins":"hve-core-all"}'
assert_hve_manifest_failure 'hve-remote-unexpected-then-valid-document' \
  $'{}\n{"plugins":[{"name":"hve-core-all","version":"3.3.101"}]}'
assert_hve_manifest_failure 'hve-remote-valid-then-unexpected-document' \
  $'{"plugins":[{"name":"hve-core-all","version":"3.3.101"}]}\n{}'
assert_hve_manifest_failure 'hve-remote-newline-version' \
  '{"plugins":[{"name":"hve-core-all","version":"3.3.101\nforged"}]}'

assert_raw_nul_boundary_failure() {
  local boundary="$1"
  local fixture_name="raw-nul-$boundary"
  local before_hash
  local after_hash
  local native_mutations_before
  local native_mutations_after
  local status=0

  before_hash="$(profile_tree_hash "$hve_home")"
  native_mutations_before="$(jq -s --arg home "$hve_home" '
    [.[] | select(
      .grokHome == $home
      and (.args[0:2] == ["plugin","install"] or .args[0:2] == ["plugin","update"])
    )] | length
  ' "$fake_grok_log")"

  case "$boundary" in
    plugin-inventory)
      export FAKE_GROK_PLUGIN_RAW_NUL_HOME="$hve_home"
      ./bin/grx update --check hve >"$fixture_root/$fixture_name.out" \
        2>"$fixture_root/$fixture_name.err" || status=$?
      unset FAKE_GROK_PLUGIN_RAW_NUL_HOME
      [ "$status" -eq 2 ] \
        || fail "raw-NUL plugin inventory exited $status instead of 2"
      assert_line 'grx: failed to read installed plugin version for hve' \
        "$fixture_root/$fixture_name.err"
      ;;
    remote-manifest)
      export FAKE_CURL_RAW_NUL_URL='https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json'
      ./bin/grx update --check hve >"$fixture_root/$fixture_name.out" \
        2>"$fixture_root/$fixture_name.err" || status=$?
      unset FAKE_CURL_RAW_NUL_URL
      [ "$status" -eq 2 ] \
        || fail "raw-NUL remote manifest exited $status instead of 2"
      assert_line 'grx: failed to fetch or parse official manifest for hve' \
        "$fixture_root/$fixture_name.err"
      ;;
    mcp-inventory)
      export FAKE_GROK_MCP_RAW_NUL_HOME="$hve_home"
      ./bin/grx doctor hve >"$fixture_root/$fixture_name.out" \
        2>"$fixture_root/$fixture_name.err" || status=$?
      unset FAKE_GROK_MCP_RAW_NUL_HOME
      [ "$status" -ne 0 ] || fail 'raw-NUL MCP inventory unexpectedly passed doctor'
      assert_line 'grx: invalid MCP inventory for hve' \
        "$fixture_root/$fixture_name.err"
      ;;
    *) fail "unknown raw-NUL boundary: $boundary" ;;
  esac

  after_hash="$(profile_tree_hash "$hve_home")"
  [ "$after_hash" = "$before_hash" ] \
    || fail "raw-NUL $boundary mutated the profile tree"
  native_mutations_after="$(jq -s --arg home "$hve_home" '
    [.[] | select(
      .grokHome == $home
      and (.args[0:2] == ["plugin","install"] or .args[0:2] == ["plugin","update"])
    )] | length
  ' "$fake_grok_log")"
  [ "$native_mutations_after" = "$native_mutations_before" ] \
    || fail "raw-NUL $boundary invoked install or update"
}

for raw_nul_boundary in plugin-inventory remote-manifest mcp-inventory; do
  assert_raw_nul_boundary_failure "$raw_nul_boundary"
done

export FAKE_GROK_LIST_FAILURE_HOME="$hve_home"
hve_inventory_failure_status=0
./bin/grx update --check hve >"$fixture_root/hve-inventory-failure.out" \
  2>"$fixture_root/hve-inventory-failure.err" || hve_inventory_failure_status=$?
unset FAKE_GROK_LIST_FAILURE_HOME
[ "$hve_inventory_failure_status" -eq 2 ] \
  || fail "failed HVE inventory check exited $hve_inventory_failure_status instead of 2"
assert_line 'grx: failed to read installed plugin version for hve' \
  "$fixture_root/hve-inventory-failure.err"

jq '.version = "3.3.102"' "$hve_local_manifest" \
  >"$fixture_root/hve-newer.json"
mv "$fixture_root/hve-newer.json" "$hve_local_manifest"
hve_newer_status=0
./bin/grx update --check hve >"$fixture_root/hve-newer.out" \
  2>"$fixture_root/hve-newer.err" || hve_newer_status=$?
[ "$hve_newer_status" -eq 1 ] \
  || fail "unequal newer HVE check exited $hve_newer_status instead of 1"
if ! cmp -s "$fixture_root/hve-newer.out" \
  <(printf 'hve: update available (3.3.102 -> 3.3.101)\n'); then
  fail 'unequal newer HVE check changed the approved update-available wording'
fi
[ ! -s "$fixture_root/hve-newer.err" ] \
  || fail 'unequal newer HVE check wrote stderr'

jq '.version = "3.3.100"' "$hve_local_manifest" \
  >"$fixture_root/hve-outdated.json"
mv "$fixture_root/hve-outdated.json" "$hve_local_manifest"
hve_outdated_status=0
./bin/grx update --check hve >"$fixture_root/hve-outdated.out" \
  2>"$fixture_root/hve-outdated.err" || hve_outdated_status=$?
[ "$hve_outdated_status" -eq 1 ] \
  || fail "outdated HVE update check exited $hve_outdated_status instead of 1"
if ! cmp -s "$fixture_root/hve-outdated.out" \
  <(printf 'hve: update available (3.3.100 -> 3.3.101)\n'); then
  fail 'outdated HVE update check did not report the exact available version'
fi
[ ! -s "$fixture_root/hve-outdated.err" ] \
  || fail 'outdated HVE update check wrote stderr'

mkdir -p "$hve_home/sessions" "$hve_home/memory" "$hve_home/permissions"
printf 'keep session\n' >"$hve_home/sessions/keep"
printf 'keep memory\n' >"$hve_home/memory/keep"
printf 'keep permissions\n' >"$hve_home/permissions/keep"
./bin/grx update hve >"$fixture_root/hve-update.out"
if ! cmp -s "$fixture_root/hve-update.out" <(printf 'hve: updated\n'); then
  fail 'HVE update did not emit only the exact updated line'
fi
cmp -s "$HOME/.grok/auth.json" "$hve_home/auth.json" \
  || fail 'update did not refresh authentication'
assert_line 'keep session' "$hve_home/sessions/keep"
assert_line 'keep memory' "$hve_home/memory/keep"
assert_line 'keep permissions' "$hve_home/permissions/keep"

jq '. + [
  {status:"installed",name:"superpowers",repo_key:"superpowers-direct",version:null,path:"/fixture/superpowers",source:"obra/superpowers",marketplace:null},
  {status:"installed",name:"renamed-workflow",repo_key:"superpowers-renamed",version:null,path:"/fixture/renamed",source:"ssh://git@github.com/obra/superpowers.git/",marketplace:null}
]' \
  "$hve_plugins_file" >"$fixture_root/hve-with-superpowers.json"
mv "$fixture_root/hve-with-superpowers.json" "$hve_plugins_file"
if ./bin/grx doctor hve >"$fixture_root/hve-superpowers-doctor.out" \
  2>"$fixture_root/hve-superpowers-doctor.err"; then
  fail 'doctor accepted Superpowers in the HVE profile'
fi
assert_contains 'grx: forbidden Superpowers plugin is installed: hve; run: grx repair hve' \
  "$fixture_root/hve-superpowers-doctor.err"
./bin/grx repair hve >"$fixture_root/hve-superpowers-repair.out"
jq -e 'length == 1 and .[0].name == "hve-core-all"' "$hve_plugins_file" \
  >/dev/null || fail 'repair did not remove only forbidden Superpowers plugin'
jq -s -e --arg home "$hve_home" '
  any(.[];
    .grokHome == $home
    and .args == ["plugin","update","hve-core-all"]
  )
' "$fake_grok_log" >/dev/null || fail 'update did not invoke the native HVE plugin update'
jq -e '.version == "3.3.101"' "$hve_local_manifest" >/dev/null \
  || fail 'native HVE update did not refresh the local plugin manifest version'

repository_fixture="$fixture_root/repository"
mkdir -p \
  "$repository_fixture/.grok/skills/grok-skill" \
  "$repository_fixture/.grok/hooks/repository-hook" \
  "$repository_fixture/.grok/plugins/repository-plugin" \
  "$repository_fixture/.grok/mcps/repository-mcp" \
  "$repository_fixture/.agents/skills/agents-skill" \
  "$repository_fixture/.agents/agents/repository-agent" \
  "$repository_fixture/.claude/skills/claude-skill" \
  "$repository_fixture/.cursor/skills/cursor-skill"
: >"$repository_fixture/AGENTS.md"
: >"$repository_fixture/CLAUDE.md"
inventory_output="$fixture_root/inventory.out"
(
  cd "$repository_fixture"
  "$prototype_root/bin/grx" hve --fixture-capability-inventory
) >"$inventory_output"
if ! cmp -s "$inventory_output" <(printf '%s\n' \
  'plugin:hve-core-all' \
  'repository:grok-skill' \
  'repository:agents-skill' \
  'repository:AGENTS.md' \
  'repository:CLAUDE.md'); then
  fail 'capability policy did not expose only approved plugin and repository capabilities'
fi
assert_not_contains 'personal:' "$inventory_output"
assert_not_contains 'repository:claude-skill' "$inventory_output"
assert_not_contains 'repository:cursor-skill' "$inventory_output"

inspect_output="$fixture_root/inspect.json"
mcp_output="$fixture_root/mcp.json"
plugin_output="$fixture_root/plugin.json"
(
  cd "$repository_fixture"
  "$prototype_root/bin/grx" hve inspect --json
) >"$inspect_output"
(
  cd "$repository_fixture"
  "$prototype_root/bin/grx" hve mcp list --json
) >"$mcp_output"
(
  cd "$repository_fixture"
  "$prototype_root/bin/grx" hve plugin list --json
) >"$plugin_output"

inspect_gate="$fixture_root/inspect-isolation.jq"
cat >"$inspect_gate" <<'INSPECT_GATE'
# grx-inspect-isolation-filter-begin
def expected_cells: [
  ["cursor", "skills"], ["cursor", "rules"], ["cursor", "agents"],
  ["cursor", "mcps"], ["cursor", "hooks"], ["cursor", "sessions"],
  ["claude", "skills"], ["claude", "rules"], ["claude", "agents"],
  ["claude", "mcps"], ["claude", "hooks"], ["claude", "sessions"],
  ["codex", "sessions"]
];
def valid_cells($cells):
  ($cells | type) == "array"
  and ($cells | length) == 13
  and all($cells[];
    type == "object"
    and ((.vendor | type) == "string")
    and ((.surface | type) == "string")
    and ((.enabled | type) == "boolean")
    and .enabled == false
    and .source == "config")
  and (($cells | map([.vendor, .surface]) | sort) == (expected_cells | sort));
def cell_disabled($cells; $vendor; $surface):
  any($cells[];
    .vendor == $vendor and .surface == $surface and .enabled == false);
def nonempty_string: type == "string" and length > 0;
def under_root($path; $root):
  $path == ($root | rtrimstr("/")) or ($path | startswith($root));
def valid_source($entry):
  ($entry.source | type) == "object"
  and ($entry.source.type | nonempty_string)
  and (["builtin", "native", "bundled", "plugin", "project", "repository", "user", "claudeJson", "cursor"] | index($entry.source.type) != null)
  and if ($entry.source.type == "builtin" or $entry.source.type == "native") then
    (($entry.source | has("path") | not) or ($entry.source.path | nonempty_string))
  else
    ($entry.source.path | nonempty_string)
  end;
def path_vendor($path):
  if under_root($path; $personalClaude) then "claude"
  elif under_root($path; $personalCursor) then "cursor"
  else null
  end;
def entry_vendor($entry; $path):
  if path_vendor($path) != null then path_vendor($path)
  elif ($entry.vendor? == "claude" or $entry.source.type == "claudeJson") then "claude"
  elif ($entry.vendor? == "cursor" or $entry.source.type == "cursor") then "cursor"
  else null
  end;
def operationally_disabled($entry; $cells; $surface; $vendor):
  ($entry.enabled? != true)
  and (
    ($entry.disabled? == true and $entry.compatibilityStatus? == "disabled")
    or cell_disabled($cells; $vendor; $surface)
  );
def valid_capability($entry; $cells; $surface):
  valid_source($entry)
  and (($entry.source.path? // "") as $path
    | if $path == "" then
        ($entry.source.type == "builtin" or $entry.source.type == "native")
      elif (under_root($path; $personalGrok) or under_root($path; $personalAgents)) then
        false
      elif entry_vendor($entry; $path) != null then
        operationally_disabled($entry; $cells; $surface; entry_vendor($entry; $path))
      else
        true
      end);
def valid_provides($provides):
  ($provides | type) == "object"
  and ($provides.skills | type) == "number"
  and $provides.skills >= 0 and ($provides.skills | floor) == $provides.skills
  and ($provides.agents | type) == "number"
  and $provides.agents >= 0 and ($provides.agents | floor) == $provides.agents
  and ($provides.hooks | type) == "boolean"
  and ($provides.mcpServers | type) == "number"
  and $provides.mcpServers >= 0
  and ($provides.mcpServers | floor) == $provides.mcpServers;
def plugin_surfaces_disabled($plugin; $cells; $vendor):
  (if $plugin.provides.skills > 0 then cell_disabled($cells; $vendor; "skills") else true end)
  and (if $plugin.provides.agents > 0 then cell_disabled($cells; $vendor; "agents") else true end)
  and (if $plugin.provides.hooks then cell_disabled($cells; $vendor; "hooks") else true end)
  and (if $plugin.provides.mcpServers > 0 then cell_disabled($cells; $vendor; "mcps") else true end);
def plugin_child($entry; $plugin):
  (($entry.source.plugin_name? // "") == $plugin.name)
  or (((($entry.source.path? // "") | startswith($plugin.path + "/"))));
def plugin_children_disabled($inspect; $plugin; $cells; $vendor; $class; $surface; $provided):
  if $provided then
    ([$inspect[$class][] | select(plugin_child(.; $plugin))]) as $children
    | ($children | length) > 0
      and all($children[];
        operationally_disabled(.; $cells; $surface; $vendor))
  else true
  end;
def valid_plugin($plugin; $cells; $inspect):
  if (($plugin.path? // "") | nonempty_string) then
    ($plugin.path as $path
    | if (under_root($path; $personalGrok) or under_root($path; $personalAgents)) then
        false
      elif path_vendor($path) != null then
        valid_provides($plugin.provides)
        and plugin_surfaces_disabled($plugin; $cells; path_vendor($path))
        and plugin_children_disabled($inspect; $plugin; $cells; path_vendor($path); "skills"; "skills"; $plugin.provides.skills > 0)
        and plugin_children_disabled($inspect; $plugin; $cells; path_vendor($path); "agents"; "agents"; $plugin.provides.agents > 0)
        and plugin_children_disabled($inspect; $plugin; $cells; path_vendor($path); "hooks"; "hooks"; $plugin.provides.hooks)
        and plugin_children_disabled($inspect; $plugin; $cells; path_vendor($path); "mcpServers"; "mcps"; $plugin.provides.mcpServers > 0)
      else
        true
      end)
  else
    (($plugin.source?.type? == "builtin") or ($plugin.source?.type? == "native"))
  end;

. as $inspect
| (.externalCompat.cells? // null) as $cells
| valid_cells($cells)
and (.skills | type) == "array"
and (.agents | type) == "array"
and (.hooks | type) == "array"
and (.plugins | type) == "array"
and (.mcpServers | type) == "array"
and all(.skills[]; valid_capability(.; $cells; "skills"))
and all(.agents[]; valid_capability(.; $cells; "agents"))
and all(.hooks[]; valid_capability(.; $cells; "hooks"))
and all(.mcpServers[]; valid_capability(.; $cells; "mcps"))
and all(.plugins[]; valid_plugin(.; $cells; $inspect))
# grx-inspect-isolation-filter-end
INSPECT_GATE

jq -e \
  --arg personalGrok "$HOME/.grok/" \
  --arg personalAgents "$HOME/.agents/" \
  --arg personalClaude "$HOME/.claude/" \
  --arg personalCursor "$HOME/.cursor/" \
  -f "$inspect_gate" "$inspect_output" >/dev/null \
  || fail 'inspect leaked enabled personal capabilities or hid native capabilities'
jq -e '
  . as $inspect
  | any(.agents[]; .source.type == "builtin")
  and all(["skills", "agents", "hooks", "mcpServers"][];
    . as $class
    | any($inspect[$class][]; .source.type == "plugin")
    and any($inspect[$class][]; .source.type == "repository"))
  and any(.plugins[]; .scope == "project" and .enabled == true)
  and any(.plugins[]; .name == "hve-core-all" and .enabled == true)
' "$inspect_output" >/dev/null \
  || fail 'inspect fixture hid builtin, plugin, or project-native capabilities'

for personal_surface in skills agents hooks plugins mcps; do
  personal_surface_path="$HOME/.cursor/$personal_surface"
  filesystem_probe="$fixture_root/inspect-without-cursor-$personal_surface.json"
  rm -rf "$personal_surface_path"
  GROK_HOME="$hve_home" "$fake_bin/grok" inspect --json >"$filesystem_probe"
  if [ "$personal_surface" = 'plugins' ]; then
    jq -e --arg root "$HOME/.cursor/plugins/" '
      all(.plugins[]; ((.path? // "") | startswith($root) | not))
    ' "$filesystem_probe" >/dev/null \
      || fail 'inspect fixture emitted a missing personal Cursor plugin surface'
  else
    inspect_class="$personal_surface"
    [ "$inspect_class" != 'mcps' ] || inspect_class='mcpServers'
    jq -e --arg class "$inspect_class" --arg root "$HOME/.cursor/$personal_surface/" '
      all(.[$class][]; ((.source.path? // "") | startswith($root) | not))
    ' "$filesystem_probe" >/dev/null \
      || fail "inspect fixture emitted missing personal Cursor $personal_surface inventory"
  fi
  mkdir -p "$personal_surface_path/personal-cursor"
done

assert_inspect_gate_rejects() {
  local input="$1"
  local fixture_name="$2"

  if jq -e \
    --arg personalGrok "$HOME/.grok/" \
    --arg personalAgents "$HOME/.agents/" \
    --arg personalClaude "$HOME/.claude/" \
    --arg personalCursor "$HOME/.cursor/" \
    -f "$inspect_gate" "$input" >/dev/null; then
    fail "inspect gate accepted $fixture_name"
  fi
}

missing_source_inspect="$fixture_root/inspect-missing-source.json"
jq 'del(.skills[0].source)' "$inspect_output" \
  >"$missing_source_inspect"
assert_inspect_gate_rejects "$missing_source_inspect" \
  'non-builtin capability without source metadata'
missing_source_path_inspect="$fixture_root/inspect-missing-source-path.json"
jq '.skills[0].source = {type:"project"}' "$inspect_output" \
  >"$missing_source_path_inspect"
assert_inspect_gate_rejects "$missing_source_path_inspect" \
  'non-builtin capability without source path'
empty_source_inspect="$fixture_root/inspect-empty-source.json"
jq '.skills[0].source.path = ""' "$inspect_output" >"$empty_source_inspect"
assert_inspect_gate_rejects "$empty_source_inspect" \
  'non-builtin capability with empty source path'
unknown_source_inspect="$fixture_root/inspect-unknown-source.json"
jq '.skills[0].source.type = "mystery"' "$inspect_output" \
  >"$unknown_source_inspect"
assert_inspect_gate_rejects "$unknown_source_inspect" \
  'capability with unknown source type'
enabled_personal_inspect="$fixture_root/inspect-enabled-personal.json"
jq --arg personalClaude "$HOME/.claude/" '
  .skills |= map(
    if ((.source.path? // "") | startswith($personalClaude)) then .enabled = true else . end)
' "$inspect_output" >"$enabled_personal_inspect"
assert_inspect_gate_rejects "$enabled_personal_inspect" \
  'enabled personal capability despite disabled compatibility cell'
enabled_root_hook_inspect="$fixture_root/inspect-enabled-root-hook.json"
jq --arg personalClaudeRoot "${HOME%/}/.claude" '
  .hooks += [{
    event:"session_start",
    enabled:true,
    vendor:"claude",
    source:{type:"user",path:$personalClaudeRoot}
  }]
' "$inspect_output" >"$enabled_root_hook_inspect"
assert_inspect_gate_rejects "$enabled_root_hook_inspect" \
  'enabled personal hook at the exact Claude root'
enabled_claude_json_mcp_inspect="$fixture_root/inspect-enabled-claude-json-mcp.json"
jq --arg claudeJson "${HOME%/}/.claude.json" '
  .mcpServers += [{
    name:"personal-json-mcp",
    enabled:true,
    vendor:"claude",
    source:{type:"claudeJson",path:$claudeJson}
  }]
' "$inspect_output" >"$enabled_claude_json_mcp_inspect"
assert_inspect_gate_rejects "$enabled_claude_json_mcp_inspect" \
  'enabled personal MCP from Claude JSON'
empty_cells_inspect="$fixture_root/inspect-empty-cells.json"
jq '.externalCompat.cells = []' "$inspect_output" >"$empty_cells_inspect"
assert_inspect_gate_rejects "$empty_cells_inspect" 'empty compatibility cells'
for vendor in cursor claude; do
  for surface in skills rules agents mcps hooks sessions; do
    missing_cell_inspect="$fixture_root/inspect-missing-$vendor-$surface-cell.json"
    jq --arg vendor "$vendor" --arg surface "$surface" '
      .externalCompat.cells |= map(
        select(.vendor != $vendor or .surface != $surface))
    ' "$inspect_output" >"$missing_cell_inspect"
    assert_inspect_gate_rejects "$missing_cell_inspect" \
      "missing required $vendor $surface compatibility cell"
  done
done
missing_cell_inspect="$fixture_root/inspect-missing-codex-sessions-cell.json"
jq '.externalCompat.cells |= map(
  select(.vendor != "codex" or .surface != "sessions"))
' "$inspect_output" >"$missing_cell_inspect"
assert_inspect_gate_rejects "$missing_cell_inspect" \
  'missing required codex sessions compatibility cell'
duplicate_cell_inspect="$fixture_root/inspect-duplicate-cell.json"
jq '.externalCompat.cells += [.externalCompat.cells[0]]' "$inspect_output" \
  >"$duplicate_cell_inspect"
assert_inspect_gate_rejects "$duplicate_cell_inspect" \
  'duplicate compatibility cell'
extra_cell_inspect="$fixture_root/inspect-extra-cell.json"
jq '.externalCompat.cells += [{vendor:"unknown",surface:"skills",enabled:false,source:"config"}]' \
  "$inspect_output" >"$extra_cell_inspect"
assert_inspect_gate_rejects "$extra_cell_inspect" 'extra compatibility cell'
malformed_cell_inspect="$fixture_root/inspect-malformed-cell.json"
jq '.externalCompat.cells[0].enabled = "false"' "$inspect_output" \
  >"$malformed_cell_inspect"
assert_inspect_gate_rejects "$malformed_cell_inspect" \
  'malformed compatibility cell'
malformed_plugin_inspect="$fixture_root/inspect-malformed-plugin.json"
jq --arg personalClaude "$HOME/.claude/" '
  .plugins |= map(
    if (.path | startswith($personalClaude)) then .provides.skills = "1" else . end)
' "$inspect_output" >"$malformed_plugin_inspect"
assert_inspect_gate_rejects "$malformed_plugin_inspect" \
  'personal plugin metadata with malformed provides schema'
missing_plugin_path_inspect="$fixture_root/inspect-missing-plugin-path.json"
jq 'del(.plugins[0].path)' "$inspect_output" >"$missing_plugin_path_inspect"
assert_inspect_gate_rejects "$missing_plugin_path_inspect" \
  'non-native plugin metadata without a path'

weakened_inspect_home="$fixture_root/weakened-inspect-home"
mkdir -p "$weakened_inspect_home"
assert_compat_surface_fixture() {
  local vendor="$1"
  local surface="$2"
  local inspect_class="$3"
  local output="$fixture_root/weakened-$vendor-$surface-inspect.json"
  local personal_root="$HOME/.$vendor/"

  awk -v section="[compat.$vendor]" -v surface="$surface" '
    $0 == section { in_vendor = 1 }
    in_vendor && $0 == (surface " = false") {
      print surface " = true"
      next
    }
    in_vendor && /^\[/ && $0 != section { in_vendor = 0 }
    { print }
  ' "$expected_policy" >"$weakened_inspect_home/requirements.toml"
  GROK_HOME="$weakened_inspect_home" "$fake_bin/grok" inspect --json >"$output"

  jq -e \
    --arg vendor "$vendor" \
    --arg surface "$surface" \
    --arg inspectClass "$inspect_class" \
    --arg personalRoot "$personal_root" '
    . as $inspect
    | any($inspect[$inspectClass][];
        .enabled == true
        and ((.source.path? // "") | startswith($personalRoot)))
    and all(["skills", "agents", "hooks", "mcpServers"][];
      if . == $inspectClass then true
      else . as $class
        | all($inspect[$class][];
            if ((.source.path? // "") | startswith($personalRoot)) then
              .enabled? != true
            else true
            end)
      end)
    and any($inspect.externalCompat.cells[];
      .vendor == $vendor and .surface == $surface and .enabled == true)
  ' "$output" >/dev/null \
    || fail "inspect fixture did not model $vendor $surface independently"

  if jq -e \
    --arg personalGrok "$HOME/.grok/" \
    --arg personalAgents "$HOME/.agents/" \
    --arg personalClaude "$HOME/.claude/" \
    --arg personalCursor "$HOME/.cursor/" \
    -f "$inspect_gate" "$output" >/dev/null; then
    fail "inspect gate accepted enabled $vendor $surface compatibility"
  fi
}

for vendor in claude cursor; do
  assert_compat_surface_fixture "$vendor" skills skills
  assert_compat_surface_fixture "$vendor" agents agents
  assert_compat_surface_fixture "$vendor" hooks hooks
  assert_compat_surface_fixture "$vendor" mcps mcpServers
done

assert_compat_cell_fixture() {
  local vendor="$1"
  local surface="$2"
  local output="$fixture_root/weakened-$vendor-$surface-cell-inspect.json"

  awk -v section="[compat.$vendor]" -v surface="$surface" '
    $0 == section { in_vendor = 1 }
    in_vendor && $0 == (surface " = false") {
      print surface " = true"
      next
    }
    in_vendor && /^\[/ && $0 != section { in_vendor = 0 }
    { print }
  ' "$expected_policy" >"$weakened_inspect_home/requirements.toml"
  GROK_HOME="$weakened_inspect_home" "$fake_bin/grok" inspect --json >"$output"
  jq -e --arg vendor "$vendor" --arg surface "$surface" '
    any(.externalCompat.cells[];
      .vendor == $vendor and .surface == $surface and .enabled == true)
  ' "$output" >/dev/null \
    || fail "inspect fixture did not derive the $vendor $surface cell from policy"
  assert_inspect_gate_rejects "$output" "enabled $vendor $surface cell"
}

for vendor in claude cursor; do
  assert_compat_cell_fixture "$vendor" rules
  assert_compat_cell_fixture "$vendor" sessions
done
assert_compat_cell_fixture codex sessions

agents_policy_home="$fixture_root/weakened-agents-policy-home"
agents_policy_output="$fixture_root/weakened-agents-policy-inspect.json"
mkdir -p "$agents_policy_home"
sed '/^ignore = \["~\/.agents\/skills", "~\/.agents\/commands"\]$/d' \
  "$expected_policy" >"$agents_policy_home/requirements.toml"
GROK_HOME="$agents_policy_home" "$fake_bin/grok" inspect --json \
  >"$agents_policy_output"
jq -e --arg personalAgents "$HOME/.agents/" '
  any(.skills[];
    .enabled == true and (.source.path | startswith($personalAgents)))
  and all(.agents[], .hooks[], .mcpServers[];
    ((.source.path? // "") | startswith($personalAgents) | not))
  and all(.plugins[];
    ((.path? // "") | startswith($personalAgents) | not))
' "$agents_policy_output" >/dev/null \
  || fail 'skills.ignore fixture claimed unsupported .agents surface isolation'
assert_inspect_gate_rejects "$agents_policy_output" \
  'personal .agents skill after skills.ignore removal'

personal_grok_inspect_output="$fixture_root/personal-grok-inspect.json"
cp "$expected_policy" "$HOME/.grok/requirements.toml"
GROK_HOME="$HOME/.grok" "$fake_bin/grok" inspect --json \
  >"$personal_grok_inspect_output"
rm "$HOME/.grok/requirements.toml"
jq -e --arg personalGrok "$HOME/.grok/" '
  . as $inspect
  | ["skills", "agents", "hooks", "mcpServers"]
  | all(.[];
      . as $class
      | any($inspect[$class][]; .enabled == true and (.source.path | startswith($personalGrok)))
    )
  and any($inspect.plugins[];
    .enabled == true and (.path | startswith($personalGrok)))
' "$personal_grok_inspect_output" >/dev/null \
  || fail 'inspect fixture did not expose personal Grok capabilities outside isolation'

jq -e '
  (map(.scope) | sort) == ["native", "plugin", "repository"]
  and all(.[]; .enabled == true)
' "$mcp_output" >/dev/null \
  || fail 'MCP fixture did not isolate user MCPs while preserving native capabilities'
jq -e '
  length == 1 and .[0].status == "installed" and .[0].name == "hve-core-all"
' "$plugin_output" >/dev/null \
  || fail 'plugin fixture did not expose exactly the expected profile plugin'

printf 'damaged policy\n' >"$hve_home/requirements.toml"
rm "$hve_home/fake-state/plugins.json"
./bin/grx hve --version >"$fixture_root/hve-launch-repair.out" \
  || fail 'launch did not restore managed policy and plugin'
cmp -s "$expected_policy" "$hve_home/requirements.toml" \
  || fail 'launch did not restore the exact capability policy'
jq -e --arg path "$hve_install_path" '. == [{
  status:"installed",
  name:"hve-core-all",
  repo_key:"hve-core-fixture",
  version:null,
  path:$path,
  source:"https://github.com/microsoft/hve-core",
  marketplace:null
}]' "$hve_plugins_file" >/dev/null || fail 'launch did not restore the HVE plugin'
cmp -s "$HOME/.grok/auth.json" "$hve_home/auth.json" \
  || fail 'launch repair did not refresh authentication'
assert_line 'keep session' "$hve_home/sessions/keep"
assert_line 'keep memory' "$hve_home/memory/keep"
assert_line 'keep permissions' "$hve_home/permissions/keep"

assert_doctor_failure() {
  local fixture_name="$1"
  local expected="$2"
  local stderr_file="$fixture_root/$fixture_name.err"

  if ./bin/grx doctor hve >"$fixture_root/$fixture_name.out" 2>"$stderr_file"; then
    fail "$fixture_name doctor unexpectedly succeeded"
  fi
  assert_contains "$expected" "$stderr_file"
}

sed 's/^fail_closed = true$/fail_closed = false/' "$expected_policy" \
  >"$hve_home/requirements.toml"
assert_doctor_failure 'false fail_closed' \
  'grx: requirements policy does not match: hve'
assert_launch_repairs_current_policy 'false-fail-closed'
cmp -s "$expected_policy" "$hve_home/requirements.toml" \
  || fail 'launch did not restore fail_closed = true'

jq '.[0].name = "unexpected"' "$hve_plugins_file" \
  >"$fixture_root/hve-unexpected-plugin.json"
mv "$fixture_root/hve-unexpected-plugin.json" "$hve_plugins_file"
assert_doctor_failure 'unexpected plugin' 'grx: installed plugin inventory does not match: hve'
printf '%s\n' "$hve_native_inventory" >"$hve_plugins_file"

jq '.[0].source = "https://github.com/fixture/wrong-source"' "$hve_plugins_file" \
  >"$fixture_root/hve-wrong-plugin-source.json"
mv "$fixture_root/hve-wrong-plugin-source.json" "$hve_plugins_file"
assert_doctor_failure 'wrong plugin source' 'grx: installed plugin inventory does not match: hve'
printf '%s\n' "$hve_native_inventory" >"$hve_plugins_file"

chmod 0755 "$hve_home"
assert_doctor_failure 'profile home mode' 'grx: profile home must have mode 0700: hve'
chmod 0700 "$hve_home"

chmod 0600 "$hve_home/requirements.toml"
assert_doctor_failure 'requirements policy mode' 'grx: requirements policy must have mode 0644: hve'
chmod 0644 "$hve_home/requirements.toml"

mkdir -p "$hve_home/skills"
printf 'unexpected\n' >"$hve_home/skills/unexpected"
assert_doctor_failure 'nonempty skills' "grx: standalone capability directory is not empty: $hve_home/skills"
rm "$hve_home/skills/unexpected"

mkdir -p "$hve_home/commands"
printf 'unexpected\n' >"$hve_home/commands/unexpected"
assert_doctor_failure 'nonempty commands' "grx: standalone capability directory is not empty: $hve_home/commands"
rm "$hve_home/commands/unexpected"

rmdir "$hve_home/skills"
empty_skills_target="$fixture_root/empty-skills-target"
mkdir -p "$empty_skills_target"
ln -s "$empty_skills_target" "$hve_home/skills"
assert_doctor_failure 'symlinked skills' "grx: unsafe standalone capability directory: $hve_home/skills"
rm "$hve_home/skills"
mkdir -p "$hve_home/skills"

rmdir "$hve_home/commands"
printf 'not a directory\n' >"$hve_home/commands"
assert_doctor_failure 'nondirectory commands' "grx: unsafe standalone capability directory: $hve_home/commands"
rm "$hve_home/commands"
mkdir -p "$hve_home/commands"

chmod 0000 "$hve_home/skills"
assert_doctor_failure 'unreadable skills' "grx: failed to inspect standalone capability directory: $hve_home/skills"
chmod 0700 "$hve_home/skills"

export FAKE_GROK_MCP_JSON='[{"name":"personal","scope":"user","enabled":true}]'
profile_config="$hve_home/config.toml"
printf '%s\n' \
  '[mcp_servers.personal]' \
  'command = "profile-local-mcp"' \
  >"$profile_config"
cp "$profile_config" "$fixture_root/profile-config-before-lifecycle.toml"
./bin/grx doctor hve >"$fixture_root/profile-user-mcp-doctor.out"
assert_line 'hve: healthy (plugin hve-core-all, version 3.3.101)' \
  "$fixture_root/profile-user-mcp-doctor.out"
./bin/grx setup hve >"$fixture_root/profile-user-mcp-setup.out"
assert_line 'hve: ready' "$fixture_root/profile-user-mcp-setup.out"
./bin/grx repair hve >"$fixture_root/profile-user-mcp-repair.out"
assert_line 'hve: repaired' "$fixture_root/profile-user-mcp-repair.out"
./bin/grx hve --profile-user-mcp >"$fixture_root/profile-user-mcp-launch.out"
jq -s -e --arg home "$hve_home" '
  last
  | .grokHome == $home
  and .args == ["--permission-mode","bypassPermissions","--profile-user-mcp"]
' "$fake_grok_log" >/dev/null \
  || fail 'launch did not allow the profile-local user MCP inventory'
cmp -s "$profile_config" "$fixture_root/profile-config-before-lifecycle.toml" \
  || fail 'profile-local MCP config changed during lifecycle operations'
rm "$profile_config"
export FAKE_GROK_MCP_JSON='[{"name":"project-native","scope":"project","enabled":true},{"name":"repository-native","scope":"repository","enabled":true},{"name":"built-in","scope":"native","enabled":true}]'
./bin/grx doctor hve >"$fixture_root/native-mcp-doctor.out"
assert_line 'hve: healthy (plugin hve-core-all, version 3.3.101)' \
  "$fixture_root/native-mcp-doctor.out"
export FAKE_GROK_MCP_JSON='[{"name":"unknown","scope":"team","enabled":true}]'
assert_doctor_failure 'unknown mcp scope' 'grx: invalid MCP inventory for hve'
export FAKE_GROK_MCP_JSON='[{"scope":"plugin","enabled":true}]'
assert_doctor_failure 'malformed mcp record' 'grx: invalid MCP inventory for hve'
export FAKE_GROK_MCP_JSON='[{"name":"incomplete","scope":"plugin"}]'
assert_doctor_failure 'incomplete mcp record' 'grx: invalid MCP inventory for hve'
export FAKE_GROK_MCP_JSON=$'{}\n[]'
assert_doctor_failure 'mcp unexpected then valid document' 'grx: invalid MCP inventory for hve'
export FAKE_GROK_MCP_JSON=$'[]\n{}'
assert_doctor_failure 'mcp valid then unexpected document' 'grx: invalid MCP inventory for hve'
export FAKE_GROK_MCP_JSON='[{"name":"bundled","scope":"plugin","enabled":true}]'
./bin/grx doctor hve >"$fixture_root/plugin-mcp-doctor.out"
assert_line 'hve: healthy (plugin hve-core-all, version 3.3.101)' "$fixture_root/plugin-mcp-doctor.out"
unset FAKE_GROK_MCP_JSON

export FAKE_GROK_LIST_FAILURE_HOME="$hve_home"
assert_doctor_failure 'plugin list failure' 'grx: failed to read installed plugin inventory: hve'
unset FAKE_GROK_LIST_FAILURE_HOME

missing_auth_home="$fixture_root/missing-auth-home"
mkdir -p "$missing_auth_home"
for lifecycle in setup repair; do
  rm -rf "$missing_auth_home/.local" "$missing_auth_home/.grok"
  missing_auth_before="$(profile_tree_hash "$missing_auth_home")"
  missing_profile_home="$missing_auth_home/.local/share/trellage/profiles/grok/hve/home"
  missing_auth_mutations_before="$(jq -s --arg home "$missing_profile_home" '
    [.[] | select(
      .grokHome == $home
      and (.args[0:2] == ["plugin","install"] or .args[0:2] == ["plugin","update"])
    )] | length
  ' "$fake_grok_log")"
  missing_auth_stderr="$fixture_root/missing-auth-$lifecycle.err"
  if HOME="$missing_auth_home" ./bin/grx "$lifecycle" hve \
    >"$fixture_root/missing-auth-$lifecycle.out" 2>"$missing_auth_stderr"; then
    fail "$lifecycle without source authentication unexpectedly succeeded"
  fi
  assert_contains 'source authentication is missing or unreadable' "$missing_auth_stderr"
  missing_auth_after="$(profile_tree_hash "$missing_auth_home")"
  [ "$missing_auth_after" = "$missing_auth_before" ] \
    || fail "$lifecycle mutated an absent profile before rejecting missing source auth"
  missing_auth_mutations_after="$(jq -s --arg home "$missing_profile_home" '
    [.[] | select(
      .grokHome == $home
      and (.args[0:2] == ["plugin","install"] or .args[0:2] == ["plugin","update"])
    )] | length
  ' "$fake_grok_log")"
  [ "$missing_auth_mutations_after" = "$missing_auth_mutations_before" ] \
    || fail "$lifecycle invoked install/update before rejecting missing source auth"
done

symlink_home="$fixture_root/symlink-home"
escaped_profiles="$fixture_root/escaped-profiles"
mkdir -p "$symlink_home/.grok" "$escaped_profiles"
printf 'source-auth\n' >"$symlink_home/.grok/auth.json"
chmod 0600 "$symlink_home/.grok/auth.json"
ln -s "$escaped_profiles" "$symlink_home/.local"
symlink_home_stderr="$fixture_root/symlink-home.err"
if HOME="$symlink_home" ./bin/grx setup hve \
  >"$fixture_root/symlink-home.out" 2>"$symlink_home_stderr"; then
  fail 'setup accepted a symlinked managed profile ancestor'
fi
assert_contains 'grx: unsafe profile home path:' "$symlink_home_stderr"
[ ! -e "$escaped_profiles/share/trellage/profiles/grok/hve/home" ] \
  || fail 'setup wrote through a symlinked managed profile ancestor'

rm -rf "$HOME/.local/share/trellage/profiles/grok"
all_setup_output="$fixture_root/all-setup.out"
./bin/grx setup --all >"$all_setup_output"
for profile in hve superpowers; do
  profile_home="$HOME/.local/share/trellage/profiles/grok/$profile/home"
  cmp -s "$expected_policy" "$profile_home/requirements.toml" \
    || fail "setup --all did not provision policy for $profile"
  cmp -s "$HOME/.grok/auth.json" "$profile_home/auth.json" \
    || fail "setup --all did not provision authentication for $profile"
  ./bin/grx doctor "$profile" >"$fixture_root/$profile-all-doctor.out"
  assert_contains "$profile: healthy (" "$fixture_root/$profile-all-doctor.out"
  ./bin/grx "$profile" --version >"$fixture_root/$profile-launch.out"
  assert_line "GROK_HOME=$profile_home" "$fixture_root/$profile-launch.out"
done

superpowers_home="$HOME/.local/share/trellage/profiles/grok/superpowers/home"
superpowers_install_path="$superpowers_home/installed-plugins/superpowers-fixture"
superpowers_local_manifest="$superpowers_install_path/.claude-plugin/plugin.json"
[ -f "$superpowers_local_manifest" ] && [ ! -L "$superpowers_local_manifest" ] \
  || fail 'Superpowers did not use its root plugin manifest convention'
assert_line 'superpowers: healthy (plugin superpowers, version 6.2.0)' \
  "$fixture_root/superpowers-all-doctor.out"
mkdir -p "$superpowers_install_path/.github/plugin"
cp "$superpowers_local_manifest" \
  "$superpowers_install_path/.github/plugin/plugin.json"
if ./bin/grx doctor superpowers >"$fixture_root/superpowers-duplicate-manifest.out" \
  2>"$fixture_root/superpowers-duplicate-manifest.err"; then
  fail 'Superpowers doctor accepted duplicate root manifest candidates'
fi
assert_line 'grx: installed plugin inventory does not match: superpowers' \
  "$fixture_root/superpowers-duplicate-manifest.err"
rm -rf "$superpowers_install_path/.github"

export FAKE_CURL_FAILURE_URL='https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json'
all_check_status=0
./bin/grx update --check --all >"$fixture_root/all-check.out" \
  2>"$fixture_root/all-check.err" || all_check_status=$?
[ "$all_check_status" -eq 2 ] \
  || fail "update check --all with a manifest failure exited $all_check_status instead of 2"
assert_line 'grx: failed to fetch or parse official manifest for superpowers' \
  "$fixture_root/all-check.err"
unset FAKE_CURL_FAILURE_URL

jq '.version = "6.1.0"' "$superpowers_local_manifest" \
  >"$fixture_root/superpowers-outdated.json"
mv "$fixture_root/superpowers-outdated.json" "$superpowers_local_manifest"
hve_safe_home="$fixture_root/hve-safe-home"
mv "$hve_home" "$hve_safe_home"
ln -s "$hve_safe_home" "$hve_home"
mixed_check_status=0
./bin/grx update --check --all >"$fixture_root/mixed-check.out" \
  2>"$fixture_root/mixed-check.err" || mixed_check_status=$?
rm "$hve_home"
mv "$hve_safe_home" "$hve_home"
jq '.version = "6.2.0"' "$superpowers_local_manifest" \
  >"$fixture_root/superpowers-current.json"
mv "$fixture_root/superpowers-current.json" "$superpowers_local_manifest"
[ "$mixed_check_status" -eq 2 ] \
  || fail "mixed update check exited $mixed_check_status instead of 2"
assert_line 'superpowers: update available (6.1.0 -> 6.2.0)' "$fixture_root/mixed-check.out"
assert_line "grx: unsafe profile home path: $hve_home" "$fixture_root/mixed-check.err"

if ./bin/grx setup >"$fixture_root/setup-arity.out" 2>"$fixture_root/setup-arity.err"; then
  fail 'setup without a profile unexpectedly succeeded'
fi
assert_line 'grx: setup requires PROFILE or --all' "$fixture_root/setup-arity.err"
if ./bin/grx doctor hve extra >"$fixture_root/doctor-arity.out" 2>"$fixture_root/doctor-arity.err"; then
  fail 'doctor with extra arguments unexpectedly succeeded'
fi
assert_line 'grx: doctor requires PROFILE' "$fixture_root/doctor-arity.err"
if ./bin/grx repair >"$fixture_root/repair-arity.out" 2>"$fixture_root/repair-arity.err"; then
  fail 'repair without a profile unexpectedly succeeded'
fi
assert_line 'grx: repair requires PROFILE' "$fixture_root/repair-arity.err"
if ./bin/grx update >"$fixture_root/update-arity.out" 2>"$fixture_root/update-arity.err"; then
  fail 'update without a profile unexpectedly succeeded'
fi
assert_line 'grx: update requires PROFILE or --all' "$fixture_root/update-arity.err"
if ./bin/grx update --check >"$fixture_root/check-arity.out" 2>"$fixture_root/check-arity.err"; then
  fail 'update --check without a profile unexpectedly succeeded'
fi
assert_line 'grx: update --check requires PROFILE or --all' "$fixture_root/check-arity.err"

export FAKE_JQ_PROFILE_LIST_FAILURE=1
if ./bin/grx setup --all >"$fixture_root/profile-list-failure.out" \
  2>"$fixture_root/profile-list-failure.err"; then
  fail 'setup --all ignored a profile-list query failure'
fi
assert_contains 'grx: failed to read profile list' "$fixture_root/profile-list-failure.err"
unset FAKE_JQ_PROFILE_LIST_FAILURE

installer='./install.sh'
uninstaller='./uninstall.sh'
runtime_root="$HOME/.local/share/trellage/grx"
installed_command="$HOME/.local/bin/grx"
installed_launcher="$runtime_root/bin/grx"
installed_catalog="$runtime_root/catalog.json"

managed_install_state() {
  {
    printf 'runtime-root-mode\t%s\n' "$(path_mode "$runtime_root")"
    printf 'runtime-tree\t%s\n' "$(profile_tree_hash "$runtime_root")"
    printf 'command-dir-mode\t%s\n' "$(path_mode "$(dirname "$installed_command")")"
    printf 'command-mode\t%s\n' "$(path_mode "$installed_command")"
    printf 'command-target\t%s\n' "$(readlink "$installed_command")"
    printf 'command-inode\t%s\n' "$(path_inode "$installed_command")"
  } | sha256_digest
}

partial_install_state() {
  {
    if [ -d "$runtime_root" ] && [ ! -L "$runtime_root" ]; then
      printf 'runtime-root-mode\t%s\n' "$(path_mode "$runtime_root")"
      printf 'runtime-tree\t%s\n' "$(profile_tree_hash "$runtime_root")"
    else
      printf 'runtime-root\tabsent-or-unsafe\n'
    fi
    printf 'command-dir-mode\t%s\n' "$(path_mode "$(dirname "$installed_command")")"
    if [ -L "$installed_command" ]; then
      printf 'command-mode\t%s\n' "$(path_mode "$installed_command")"
      printf 'command-target\t%s\n' "$(readlink "$installed_command")"
      printf 'command-inode\t%s\n' "$(path_inode "$installed_command")"
    elif [ -e "$installed_command" ]; then
      printf 'command\tunsafe-present\n'
    else
      printf 'command\tabsent\n'
    fi
  } | sha256_digest
}

managed_paths_state() {
  local managed_root="$1"
  local managed_command="$2"

  {
    printf 'runtime-root-mode\t%s\n' "$(path_mode "$managed_root")"
    printf 'runtime-tree\t%s\n' "$(profile_tree_hash "$managed_root")"
    printf 'command-dir-mode\t%s\n' "$(path_mode "$(dirname "$managed_command")")"
    printf 'command-mode\t%s\n' "$(path_mode "$managed_command")"
    printf 'command-target\t%s\n' "$(readlink "$managed_command")"
    printf 'command-inode\t%s\n' "$(path_inode "$managed_command")"
  } | sha256_digest
}

uninstall_preservation_state() {
  local unexpected_path="$1"

  {
    printf 'runtime-root-mode\t%s\n' "$(path_mode "$runtime_root")"
    printf 'runtime-bin-mode\t%s\n' "$(path_mode "$runtime_root/bin")"
    printf 'launcher-mode\t%s\n' "$(path_mode "$installed_launcher")"
    printf 'launcher-hash\t%s\n' "$(sha256_file "$installed_launcher")"
    printf 'catalog-mode\t%s\n' "$(path_mode "$installed_catalog")"
    printf 'catalog-hash\t%s\n' "$(sha256_file "$installed_catalog")"
    printf 'marker-mode\t%s\n' \
      "$(path_mode "$runtime_root/.managed-by-trellage-grok-profiles")"
    printf 'marker-hash\t%s\n' \
      "$(sha256_file "$runtime_root/.managed-by-trellage-grok-profiles")"
    printf 'command-mode\t%s\n' "$(path_mode "$installed_command")"
    printf 'command-target\t%s\n' "$(readlink "$installed_command")"
    printf 'command-inode\t%s\n' "$(path_inode "$installed_command")"
    printf 'unexpected-mode\t%s\n' "$(path_mode "$unexpected_path")"
    printf 'unexpected-hash\t%s\n' \
      "$(sha256_file "$unexpected_path")"
  } | sha256_digest
}

[ -x "$installer" ] || fail "missing executable installer: $installer"
[ -x "$uninstaller" ] || fail "missing executable uninstaller: $uninstaller"

prepublication_home="$fixture_root/prepublication-home"
mkdir "$prepublication_home"
printf 'preserve unrelated data\n' >"$prepublication_home/sentinel"
prepublication_status=0
HOME="$prepublication_home" \
  GRX_INSTALL_TEST_FAIL_AT=interrupt-after-install-root-create \
  "$installer" >"$fixture_root/prepublication-interrupt.out" \
  2>"$fixture_root/prepublication-interrupt.err" || prepublication_status=$?
[ "$prepublication_status" -eq 130 ] \
  || fail "pre-publication INT installer exited $prepublication_status instead of 130"
prepublication_runtime="$prepublication_home/.local/share/trellage/grx"
prepublication_command_dir="$prepublication_home/.local/bin"
[ ! -e "$prepublication_runtime" ] && [ ! -L "$prepublication_runtime" ] \
  || fail 'pre-publication INT left its newly created runtime root'
[ ! -e "$prepublication_command_dir" ] && [ ! -L "$prepublication_command_dir" ] \
  || fail 'pre-publication INT left its newly created command directory'
[ -z "$(find "$prepublication_home/.local/share/trellage" -maxdepth 1 \
  -name '.grx-install.*' -print -quit)" ] \
  || fail 'pre-publication INT left runtime staging debris'
assert_line 'preserve unrelated data' "$prepublication_home/sentinel"

mutation_blocker="$fixture_root/mutation-blocker"
mutation_log="$fixture_root/mutation.log"
mkdir -p "$mutation_blocker"
for command in chmod install ln mkdir mktemp mv rm rmdir; do
  cat >"$mutation_blocker/$command" <<'BLOCK_MUTATION'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$(basename "$0")" >>"${MUTATION_LOG:?}"
printf 'fixture blocked mutation\n' >&2
exit 97
BLOCK_MUTATION
  chmod 0555 "$mutation_blocker/$command"
done

assert_unsafe_home() {
  local script="$1"
  local fixture_name="$2"
  local unsafe_home="$3"

  : >"$mutation_log"
  if HOME="$unsafe_home" MUTATION_LOG="$mutation_log" \
    PATH="$mutation_blocker:$PATH" "$script" \
    >"$fixture_root/$fixture_name.out" 2>"$fixture_root/$fixture_name.err"; then
    fail "$fixture_name accepted an unsafe HOME"
  fi
  assert_contains 'refusing unsafe HOME' "$fixture_root/$fixture_name.err"
  [ ! -s "$mutation_log" ] || fail "$fixture_name mutated before validating HOME"
}

[ ! -e '/.local/share/trellage/grx' ] && [ ! -L '/.local/share/trellage/grx' ] \
  || fail 'unsafe-HOME fixture requires an unused root runtime path'
for script in "$installer" "$uninstaller"; do
  script_name="$(basename "$script" .sh)"
  assert_unsafe_home "$script" "$script_name empty HOME" ''
  assert_unsafe_home "$script" "$script_name root HOME" '/'
  assert_unsafe_home "$script" "$script_name relative HOME" 'relative-home'
done
[ ! -e "$prototype_root/relative-home" ] \
  || fail 'unsafe relative HOME created state in the prototype'

symlink_home_target="$fixture_root/symlink-home-target-for-install"
symlink_home_path="$fixture_root/symlink-home-for-install"
file_home_path="$fixture_root/file-home-for-install"
mkdir -p "$symlink_home_target"
printf 'home sentinel\n' >"$symlink_home_target/sentinel"
printf 'not a home directory\n' >"$file_home_path"
ln -s "$symlink_home_target" "$symlink_home_path"
for script in "$installer" "$uninstaller"; do
  script_name="$(basename "$script" .sh)"
  assert_unsafe_home "$script" "$script_name symlink HOME" "$symlink_home_path"
  assert_unsafe_home "$script" "$script_name file HOME" "$file_home_path"
done
assert_line 'home sentinel' "$symlink_home_target/sentinel"

ancestor_install_home="$fixture_root/ancestor-install-home"
ancestor_install_target="$fixture_root/ancestor-install-target"
mkdir -p "$ancestor_install_home/.local" "$ancestor_install_target"
printf 'ancestor sentinel\n' >"$ancestor_install_target/sentinel"
ln -s "$ancestor_install_target" "$ancestor_install_home/.local/share"
ancestor_install_hash_before="$(profile_tree_hash "$ancestor_install_target")"
if HOME="$ancestor_install_home" "$installer" \
  >"$fixture_root/ancestor-install.out" 2>"$fixture_root/ancestor-install.err"; then
  fail 'installer accepted a symlinked runtime ancestor'
fi
assert_contains 'refusing unsafe managed path' "$fixture_root/ancestor-install.err"
ancestor_install_hash_after="$(profile_tree_hash "$ancestor_install_target")"
[ "$ancestor_install_hash_after" = "$ancestor_install_hash_before" ] \
  || fail 'installer mutated a symlinked runtime ancestor target'
[ ! -e "$ancestor_install_home/.local/bin/grx" ] \
  && [ ! -L "$ancestor_install_home/.local/bin/grx" ] \
  || fail 'installer created a command after finding a symlinked ancestor'

ancestor_uninstall_home="$fixture_root/ancestor-uninstall-home"
ancestor_uninstall_target="$fixture_root/ancestor-uninstall-target"
mkdir -p "$ancestor_uninstall_home" "$ancestor_uninstall_target"
HOME="$ancestor_uninstall_home" "$installer" >/dev/null
mv "$ancestor_uninstall_home/.local/bin" "$ancestor_uninstall_target/bin"
ln -s "$ancestor_uninstall_target/bin" "$ancestor_uninstall_home/.local/bin"
ancestor_uninstall_hash_before="$(profile_tree_hash "$ancestor_uninstall_target")"
installed_ancestor_launcher="$ancestor_uninstall_home/.local/share/trellage/grx/bin/grx"
installed_ancestor_hash_before="$(sha256_file "$installed_ancestor_launcher")"
if HOME="$ancestor_uninstall_home" "$uninstaller" \
  >"$fixture_root/ancestor-uninstall.out" 2>"$fixture_root/ancestor-uninstall.err"; then
  fail 'uninstaller accepted a symlinked command ancestor'
fi
assert_contains 'refusing unsafe managed path' "$fixture_root/ancestor-uninstall.err"
ancestor_uninstall_hash_after="$(profile_tree_hash "$ancestor_uninstall_target")"
[ "$ancestor_uninstall_hash_after" = "$ancestor_uninstall_hash_before" ] \
  || fail 'uninstaller mutated a symlinked command ancestor target'
[ -f "$installed_ancestor_launcher" ] \
  || fail 'uninstaller removed runtime state after finding a symlinked ancestor'
[ "$(sha256_file "$installed_ancestor_launcher")" \
  = "$installed_ancestor_hash_before" ] \
  || fail 'uninstaller changed runtime state after finding a symlinked ancestor'

mkdir -p "$(dirname "$installed_command")"
printf 'unrelated command\n' >"$installed_command"
chmod 0755 "$installed_command"
if "$installer" >"$fixture_root/collision.out" 2>"$fixture_root/collision.err"; then
  fail 'installer overwrote an unrelated command'
fi
assert_contains 'refusing to replace unrelated command' "$fixture_root/collision.err"
assert_line 'unrelated command' "$installed_command"
rm "$installed_command"

mkdir -p "$runtime_root/bin"
printf 'unrelated launcher\n' >"$installed_launcher"
printf 'unrelated catalog\n' >"$installed_catalog"
if "$installer" >"$fixture_root/unowned-runtime.out" \
  2>"$fixture_root/unowned-runtime.err"; then
  fail 'installer overwrote an unowned runtime root'
fi
assert_contains 'refusing unowned runtime root' "$fixture_root/unowned-runtime.err"
assert_line 'unrelated launcher' "$installed_launcher"
assert_line 'unrelated catalog' "$installed_catalog"
rm -rf "$runtime_root"
rmdir "$(dirname "$installed_command")"
mkdir -m 0700 "$(dirname "$installed_command")"

if GRX_INSTALL_TEST_FAIL_AT=after-staging "$installer" \
  >"$fixture_root/clean-after-staging.out" \
  2>"$fixture_root/clean-after-staging.err"; then
  fail 'clean installer ignored the after-staging failure injection'
fi
assert_contains 'injected failure at after-staging' \
  "$fixture_root/clean-after-staging.err"
[ ! -e "$runtime_root" ] && [ ! -L "$runtime_root" ] \
  || fail 'staging failure left a falsely owned runtime'
[ ! -e "$installed_command" ] && [ ! -L "$installed_command" ] \
  || fail 'staging failure left a command behind'
[ "$(path_mode "$(dirname "$installed_command")")" = '700' ] \
  || fail 'staging failure changed the prior command directory mode'
[ -z "$(find "$(dirname "$runtime_root")" -maxdepth 1 \
  -name '.grx-install.*' -print -quit)" ] \
  || fail 'staging failure left a staging directory behind'

rmdir "$(dirname "$installed_command")"
if GRX_INSTALL_TEST_FAIL_AT=after-command-publish "$installer" \
  >"$fixture_root/clean-after-command-publish.out" \
  2>"$fixture_root/clean-after-command-publish.err"; then
  fail 'clean installer ignored the after-command-publish failure injection'
fi
assert_contains 'injected failure at after-command-publish' \
  "$fixture_root/clean-after-command-publish.err"
[ ! -e "$runtime_root" ] && [ ! -L "$runtime_root" ] \
  || fail 'command publication failure left a falsely owned runtime'
[ ! -e "$installed_command" ] && [ ! -L "$installed_command" ] \
  || fail 'command publication failure left a command behind'
[ ! -e "$(dirname "$installed_command")" ] \
  && [ ! -L "$(dirname "$installed_command")" ] \
  || fail 'command publication failure left its newly created command directory behind'
[ -z "$(find "$(dirname "$runtime_root")" -maxdepth 1 \
  -name '.grx-install.*' -print -quit)" ] \
  || fail 'command publication failure left a runtime staging directory behind'
mkdir -m 0700 "$(dirname "$installed_command")"

"$installer" >"$fixture_root/install.out"
if ! cmp -s "$fixture_root/install.out" \
  <(printf 'Installed grx at %s\n' "$installed_command"); then
  fail 'installer did not emit the exact installed line'
fi
[ -L "$installed_command" ] || fail 'installer did not create a command symlink'
[ "$(readlink "$installed_command")" = "$installed_launcher" ] \
  || fail 'installer command symlink has the wrong target'
[ -x "$installed_launcher" ] || fail 'installer did not create an executable launcher'
[ -f "$installed_catalog" ] && [ ! -L "$installed_catalog" ] \
  || fail 'installer did not create a regular catalog'
assert_line 'trellage-grok-profiles-v1' \
  "$runtime_root/.managed-by-trellage-grok-profiles"
[ "$(path_mode "$runtime_root")" = '755' ] \
  || fail 'installer did not set runtime root mode 0755'
[ "$(path_mode "$runtime_root/bin")" = '755' ] \
  || fail 'installer did not set runtime bin mode 0755'
[ "$(path_mode "$(dirname "$installed_command")")" = '700' ] \
  || fail 'installer changed the pre-existing command directory mode'
[ "$(path_mode "$installed_launcher")" = '755' ] \
  || fail 'installer did not set launcher mode 0755'
[ "$(path_mode "$installed_catalog")" = '644' ] \
  || fail 'installer did not set catalog mode 0644'
[ "$(path_mode "$runtime_root/.managed-by-trellage-grok-profiles")" = '644' ] \
  || fail 'installer did not set ownership marker mode 0644'
"$installed_command" list >"$fixture_root/installed-list.out"
if ! cmp -s "$fixture_root/installed-list.out" <(printf '%s\n' \
  $'hve\thve-core-all' \
  $'superpowers\tsuperpowers'); then
  fail 'installed command list output does not match the catalog'
fi
"$installer" >"$fixture_root/repeat-install.out"
if ! cmp -s "$fixture_root/repeat-install.out" \
  <(printf 'Installed grx at %s\n' "$installed_command"); then
  fail 'repeated installer run was not idempotent'
fi
[ "$(path_mode "$(dirname "$installed_command")")" = '700' ] \
  || fail 'repeated install changed the pre-existing command directory mode'

install_preflight_sentinel="$HOME/.local/share/trellage/profiles/grok/hve/home/install-preflight-sentinel"
printf 'preserve installer preflight user data\n' >"$install_preflight_sentinel"

printf 'preserve unexpected reinstall root content\n' >"$runtime_root/unexpected-reinstall"
unexpected_reinstall_root_before="$(managed_install_state)"
if "$installer" >"$fixture_root/unexpected-reinstall-root.out" \
  2>"$fixture_root/unexpected-reinstall-root.err"; then
  fail 'installer accepted unexpected content in an owned runtime root'
fi
assert_line "grx install: refusing unexpected content in owned runtime: $runtime_root/unexpected-reinstall" \
  "$fixture_root/unexpected-reinstall-root.err"
[ "$(managed_install_state)" = "$unexpected_reinstall_root_before" ] \
  || fail 'installer mutated state before refusing unexpected runtime-root content'
assert_line 'preserve unexpected reinstall root content' "$runtime_root/unexpected-reinstall"
rm "$runtime_root/unexpected-reinstall"

printf 'preserve unexpected reinstall bin content\n' >"$runtime_root/bin/unexpected-reinstall"
unexpected_reinstall_bin_before="$(managed_install_state)"
if "$installer" >"$fixture_root/unexpected-reinstall-bin.out" \
  2>"$fixture_root/unexpected-reinstall-bin.err"; then
  fail 'installer accepted unexpected content in an owned runtime bin'
fi
assert_line "grx install: refusing unexpected content in owned runtime: $runtime_root/bin/unexpected-reinstall" \
  "$fixture_root/unexpected-reinstall-bin.err"
[ "$(managed_install_state)" = "$unexpected_reinstall_bin_before" ] \
  || fail 'installer mutated state before refusing unexpected runtime-bin content'
assert_line 'preserve unexpected reinstall bin content' "$runtime_root/bin/unexpected-reinstall"
rm "$runtime_root/bin/unexpected-reinstall"

mv "$installed_catalog" "$fixture_root/missing-reinstall-catalog"
missing_reinstall_catalog_before="$(managed_install_state)"
if "$installer" >"$fixture_root/missing-reinstall-catalog.out" \
  2>"$fixture_root/missing-reinstall-catalog.err"; then
  fail 'installer repaired a missing catalog instead of refusing partial owned state'
fi
assert_line "grx install: refusing incomplete owned runtime: $installed_catalog" \
  "$fixture_root/missing-reinstall-catalog.err"
[ "$(managed_install_state)" = "$missing_reinstall_catalog_before" ] \
  || fail 'installer mutated partial state before refusing a missing catalog'
mv "$fixture_root/missing-reinstall-catalog" "$installed_catalog"

chmod 0000 "$installed_launcher"
unreadable_reinstall_launcher_before="$(managed_install_state)"
if "$installer" >"$fixture_root/unreadable-reinstall-launcher.out" \
  2>"$fixture_root/unreadable-reinstall-launcher.err"; then
  fail 'installer replaced an unreadable launcher instead of refusing partial owned state'
fi
assert_line "grx install: refusing unreadable owned runtime file: $installed_launcher" \
  "$fixture_root/unreadable-reinstall-launcher.err"
[ "$(managed_install_state)" = "$unreadable_reinstall_launcher_before" ] \
  || fail 'installer mutated state before refusing an unreadable launcher'
chmod 0755 "$installed_launcher"
assert_line 'preserve installer preflight user data' "$install_preflight_sentinel"

uninstall_preflight_sentinel="$HOME/.local/share/trellage/profiles/grok/hve/home/uninstall-preflight-sentinel"
printf 'preserve uninstaller preflight user data\n' >"$uninstall_preflight_sentinel"

mv "$installed_launcher" "$fixture_root/marker-only-launcher"
mv "$installed_catalog" "$fixture_root/marker-only-catalog"
rmdir "$runtime_root/bin"
marker_only_before="$(partial_install_state)"
if "$uninstaller" >"$fixture_root/marker-only-uninstall.out" \
  2>"$fixture_root/marker-only-uninstall.err"; then
  fail 'uninstaller accepted a marker-only runtime root'
fi
assert_line "grx uninstall: refusing incomplete owned runtime: $runtime_root/bin" \
  "$fixture_root/marker-only-uninstall.err"
[ "$(partial_install_state)" = "$marker_only_before" ] \
  || fail 'uninstaller mutated marker-only state before refusing it'
mkdir -m 0755 "$runtime_root/bin"
mv "$fixture_root/marker-only-launcher" "$installed_launcher"
mv "$fixture_root/marker-only-catalog" "$installed_catalog"

mv "$installed_launcher" "$fixture_root/missing-bin-launcher"
rmdir "$runtime_root/bin"
missing_bin_before="$(partial_install_state)"
if "$uninstaller" >"$fixture_root/missing-bin-uninstall.out" \
  2>"$fixture_root/missing-bin-uninstall.err"; then
  fail 'uninstaller accepted an owned runtime with a missing bin directory'
fi
assert_line "grx uninstall: refusing incomplete owned runtime: $runtime_root/bin" \
  "$fixture_root/missing-bin-uninstall.err"
[ "$(partial_install_state)" = "$missing_bin_before" ] \
  || fail 'uninstaller mutated state before refusing a missing bin directory'
mkdir -m 0755 "$runtime_root/bin"
mv "$fixture_root/missing-bin-launcher" "$installed_launcher"

mv "$installed_launcher" "$fixture_root/missing-uninstall-launcher"
missing_uninstall_launcher_before="$(partial_install_state)"
if "$uninstaller" >"$fixture_root/missing-uninstall-launcher.out" \
  2>"$fixture_root/missing-uninstall-launcher.err"; then
  fail 'uninstaller accepted an owned runtime with a missing launcher'
fi
assert_line "grx uninstall: refusing incomplete owned runtime: $installed_launcher" \
  "$fixture_root/missing-uninstall-launcher.err"
[ "$(partial_install_state)" = "$missing_uninstall_launcher_before" ] \
  || fail 'uninstaller mutated state before refusing a missing launcher'
mv "$fixture_root/missing-uninstall-launcher" "$installed_launcher"

mv "$installed_catalog" "$fixture_root/missing-uninstall-catalog"
missing_uninstall_catalog_before="$(partial_install_state)"
if "$uninstaller" >"$fixture_root/missing-uninstall-catalog.out" \
  2>"$fixture_root/missing-uninstall-catalog.err"; then
  fail 'uninstaller accepted an owned runtime with a missing catalog'
fi
assert_line "grx uninstall: refusing incomplete owned runtime: $installed_catalog" \
  "$fixture_root/missing-uninstall-catalog.err"
[ "$(partial_install_state)" = "$missing_uninstall_catalog_before" ] \
  || fail 'uninstaller mutated state before refusing a missing catalog'
mv "$fixture_root/missing-uninstall-catalog" "$installed_catalog"

for unreadable_path in "$installed_launcher" "$installed_catalog"; do
  unreadable_name="$(basename "$unreadable_path")"
  unreadable_original_mode="$(path_mode "$unreadable_path")"
  chmod 0000 "$unreadable_path"
  unreadable_uninstall_before="$(partial_install_state)"
  if "$uninstaller" >"$fixture_root/unreadable-uninstall-$unreadable_name.out" \
    2>"$fixture_root/unreadable-uninstall-$unreadable_name.err"; then
    fail "uninstaller accepted unreadable owned runtime file: $unreadable_path"
  fi
  assert_line "grx uninstall: refusing unreadable owned runtime file: $unreadable_path" \
    "$fixture_root/unreadable-uninstall-$unreadable_name.err"
  [ "$(partial_install_state)" = "$unreadable_uninstall_before" ] \
    || fail "uninstaller mutated state before refusing unreadable file: $unreadable_path"
  chmod "$unreadable_original_mode" "$unreadable_path"
done

mv "$installed_command" "$fixture_root/missing-uninstall-command"
missing_uninstall_command_before="$(partial_install_state)"
if "$uninstaller" >"$fixture_root/missing-uninstall-command.out" \
  2>"$fixture_root/missing-uninstall-command.err"; then
  fail 'uninstaller accepted an owned runtime with a missing command link'
fi
assert_line "grx uninstall: refusing incomplete owned runtime: $installed_command" \
  "$fixture_root/missing-uninstall-command.err"
[ "$(partial_install_state)" = "$missing_uninstall_command_before" ] \
  || fail 'uninstaller mutated state before refusing a missing command link'
mv "$fixture_root/missing-uninstall-command" "$installed_command"

mv "$installed_command" "$fixture_root/expected-uninstall-command"
ln -s "$fixture_root/not-the-installed-launcher" "$installed_command"
mismatched_uninstall_command_before="$(partial_install_state)"
if "$uninstaller" >"$fixture_root/mismatched-uninstall-command.out" \
  2>"$fixture_root/mismatched-uninstall-command.err"; then
  fail 'uninstaller accepted a mismatched command link'
fi
assert_line "grx uninstall: refusing to remove unrelated command: $installed_command" \
  "$fixture_root/mismatched-uninstall-command.err"
[ "$(partial_install_state)" = "$mismatched_uninstall_command_before" ] \
  || fail 'uninstaller mutated state before refusing a mismatched command link'
rm "$installed_command"
mv "$fixture_root/expected-uninstall-command" "$installed_command"
assert_line 'preserve uninstaller preflight user data' "$uninstall_preflight_sentinel"

command_preflight_sentinel="$HOME/.local/share/trellage/profiles/grok/hve/home/command-preflight-sentinel"
printf 'preserve command preflight user data\n' >"$command_preflight_sentinel"
command_dir="$(dirname "$installed_command")"
command_dir_original_mode="$(path_mode "$command_dir")"
chmod 0500 "$command_dir"
command_preflight_state_before="$(managed_install_state)"
command_preflight_status=0
"$uninstaller" >"$fixture_root/command-preflight-uninstall.out" \
  2>"$fixture_root/command-preflight-uninstall.err" || command_preflight_status=$?
command_preflight_state_after='missing managed state'
if [ -d "$runtime_root" ] && [ -L "$installed_command" ]; then
  command_preflight_state_after="$(managed_install_state)"
fi
chmod "$command_dir_original_mode" "$command_dir"
[ "$command_preflight_status" -ne 0 ] \
  || fail 'uninstaller accepted a non-writable managed command directory'
assert_line "grx uninstall: refusing non-writable or non-searchable managed command directory: $command_dir" \
  "$fixture_root/command-preflight-uninstall.err"
[ "$command_preflight_state_after" = "$command_preflight_state_before" ] \
  || fail 'uninstaller mutated managed state before refusing unsafe command-directory permissions'
assert_line 'preserve command preflight user data' "$command_preflight_sentinel"

mkdir "$runtime_root/unexpected"
printf 'preserve unexpected content\n' >"$runtime_root/unexpected/keep"
unexpected_runtime_state_before="$(managed_install_state)"
if "$uninstaller" >"$fixture_root/unexpected-runtime-uninstall.out" \
  2>"$fixture_root/unexpected-runtime-uninstall.err"; then
  fail 'uninstaller accepted unexpected content in the owned runtime'
fi
assert_line "grx uninstall: refusing unexpected content in owned runtime: $runtime_root/unexpected" \
  "$fixture_root/unexpected-runtime-uninstall.err"
unexpected_runtime_state_after="$(managed_install_state)"
[ "$unexpected_runtime_state_after" = "$unexpected_runtime_state_before" ] \
  || fail 'uninstaller changed owned runtime before refusing unexpected content'
assert_line 'preserve unexpected content' "$runtime_root/unexpected/keep"
rm "$runtime_root/unexpected/keep"
rmdir "$runtime_root/unexpected"

printf 'preserve unexpected bin entry\n' >"$runtime_root/bin/unexpected"
unexpected_bin_state_before="$(managed_install_state)"
if "$uninstaller" >"$fixture_root/unexpected-bin-uninstall.out" \
  2>"$fixture_root/unexpected-bin-uninstall.err"; then
  fail 'uninstaller accepted unexpected content in the owned runtime bin'
fi
assert_line "grx uninstall: refusing unexpected content in owned runtime: $runtime_root/bin/unexpected" \
  "$fixture_root/unexpected-bin-uninstall.err"
unexpected_bin_state_after="$(managed_install_state)"
[ "$unexpected_bin_state_after" = "$unexpected_bin_state_before" ] \
  || fail 'uninstaller changed owned runtime before refusing unexpected bin content'
assert_line 'preserve unexpected bin entry' "$runtime_root/bin/unexpected"
rm "$runtime_root/bin/unexpected"

unreadable_root_unexpected="$runtime_root/unreadable-unexpected"
printf 'preserve unreadable root content\n' >"$unreadable_root_unexpected"
chmod 0300 "$runtime_root"
unreadable_root_state_before="$(uninstall_preservation_state \
  "$unreadable_root_unexpected")"
if "$uninstaller" >"$fixture_root/unreadable-root-uninstall.out" \
  2>"$fixture_root/unreadable-root-uninstall.err"; then
  fail 'uninstaller accepted an unreadable owned runtime root'
fi
assert_line "grx uninstall: refusing unreadable owned runtime directory: $runtime_root" \
  "$fixture_root/unreadable-root-uninstall.err"
unreadable_root_state_after="$(uninstall_preservation_state \
  "$unreadable_root_unexpected")"
[ "$unreadable_root_state_after" = "$unreadable_root_state_before" ] \
  || fail 'uninstaller changed state before refusing an unreadable runtime root'
assert_line 'preserve unreadable root content' "$unreadable_root_unexpected"
chmod 0755 "$runtime_root"
rm "$unreadable_root_unexpected"

unreadable_bin_unexpected="$runtime_root/bin/unreadable-unexpected"
printf 'preserve unreadable bin content\n' >"$unreadable_bin_unexpected"
chmod 0300 "$runtime_root/bin"
unreadable_bin_state_before="$(uninstall_preservation_state \
  "$unreadable_bin_unexpected")"
if "$uninstaller" >"$fixture_root/unreadable-bin-uninstall.out" \
  2>"$fixture_root/unreadable-bin-uninstall.err"; then
  fail 'uninstaller accepted an unreadable owned runtime bin'
fi
assert_line "grx uninstall: refusing unreadable owned runtime directory: $runtime_root/bin" \
  "$fixture_root/unreadable-bin-uninstall.err"
unreadable_bin_state_after="$(uninstall_preservation_state \
  "$unreadable_bin_unexpected")"
[ "$unreadable_bin_state_after" = "$unreadable_bin_state_before" ] \
  || fail 'uninstaller changed state before refusing an unreadable runtime bin'
assert_line 'preserve unreadable bin content' "$unreadable_bin_unexpected"
chmod 0755 "$runtime_root/bin"
rm "$unreadable_bin_unexpected"

printf '\n# preserve prior installed launcher\n' >>"$installed_launcher"
jq '.transactionSentinel = "preserve prior installed catalog"' \
  "$installed_catalog" >"$fixture_root/prior-installed-catalog.json"
mv "$fixture_root/prior-installed-catalog.json" "$installed_catalog"
chmod 0711 "$runtime_root"
chmod 0701 "$runtime_root/bin"
chmod 0744 "$installed_launcher"
chmod 0600 "$installed_catalog"
chmod 0600 "$runtime_root/.managed-by-trellage-grok-profiles"
chmod 0700 "$(dirname "$installed_command")"
prior_install_state="$(managed_install_state)"

installer_signal_cases='interrupt-after-old-launcher-stage interrupt-after-old-catalog-stage interrupt-after-old-marker-stage interrupt-after-old-command-stage terminate-after-new-launcher-publish terminate-after-new-catalog-publish terminate-after-new-marker-publish terminate-after-new-command-publish'
installer_signal_failures=''
for signal_case in $installer_signal_cases; do
  signal_home="$fixture_root/installer-$signal_case-home"
  mkdir "$signal_home"
  HOME="$signal_home" "$installer" >/dev/null
  signal_runtime="$signal_home/.local/share/trellage/grx"
  signal_launcher="$signal_runtime/bin/grx"
  signal_catalog="$signal_runtime/catalog.json"
  signal_marker="$signal_runtime/.managed-by-trellage-grok-profiles"
  signal_command="$signal_home/.local/bin/grx"
  printf '\n# preserve signal-window launcher\n' >>"$signal_launcher"
  jq '.signalWindowSentinel = "preserve signal-window catalog"' \
    "$signal_catalog" >"$fixture_root/$signal_case-catalog.json"
  mv "$fixture_root/$signal_case-catalog.json" "$signal_catalog"
  chmod 0711 "$signal_runtime"
  chmod 0701 "$signal_runtime/bin"
  chmod 0744 "$signal_launcher"
  chmod 0600 "$signal_catalog" "$signal_marker"
  chmod 0700 "$(dirname "$signal_command")"
  printf 'preserve installer signal user data\n' >"$signal_home/user-sentinel"
  signal_state_before="$(managed_paths_state "$signal_runtime" "$signal_command")"
  case "$signal_case" in
    interrupt-*) expected_signal_status=130 ;;
    terminate-*) expected_signal_status=143 ;;
  esac
  signal_status=0
  HOME="$signal_home" GRX_INSTALL_TEST_FAIL_AT="$signal_case" \
    "$installer" >"$fixture_root/$signal_case.out" \
    2>"$fixture_root/$signal_case.err" || signal_status=$?
  signal_state_after='missing managed state'
  if [ -d "$signal_runtime" ] && [ -L "$signal_command" ]; then
    signal_state_after="$(managed_paths_state "$signal_runtime" "$signal_command")"
  fi
  [ "$signal_status" -eq "$expected_signal_status" ] \
    || installer_signal_failures="$installer_signal_failures $signal_case:status-$signal_status"
  [ "$signal_state_after" = "$signal_state_before" ] \
    || installer_signal_failures="$installer_signal_failures $signal_case:state"
  [ -z "$(find "$(dirname "$signal_runtime")" -maxdepth 1 \
    -name '.grx-install.*' -print -quit)" ] \
    || installer_signal_failures="$installer_signal_failures $signal_case:runtime-staging"
  [ -z "$(find "$(dirname "$signal_command")" -maxdepth 1 \
    -name '.grx-command.*' -print -quit)" ] \
    || installer_signal_failures="$installer_signal_failures $signal_case:command-staging"
  if [ "$signal_state_after" = "$signal_state_before" ]; then
    "$signal_command" list >"$fixture_root/$signal_case-list.out"
    if ! cmp -s "$fixture_root/$signal_case-list.out" <(printf '%s\n' \
      $'hve\thve-core-all' \
      $'superpowers\tsuperpowers'); then
      installer_signal_failures="$installer_signal_failures $signal_case:command"
    fi
  fi
  assert_line 'preserve installer signal user data' "$signal_home/user-sentinel"
done
[ -z "$installer_signal_failures" ] \
  || fail "installer post-mutation signals were not recoverable:$installer_signal_failures"

signal_publish_status=0
GRX_INSTALL_TEST_FAIL_AT=signal-during-publish "$installer" \
  >"$fixture_root/signal-during-publish.out" \
  2>"$fixture_root/signal-during-publish.err" || signal_publish_status=$?
[ "$signal_publish_status" -eq 143 ] \
  || fail "TERM-interrupted installer exited $signal_publish_status instead of 143"
signal_publish_state="$(managed_install_state)"
[ "$signal_publish_state" = "$prior_install_state" ] \
  || fail 'TERM-interrupted publication did not restore the exact prior install'
[ -z "$(find "$(dirname "$runtime_root")" -maxdepth 1 \
  -name '.grx-install.*' -print -quit)" ] \
  || fail 'TERM-interrupted publication left runtime staging debris'
[ -z "$(find "$(dirname "$installed_command")" -maxdepth 1 \
  -name '.grx-command.*' -print -quit)" ] \
  || fail 'TERM-interrupted publication left command staging debris'
"$installed_command" list >"$fixture_root/signal-during-publish-list.out"
if ! cmp -s "$fixture_root/signal-during-publish-list.out" <(printf '%s\n' \
  $'hve\thve-core-all' \
  $'superpowers\tsuperpowers'); then
  fail 'TERM-interrupted publication left the prior command unusable'
fi

interrupt_publish_status=0
GRX_INSTALL_TEST_FAIL_AT=interrupt-during-publish "$installer" \
  >"$fixture_root/interrupt-during-publish.out" \
  2>"$fixture_root/interrupt-during-publish.err" || interrupt_publish_status=$?
[ "$interrupt_publish_status" -eq 130 ] \
  || fail "INT-interrupted installer exited $interrupt_publish_status instead of 130"
interrupt_publish_state="$(managed_install_state)"
[ "$interrupt_publish_state" = "$prior_install_state" ] \
  || fail 'INT-interrupted publication did not restore the exact prior install'
[ -z "$(find "$(dirname "$runtime_root")" -maxdepth 1 \
  -name '.grx-install.*' -print -quit)" ] \
  || fail 'INT-interrupted publication left runtime staging debris'
[ -z "$(find "$(dirname "$installed_command")" -maxdepth 1 \
  -name '.grx-command.*' -print -quit)" ] \
  || fail 'INT-interrupted publication left command staging debris'
"$installed_command" list >"$fixture_root/interrupt-during-publish-list.out"
if ! cmp -s "$fixture_root/interrupt-during-publish-list.out" <(printf '%s\n' \
  $'hve\thve-core-all' \
  $'superpowers\tsuperpowers'); then
  fail 'INT-interrupted publication left the prior command unusable'
fi

cleanup_failure_user_sentinel="$fixture_root/cleanup-failure-user-sentinel"
printf 'preserve user data\n' >"$cleanup_failure_user_sentinel"
cleanup_failure_status=0
GRX_INSTALL_TEST_FAIL_AT=signal-during-publish-cleanup-failure "$installer" \
  >"$fixture_root/signal-cleanup-failure.out" \
  2>"$fixture_root/signal-cleanup-failure.err" || cleanup_failure_status=$?
[ "$cleanup_failure_status" -eq 143 ] \
  || fail "cleanup-failed TERM installer exited $cleanup_failure_status instead of 143"
cleanup_failure_runtime_root="$(find "$(dirname "$runtime_root")" -maxdepth 1 \
  -type d -name '.grx-install.*' -print -quit)"
cleanup_failure_command_root="$(find "$(dirname "$installed_command")" -maxdepth 1 \
  -type d -name '.grx-command.*' -print -quit)"
[ -n "$cleanup_failure_runtime_root" ] \
  || fail 'cleanup-failed TERM did not preserve runtime recovery staging'
[ -n "$cleanup_failure_command_root" ] \
  || fail 'cleanup-failed TERM did not preserve command recovery staging'
assert_line "grx install: failed to clean installation staging; runtime recovery: $cleanup_failure_runtime_root; command recovery: $cleanup_failure_command_root" \
  "$fixture_root/signal-cleanup-failure.err"
[ -x "$cleanup_failure_runtime_root/new-launcher" ] \
  || fail 'cleanup-failed TERM lost the staged launcher recovery asset'
[ -f "$cleanup_failure_runtime_root/new-catalog" ] \
  || fail 'cleanup-failed TERM lost the staged catalog recovery asset'
[ -f "$cleanup_failure_runtime_root/new-marker" ] \
  || fail 'cleanup-failed TERM lost the staged ownership recovery asset'
[ -L "$cleanup_failure_command_root/new-command" ] \
  || fail 'cleanup-failed TERM lost the staged command recovery asset'
cleanup_failure_install_state="$(managed_install_state)"
[ "$cleanup_failure_install_state" = "$prior_install_state" ] \
  || fail 'cleanup-failed TERM did not restore the exact prior install'
"$installed_command" list >"$fixture_root/signal-cleanup-failure-list.out"
if ! cmp -s "$fixture_root/signal-cleanup-failure-list.out" <(printf '%s\n' \
  $'hve\thve-core-all' \
  $'superpowers\tsuperpowers'); then
  fail 'cleanup-failed TERM left the prior command unusable'
fi
assert_line 'preserve user data' "$cleanup_failure_user_sentinel"
rm -f \
  "$cleanup_failure_runtime_root/new-launcher" \
  "$cleanup_failure_runtime_root/new-catalog" \
  "$cleanup_failure_runtime_root/new-marker" \
  "$cleanup_failure_command_root/new-command"
rmdir "$cleanup_failure_runtime_root" "$cleanup_failure_command_root"

rollback_failure_status=0
GRX_INSTALL_TEST_FAIL_AT=signal-during-publish-rollback-failure "$installer" \
  >"$fixture_root/signal-rollback-failure.out" \
  2>"$fixture_root/signal-rollback-failure.err" || rollback_failure_status=$?
[ "$rollback_failure_status" -eq 143 ] \
  || fail "rollback-failed TERM installer exited $rollback_failure_status instead of 143"
runtime_recovery_root="$(find "$(dirname "$runtime_root")" -maxdepth 1 \
  -type d -name '.grx-install.*' -print -quit)"
command_recovery_root="$(find "$(dirname "$installed_command")" -maxdepth 1 \
  -type d -name '.grx-command.*' -print -quit)"
[ -n "$runtime_recovery_root" ] \
  || fail 'rollback-failed TERM did not preserve runtime recovery staging'
[ -n "$command_recovery_root" ] \
  || fail 'rollback-failed TERM did not preserve command recovery staging'
assert_line "grx install: rollback failed during interrupted publication; runtime recovery: $runtime_recovery_root; command recovery: $command_recovery_root" \
  "$fixture_root/signal-rollback-failure.err"
[ -x "$runtime_recovery_root/new-launcher" ] \
  || fail 'rollback-failed TERM lost the staged launcher recovery asset'
[ -f "$runtime_recovery_root/new-catalog" ] \
  || fail 'rollback-failed TERM lost the staged catalog recovery asset'
[ -f "$runtime_recovery_root/new-marker" ] \
  || fail 'rollback-failed TERM lost the staged ownership recovery asset'
[ -L "$command_recovery_root/new-command" ] \
  || fail 'rollback-failed TERM lost the staged command recovery asset'
rm -f \
  "$runtime_recovery_root/new-launcher" \
  "$runtime_recovery_root/new-catalog" \
  "$runtime_recovery_root/new-marker" \
  "$command_recovery_root/new-command"
rmdir "$runtime_recovery_root" "$command_recovery_root"

abnormal_publish_status=0
GRX_INSTALL_TEST_FAIL_AT=exit-during-publish "$installer" \
  >"$fixture_root/exit-during-publish.out" \
  2>"$fixture_root/exit-during-publish.err" || abnormal_publish_status=$?
[ "$abnormal_publish_status" -eq 71 ] \
  || fail "abnormally exiting installer exited $abnormal_publish_status instead of 71"
abnormal_publish_state="$(managed_install_state)"
[ "$abnormal_publish_state" = "$prior_install_state" ] \
  || fail 'abnormal publication exit did not restore the exact prior install'
[ -z "$(find "$(dirname "$runtime_root")" -maxdepth 1 \
  -name '.grx-install.*' -print -quit)" ] \
  || fail 'abnormal publication exit left runtime staging debris'
[ -z "$(find "$(dirname "$installed_command")" -maxdepth 1 \
  -name '.grx-command.*' -print -quit)" ] \
  || fail 'abnormal publication exit left command staging debris'

for failure_point in \
  after-staging \
  during-publish \
  after-launcher-publish \
  after-catalog-publish \
  after-marker-publish \
  after-command-publish \
  after-runtime-root-mode \
  after-runtime-bin-mode; do
  if GRX_INSTALL_TEST_FAIL_AT="$failure_point" "$installer" \
    >"$fixture_root/$failure_point.out" 2>"$fixture_root/$failure_point.err"; then
    fail "installer ignored the $failure_point failure injection"
  fi
  assert_contains "injected failure at $failure_point" "$fixture_root/$failure_point.err"
  current_install_state="$(managed_install_state)"
  [ "$current_install_state" = "$prior_install_state" ] \
    || fail "$failure_point failure did not restore the exact prior install"
  [ -z "$(find "$(dirname "$runtime_root")" -maxdepth 1 \
    -name '.grx-install.*' -print -quit)" ] \
    || fail "$failure_point failure left a runtime staging directory behind"
  [ -z "$(find "$(dirname "$installed_command")" -maxdepth 1 \
    -name '.grx-command.*' -print -quit)" ] \
    || fail "$failure_point failure left a command staging directory behind"
  "$installed_command" list >"$fixture_root/$failure_point-list.out"
  if ! cmp -s "$fixture_root/$failure_point-list.out" <(printf '%s\n' \
    $'hve\thve-core-all' \
    $'superpowers\tsuperpowers'); then
    fail "$failure_point failure left the prior installed command unusable"
  fi
done
"$installer" >/dev/null
[ "$(path_mode "$(dirname "$installed_command")")" = '700' ] \
  || fail 'reinstall changed the pre-existing command directory mode'

preserved_session="$HOME/.local/share/trellage/profiles/grok/hve/home/sessions/keep"
mkdir -p "$(dirname "$preserved_session")"
printf 'preserve\n' >"$preserved_session"

transaction_failure_points='after-launcher-remove after-catalog-remove after-marker-remove after-bin-remove after-root-remove after-command-remove'
transaction_baseline_failures=''
for failure_point in $transaction_failure_points; do
  transaction_home="$fixture_root/transaction-$failure_point-home"
  mkdir "$transaction_home"
  HOME="$transaction_home" "$installer" >/dev/null
  transaction_root="$transaction_home/.local/share/trellage/grx"
  transaction_command="$transaction_home/.local/bin/grx"
  transaction_sentinel="$transaction_home/user-sentinel"
  printf 'preserve transaction user data\n' >"$transaction_sentinel"
  transaction_state_before="$(managed_paths_state \
    "$transaction_root" "$transaction_command")"
  transaction_status=0
  HOME="$transaction_home" GRX_UNINSTALL_TEST_FAIL_AT="$failure_point" \
    "$uninstaller" >"$fixture_root/transaction-$failure_point.out" \
    2>"$fixture_root/transaction-$failure_point.err" || transaction_status=$?
  transaction_state_after='missing managed state'
  if [ -d "$transaction_root" ] && [ -L "$transaction_command" ]; then
    transaction_state_after="$(managed_paths_state \
      "$transaction_root" "$transaction_command")"
  fi
  if [ "$transaction_status" -eq 0 ]; then
    transaction_baseline_failures="$transaction_baseline_failures $failure_point:status"
  elif ! grep -Fxq -- \
    "grx uninstall: injected failure at $failure_point" \
    "$fixture_root/transaction-$failure_point.err"; then
    transaction_baseline_failures="$transaction_baseline_failures $failure_point:error"
  fi
  if [ "$transaction_state_after" != "$transaction_state_before" ]; then
    transaction_baseline_failures="$transaction_baseline_failures $failure_point:state"
  fi
  if ! grep -Fxq -- 'preserve transaction user data' "$transaction_sentinel"; then
    transaction_baseline_failures="$transaction_baseline_failures $failure_point:user-data"
  fi
  if [ -n "$(find "$(dirname "$transaction_root")" -maxdepth 1 \
    -name '.grx-uninstall.*' -print -quit)" ]; then
    transaction_baseline_failures="$transaction_baseline_failures $failure_point:runtime-staging"
  fi
  if [ -n "$(find "$(dirname "$transaction_command")" -maxdepth 1 \
    -name '.grx-uninstall-command.*' -print -quit)" ]; then
    transaction_baseline_failures="$transaction_baseline_failures $failure_point:command-staging"
  fi
  if [ "$transaction_status" -ne 0 ] \
    && [ "$transaction_state_after" = "$transaction_state_before" ]; then
    "$transaction_command" list >"$fixture_root/transaction-$failure_point-list.out"
    if ! cmp -s "$fixture_root/transaction-$failure_point-list.out" <(printf '%s\n' \
      $'hve\thve-core-all' \
      $'superpowers\tsuperpowers'); then
      transaction_baseline_failures="$transaction_baseline_failures $failure_point:command"
    fi
  fi
done
[ -z "$transaction_baseline_failures" ] \
  || fail "uninstaller transaction failures were not recoverable:$transaction_baseline_failures"

uninstall_signal_home="$fixture_root/uninstall-signal-home"
mkdir "$uninstall_signal_home"
HOME="$uninstall_signal_home" "$installer" >/dev/null
uninstall_signal_root="$uninstall_signal_home/.local/share/trellage/grx"
uninstall_signal_command="$uninstall_signal_home/.local/bin/grx"
uninstall_signal_before="$(managed_paths_state \
  "$uninstall_signal_root" "$uninstall_signal_command")"
uninstall_signal_status=0
HOME="$uninstall_signal_home" \
  GRX_UNINSTALL_TEST_FAIL_AT=interrupt-after-launcher-remove \
  "$uninstaller" >"$fixture_root/uninstall-signal.out" \
  2>"$fixture_root/uninstall-signal.err" || uninstall_signal_status=$?
[ "$uninstall_signal_status" -eq 130 ] \
  || fail "INT-interrupted uninstaller exited $uninstall_signal_status instead of 130"
[ "$(managed_paths_state "$uninstall_signal_root" "$uninstall_signal_command")" \
  = "$uninstall_signal_before" ] \
  || fail 'INT-interrupted uninstaller did not restore exact managed state'
[ -z "$(find "$(dirname "$uninstall_signal_root")" -maxdepth 1 \
  -name '.grx-uninstall.*' -print -quit)" ] \
  || fail 'INT-interrupted uninstaller left runtime staging debris'
[ -z "$(find "$(dirname "$uninstall_signal_command")" -maxdepth 1 \
  -name '.grx-uninstall-command.*' -print -quit)" ] \
  || fail 'INT-interrupted uninstaller left command staging debris'

rollback_failure_home="$fixture_root/uninstall-rollback-failure-home"
mkdir "$rollback_failure_home"
HOME="$rollback_failure_home" "$installer" >/dev/null
rollback_failure_root="$rollback_failure_home/.local/share/trellage/grx"
rollback_failure_command="$rollback_failure_home/.local/bin/grx"
printf 'preserve rollback-failure user data\n' >"$rollback_failure_home/user-sentinel"
uninstall_rollback_failure_status=0
HOME="$rollback_failure_home" \
  GRX_UNINSTALL_TEST_FAIL_AT=before-bin-remove-rollback-failure \
  "$uninstaller" >"$fixture_root/uninstall-rollback-failure.out" \
  2>"$fixture_root/uninstall-rollback-failure.err" \
  || uninstall_rollback_failure_status=$?
[ "$uninstall_rollback_failure_status" -ne 0 ] \
  || fail 'uninstaller ignored the rollback-failure injection'
uninstall_runtime_recovery="$(find "$(dirname "$rollback_failure_root")" \
  -maxdepth 1 -type d -name '.grx-uninstall.*' -print -quit)"
uninstall_command_recovery="$(find "$(dirname "$rollback_failure_command")" \
  -maxdepth 1 -type d -name '.grx-uninstall-command.*' -print -quit)"
[ -n "$uninstall_runtime_recovery" ] \
  || fail 'uninstall rollback failure did not preserve runtime recovery staging'
[ -n "$uninstall_command_recovery" ] \
  || fail 'uninstall rollback failure did not preserve command recovery staging'
assert_line "grx uninstall: rollback failed; runtime recovery: $uninstall_runtime_recovery; command recovery: $uninstall_command_recovery: injected failure at before-bin-remove" \
  "$fixture_root/uninstall-rollback-failure.err"
[ -f "$uninstall_runtime_recovery/launcher" ] \
  || fail 'uninstall rollback failure lost the launcher recovery asset'
[ -f "$uninstall_runtime_recovery/catalog" ] \
  || fail 'uninstall rollback failure lost the catalog recovery asset'
[ -f "$uninstall_runtime_recovery/marker" ] \
  || fail 'uninstall rollback failure lost the marker recovery asset'
assert_line 'preserve rollback-failure user data' \
  "$rollback_failure_home/user-sentinel"

uninstall_cleanup_home="$fixture_root/uninstall-cleanup-failure-home"
mkdir "$uninstall_cleanup_home"
HOME="$uninstall_cleanup_home" "$installer" >/dev/null
uninstall_cleanup_root="$uninstall_cleanup_home/.local/share/trellage/grx"
uninstall_cleanup_command="$uninstall_cleanup_home/.local/bin/grx"
printf 'preserve cleanup-failure user data\n' >"$uninstall_cleanup_home/user-sentinel"
uninstall_cleanup_status=0
HOME="$uninstall_cleanup_home" GRX_UNINSTALL_TEST_FAIL_AT=cleanup-failure \
  "$uninstaller" >"$fixture_root/uninstall-cleanup-failure.out" \
  2>"$fixture_root/uninstall-cleanup-failure.err" || uninstall_cleanup_status=$?
[ "$uninstall_cleanup_status" -ne 0 ] \
  || fail 'uninstaller ignored the cleanup-failure injection'
uninstall_cleanup_runtime_recovery="$(find "$(dirname "$uninstall_cleanup_root")" \
  -maxdepth 1 -type d -name '.grx-uninstall.*' -print -quit)"
uninstall_cleanup_command_recovery="$(find "$(dirname "$uninstall_cleanup_command")" \
  -maxdepth 1 -type d -name '.grx-uninstall-command.*' -print -quit)"
[ -n "$uninstall_cleanup_runtime_recovery" ] \
  || fail 'uninstall cleanup failure did not preserve runtime recovery staging'
[ -n "$uninstall_cleanup_command_recovery" ] \
  || fail 'uninstall cleanup failure did not preserve command recovery staging'
assert_line "grx uninstall: failed to clean uninstall staging; runtime recovery: $uninstall_cleanup_runtime_recovery; command recovery: $uninstall_cleanup_command_recovery" \
  "$fixture_root/uninstall-cleanup-failure.err"
[ -f "$uninstall_cleanup_runtime_recovery/launcher" ] \
  || fail 'uninstall cleanup failure lost the launcher recovery asset'
[ -f "$uninstall_cleanup_runtime_recovery/catalog" ] \
  || fail 'uninstall cleanup failure lost the catalog recovery asset'
[ -f "$uninstall_cleanup_runtime_recovery/marker" ] \
  || fail 'uninstall cleanup failure lost the marker recovery asset'
[ -L "$uninstall_cleanup_command_recovery/command" ] \
  || fail 'uninstall cleanup failure lost the command recovery asset'
[ ! -e "$uninstall_cleanup_root" ] && [ ! -L "$uninstall_cleanup_root" ] \
  || fail 'uninstall cleanup failure left a partial live runtime'
[ ! -e "$uninstall_cleanup_command" ] && [ ! -L "$uninstall_cleanup_command" ] \
  || fail 'uninstall cleanup failure left a partial live command'
assert_line 'preserve cleanup-failure user data' \
  "$uninstall_cleanup_home/user-sentinel"

"$uninstaller" >"$fixture_root/uninstall.out"
if ! cmp -s "$fixture_root/uninstall.out" \
  <(printf 'Uninstalled grx; profile homes were preserved.\n'); then
  fail 'uninstaller did not emit the exact uninstalled line'
fi
[ ! -e "$installed_command" ] && [ ! -L "$installed_command" ] \
  || fail 'uninstaller left the command behind'
[ ! -e "$runtime_root" ] && [ ! -L "$runtime_root" ] \
  || fail 'uninstaller left the owned runtime behind'
[ "$(path_mode "$(dirname "$installed_command")")" = '700' ] \
  || fail 'uninstaller changed the pre-existing command directory mode'
assert_line 'preserve' "$preserved_session"

"$uninstaller" >"$fixture_root/noop-uninstall.out"
if ! cmp -s "$fixture_root/noop-uninstall.out" \
  <(printf 'grx is not installed; profile homes were preserved.\n'); then
  fail 'absent uninstall did not emit the exact preserved-state line'
fi
assert_line 'preserve' "$preserved_session"

symlink_runtime_target="$fixture_root/unrelated-runtime-target"
mkdir -p "$symlink_runtime_target/bin"
printf 'symlink sentinel\n' >"$symlink_runtime_target/bin/grx"
ln -s "$symlink_runtime_target" "$runtime_root"
if "$installer" >"$fixture_root/symlink-runtime-install.out" \
  2>"$fixture_root/symlink-runtime-install.err"; then
  fail 'installer accepted a symlinked runtime root'
fi
assert_contains 'refusing unsafe symlinked runtime root' \
  "$fixture_root/symlink-runtime-install.err"
if "$uninstaller" >"$fixture_root/symlink-runtime-uninstall.out" \
  2>"$fixture_root/symlink-runtime-uninstall.err"; then
  fail 'uninstaller accepted a symlinked runtime root'
fi
assert_contains 'refusing unsafe symlinked runtime root' \
  "$fixture_root/symlink-runtime-uninstall.err"
assert_line 'symlink sentinel' "$symlink_runtime_target/bin/grx"
rm "$runtime_root"

printf 'trellage Grok profiles contract: PASS\n'
