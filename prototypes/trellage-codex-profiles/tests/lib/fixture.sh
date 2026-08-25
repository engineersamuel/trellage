# Shared machinery for the trellage Codex contract blocks.
#
# Sourced by tests/contract.sh and by each script under tests/blocks/. Defines
# only paths, helpers, and the per-block fixture root; every assertion lives in
# the block that owns it, so sourcing this file runs no tests.

contract_lib_dir="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(CDPATH= cd -- "$contract_lib_dir/../.." && pwd)"
adapter="$root/marketplaces/hve-core/.agents/plugins/marketplace.json"
catalog="$root/catalog.json"
launcher="$root/bin/cdx"

fail() {
  printf 'contract failed: %s\n' "$1" >&2
  exit 1
}

auth_is_absent() {
  [ ! -e "$1" ] && [ ! -L "$1" ]
}

# Resolved once so the per-file `file_mode`/`file_inode` probes, which run
# hundreds of times, do not each spawn `uname`.
host_system_name="$(uname -s 2>/dev/null || :)"

if (exit 23) | :; then
  fail 'contract pipefail sensitivity check did not observe upstream failure'
fi

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-cdx-contract.XXXXXX")" || {
  printf 'could not create contract fixture\n' >&2
  exit 1
}
case "$fixture_root" in
  "${TMPDIR:-/tmp}"/trellage-cdx-contract.*) ;;
  *) printf 'refusing unsafe fixture root: %s\n' "$fixture_root" >&2; exit 1 ;;
esac

tracked_async_pids=()
tracked_async_pid_count=0
tracked_async_groups=()
tracked_async_group_count=0

track_async_pid() {
  tracked_async_pids[$tracked_async_pid_count]="$1"
  tracked_async_pid_count=$((tracked_async_pid_count + 1))
}

track_async_group() {
  tracked_async_groups[$tracked_async_group_count]="$1"
  tracked_async_group_count=$((tracked_async_group_count + 1))
}

untrack_async_pid() {
  local target="$1" index=0
  while [ "$index" -lt "$tracked_async_pid_count" ]; do
    [ "${tracked_async_pids[$index]}" != "$target" ] \
      || tracked_async_pids[$index]=""
    index=$((index + 1))
  done
}

untrack_async_group() {
  local target="$1" index=0
  while [ "$index" -lt "$tracked_async_group_count" ]; do
    [ "${tracked_async_groups[$index]}" != "$target" ] \
      || tracked_async_groups[$index]=""
    index=$((index + 1))
  done
}

cleanup_tracked_async() {
  local index=0 target

  while [ "$index" -lt "$tracked_async_group_count" ]; do
    target="${tracked_async_groups[$index]}"
    [ -z "$target" ] || kill -TERM -- "-$target" 2>/dev/null || :
    index=$((index + 1))
  done
  index=0
  while [ "$index" -lt "$tracked_async_pid_count" ]; do
    target="${tracked_async_pids[$index]}"
    [ -z "$target" ] || kill -TERM "$target" 2>/dev/null || :
    index=$((index + 1))
  done
  sleep 0.1
  index=0
  while [ "$index" -lt "$tracked_async_group_count" ]; do
    target="${tracked_async_groups[$index]}"
    [ -z "$target" ] || kill -KILL -- "-$target" 2>/dev/null || :
    index=$((index + 1))
  done
  index=0
  while [ "$index" -lt "$tracked_async_pid_count" ]; do
    target="${tracked_async_pids[$index]}"
    if [ -n "$target" ]; then
      kill -KILL "$target" 2>/dev/null || :
      wait "$target" 2>/dev/null || :
    fi
    index=$((index + 1))
  done
  tracked_async_pids=("")
  tracked_async_pid_count=0
  tracked_async_groups=("")
  tracked_async_group_count=0
}

cleanup() {
  cleanup_tracked_async
  case "$fixture_root" in
    "${TMPDIR:-/tmp}"/trellage-cdx-contract.*) rm -rf -- "$fixture_root" ;;
    *) printf 'refusing unsafe fixture cleanup: %s\n' "$fixture_root" >&2; exit 1 ;;
  esac
}

trap cleanup EXIT HUP INT TERM

validate_adapter() {
  jq -se '
    length == 1
    and .[0] == {
      "name": "hve-core",
      "owner": {"name": "Trellage"},
      "plugins": [{
        "name": "hve-core-all",
        "source": {
          "source": "url",
          "url": "https://github.com/microsoft/hve-core.git",
          "ref": "main"
        },
        "version": "3.3.101",
        "skills": "./.github/skills"
      }]
    }
  ' "$1" >/dev/null
}

# Copies the launcher, catalog, and adapter into the fixture. Assignments here
# are deliberately global so callers see `fixture_launcher` and friends.
build_fixture_profiles() {
fixture_profiles="$fixture_root/profiles"
fixture_launcher="$fixture_profiles/bin/cdx"
fixture_catalog="$fixture_profiles/catalog.json"
fixture_adapter="$fixture_profiles/marketplaces/hve-core/.agents/plugins/marketplace.json"
mkdir -p "$(dirname "$fixture_launcher")" "$(dirname "$fixture_adapter")" "$fixture_root/home"
cp "$launcher" "$fixture_launcher"
cp "$catalog" "$fixture_catalog"
cp "$adapter" "$fixture_adapter"
mkdir -p "$fixture_root/common/engineersamuel-skills"
cp -R "$root/../../vendor/engineersamuel-skills/." \
  "$fixture_root/common/engineersamuel-skills/"
install -m 0755 "$root/../../scripts/sync-engineersamuel-skills.sh" \
  "$fixture_root/common/sync-engineersamuel-skills.sh"
chmod +x "$fixture_launcher"
}

# Writes the fake `codex` and `curl` stubs the blocks drive, and the `fake_env`
# wrapper that points the launcher at them.
write_fake_bin() {
fake_bin="$fixture_root/fake-bin"
fake_state="$fixture_root/fake-state"
fake_adapter_root="$(CDPATH= cd -P -- "${fixture_adapter%/.agents/plugins/marketplace.json}" && pwd -P)"
mkdir -p "$fake_bin" "$fake_state" "$fixture_root/home"
cat >"$fake_bin/codex" <<'EOF'
#!/usr/bin/env bash
set -u

if [ "${1-}" = '--version' ]; then
  printf 'codex-cli 0.146.0\n'
  exit 0
fi

profile="$(basename "$(dirname "$CODEX_HOME")")"
state="$FAKE_CODEX_STATE/$profile"
mkdir -p "$state"
jq -cn \
  --arg codexHome "$CODEX_HOME" \
  --arg home "$HOME" \
  --arg cwd "$PWD" \
  '$ARGS.named + {args: $ARGS.positional}' \
  --args -- "$@" >>"$FAKE_CODEX_LOG"

if [ "$*" = 'login status' ]; then
  [ "$CODEX_HOME" = "$HOME/.codex" ] || exit 94
  [ "${FAKE_CODEX_LOGIN_STATUS:-1}" = 0 ] || exit 1
  exit 0
fi

[ -f "$CODEX_HOME/config.toml" ] && [ ! -L "$CODEX_HOME/config.toml" ] || exit 91
[ -z "${FAKE_CODEX_SUCCESS_STDERR:-}" ] \
  || printf '%s\n' "$FAKE_CODEX_SUCCESS_STDERR" >&2

persist_marketplace_config() {
  local name="$1" source_type="$2" source="$3" staged

  staged="$CODEX_HOME/.fake-codex-config.$$"
  awk -v marker='# trellage-managed-codex-provider-end' \
    -v name="$name" -v source_type="$source_type" \
    -v source="$source" -v updated="${FAKE_CODEX_LAST_UPDATED:-2026-07-30T21:16:34Z}" '
    $0 == marker {
      print ""
      print "[marketplaces." name "]"
      print "last_updated = \"" updated "\""
      print "source_type = \"" source_type "\""
      print "source = \"" source "\""
    }
    { print }
  ' "$CODEX_HOME/config.toml" >"$staged" || exit 1
  mv "$staged" "$CODEX_HOME/config.toml" || exit 1
  chmod 0600 "$CODEX_HOME/config.toml" || exit 1
}

persist_plugin_config() {
  local plugin="$1" staged

  if grep -Fqx -- "[plugins.\"$plugin\"]" "$CODEX_HOME/config.toml"; then
    return 0
  fi
  staged="$CODEX_HOME/.fake-codex-config.$$"
  awk -v marker='# trellage-managed-codex-provider-end' -v plugin="$plugin" '
    $0 == marker {
      print ""
      print "[plugins.\"" plugin "\"]"
      print "enabled = true"
    }
    { print }
  ' "$CODEX_HOME/config.toml" >"$staged" || exit 1
  mv "$staged" "$CODEX_HOME/config.toml" || exit 1
  chmod 0600 "$CODEX_HOME/config.toml" || exit 1
}

remove_plugin_config() {
  local plugin="$1" staged

  staged="$CODEX_HOME/.fake-codex-config.$$"
  awk -v header="[plugins.\"$plugin\"]" '
    $0 == header { removing = 1; next }
    removing && $0 == "enabled = true" { removing = 0; next }
    { print }
  ' "$CODEX_HOME/config.toml" >"$staged" || exit 1
  mv "$staged" "$CODEX_HOME/config.toml" || exit 1
  chmod 0600 "$CODEX_HOME/config.toml" || exit 1
}

persist_marketplace_revision() {
  local marketplace="$1" revision="$2" staged

  staged="$CODEX_HOME/.fake-codex-config.$$"
  awk -v header="[marketplaces.$marketplace]" -v revision="$revision" '
    $0 == header { selected = 1; wrote = 0; print; next }
    selected && /^last_revision = / {
      print "last_revision = \"" revision "\""
      wrote = 1
      next
    }
    selected && ($0 ~ /^\[/ || $0 == "# trellage-managed-codex-provider-end") {
      if (!wrote) print "last_revision = \"" revision "\""
      selected = 0
    }
    { print }
  ' "$CODEX_HOME/config.toml" >"$staged" || exit 1
  mv "$staged" "$CODEX_HOME/config.toml" || exit 1
  chmod 0600 "$CODEX_HOME/config.toml" || exit 1
}

materialize_selected_plugin_cache() {
  local origin="$1"
  local cache_root="$CODEX_HOME/plugins/cache/superpowers-marketplace/superpowers/6.2.0"

  mkdir -p "$cache_root/.codex-plugin" "$cache_root/skills/core"
  printf '%s\n' \
    '{"name":"superpowers","version":"6.2.0","skills":"./skills/"}' \
    >"$cache_root/.codex-plugin/plugin.json"
  printf '%s\n' '# Superpowers core skill' \
    >"$cache_root/skills/core/SKILL.md"
  printf '%s\n' "$origin selected plugin cache materialized" \
    >"$cache_root/.fake-materialized-cache"
}

prime_git_marketplace() {
  local origin="$1"
  local marketplace_root="$CODEX_HOME/.tmp/marketplaces/superpowers-marketplace"
  local unrelated_cache="$CODEX_HOME/plugins/cache/superpowers-marketplace/unrelated/1.0.0"

  mkdir -p "$marketplace_root"
  printf '%s\n' "$origin marketplace revision materialized" \
    >"$marketplace_root/.fake-materialized-revision"
  if [ -f "$state/plugin" ]; then
    mkdir -p "$CODEX_HOME/plugins"
    printf '%s\n' "$origin selected plugin install metadata" \
      >"$CODEX_HOME/plugins/.fake-installed-superpowers"
    materialize_selected_plugin_cache "$origin marketplace-upgrade"
  fi
  if [ -f "$state/unrelated-same-marketplace" ]; then
    mkdir -p "$unrelated_cache"
    printf '%s\n' "$origin unrelated same-marketplace cache rematerialized" \
      >"$unrelated_cache/.fake-materialized-cache"
  fi
}

git_marketplace_is_materialized() {
  grep -E -- '^last_revision = "[0-9a-f]{40}"$' \
    "$CODEX_HOME/config.toml" >/dev/null 2>&1 || return 1
  [ -f "$CODEX_HOME/.tmp/marketplaces/superpowers-marketplace/.fake-materialized-revision" ] \
    || return 1
  if [ -f "$state/plugin" ]; then
    [ -f "$CODEX_HOME/plugins/.fake-installed-superpowers" ] || return 1
    [ -f "$CODEX_HOME/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache" ]
  fi
}

persist_project_trust() {
  local staged

  staged="$CODEX_HOME/.fake-codex-config.$$"
  awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$PWD" '
    $0 == marker {
      if (previous != "") print ""
      print "[projects.\"" cwd "\"]"
      print "trust_level = \"" ENVIRON["FAKE_CODEX_PROJECT_TRUST_VALUE"] "\""
      if (ENVIRON["FAKE_CODEX_PROJECT_EXTRA_FIELD"] != "")
        print ENVIRON["FAKE_CODEX_PROJECT_EXTRA_FIELD"]
      print ""
    }
    { print; previous = $0 }
  ' "$CODEX_HOME/config.toml" >"$staged" || exit 1
  mv "$staged" "$CODEX_HOME/config.toml" || exit 1
  chmod 0600 "$CODEX_HOME/config.toml" || exit 1
}

: "${FAKE_CODEX_PROJECT_TRUST_VALUE:=trusted}"
export FAKE_CODEX_PROJECT_TRUST_VALUE

case "${FAKE_CODEX_SIGNAL_PARENT:-}" in
  HUP|INT|TERM)
    if [ "${1:-}" = '--sandbox' ] \
      && [ "${FAKE_CODEX_APPEND_PROJECT_TRUST:-}" = 1 ]; then
      persist_project_trust
    fi
    kill -s "$FAKE_CODEX_SIGNAL_PARENT" "$PPID"
    exit 90
    ;;
esac

# Optional hold for lifecycle inventory/mutation calls. Launch path uses
# FAKE_CODEX_OVERLAP_DIR instead so prepare-time inventory cannot wedge the
# short profile lock while a session is meant to run unlocked.
if [ -n "${FAKE_CODEX_LIFECYCLE_HOLD_DIR:-}" ]; then
  mkdir -p "$FAKE_CODEX_LIFECYCLE_HOLD_DIR"
  if mkdir "$FAKE_CODEX_LIFECYCLE_HOLD_DIR/first" 2>/dev/null; then
    printf '%s\n' "$$" >"$FAKE_CODEX_LIFECYCLE_HOLD_DIR/first-child.pid"
    : >"$FAKE_CODEX_LIFECYCLE_HOLD_DIR/first-started"
    while [ ! -f "$FAKE_CODEX_LIFECYCLE_HOLD_DIR/release-first" ]; do
      sleep 0.05
    done
  else
    printf '%s\n' "$$" >"$FAKE_CODEX_LIFECYCLE_HOLD_DIR/second-child.pid"
    : >"$FAKE_CODEX_LIFECYCLE_HOLD_DIR/second-started"
  fi
fi

case "$*" in
  'plugin marketplace list --json')
    if [ -f "$FAKE_CODEX_MARKETPLACE_OVERRIDE" ]; then
      cat "$FAKE_CODEX_MARKETPLACE_OVERRIDE"
    elif [ -f "$state/marketplace" ]; then
      if [ "$profile" = hve ]; then
        jq -cn --arg root "$FAKE_HVE_ADAPTER_ROOT" '{marketplaces:[{name:"hve-core",root:$root,marketplaceSource:{sourceType:"local",source:$root}}]}'
      else
        jq -cn --arg root "$CODEX_HOME/.tmp/marketplaces/superpowers-marketplace" '{marketplaces:[{name:"superpowers-marketplace",root:$root,marketplaceSource:{sourceType:"git",source:"https://github.com/obra/superpowers-marketplace.git"}}]}'
      fi
    else
      printf '%s\n' '{"marketplaces":[]}'
    fi
    if [ "${FAKE_CODEX_REMOVE_CONFIG_AFTER_MARKETPLACE:-}" = 1 ]; then
      rm -f "$CODEX_HOME/config.toml"
    fi
    ;;
  plugin\ marketplace\ add\ *\ --json)
    [ "${FAKE_CODEX_FAIL_MUTATION:-}" != 'marketplace-add' ] || exit 71
    : >"$state/marketplace"
    if [ "$profile" = hve ]; then
      persist_marketplace_config hve-core local "$FAKE_HVE_ADAPTER_ROOT"
    else
      mkdir -p "$CODEX_HOME/.tmp/marketplaces/superpowers-marketplace"
      persist_marketplace_config superpowers-marketplace git \
        'https://github.com/obra/superpowers-marketplace.git'
    fi
    printf '%s\n' '{"alreadyAdded":false}'
    ;;
  'plugin list --json')
    if [ -f "$FAKE_CODEX_PLUGIN_OVERRIDE" ]; then
      cat "$FAKE_CODEX_PLUGIN_OVERRIDE"
      [ "${FAKE_CODEX_PLUGIN_OVERRIDE_ONCE:-}" != 1 ] || rm -f "$FAKE_CODEX_PLUGIN_OVERRIDE"
    elif [ "$profile" = hve ] && [ -f "$state/plugin" ]; then
      jq -cn --arg root "$FAKE_HVE_ADAPTER_ROOT" \
        --argjson forbidden "$([ -f "$state/forbidden-superpowers" ] && printf true || printf false)" \
        --argjson direct "$([ -f "$state/forbidden-superpowers-direct" ] && printf true || printf false)" \
        --argjson renamed "$([ -f "$state/forbidden-superpowers-renamed" ] && printf true || printf false)" \
        '{installed:([{pluginId:"hve-core-all@hve-core",name:"hve-core-all",marketplaceName:"hve-core",version:"3.3.101",installed:true,enabled:true,source:{source:"git",url:"https://github.com/microsoft/hve-core.git",ref:"main"},marketplaceSource:{sourceType:"local",source:$root},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}]
          + (if $forbidden then [{pluginId:"superpowers@openai-curated",name:"superpowers",marketplaceName:"openai-curated",version:"6.2.0",installed:true,enabled:true,source:{source:"git",url:"https://github.com/obra/superpowers.git"},marketplaceSource:{sourceType:"git",source:"openai/plugins"},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}] else [] end)
          + (if $direct then [{pluginId:"superpowers",name:"superpowers",marketplaceName:null,version:"6.2.0",installed:true,enabled:false,source:{source:"git",url:"obra/superpowers"},marketplaceSource:null,installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}] else [] end)
          + (if $renamed then [{pluginId:"workflow-kit@custom",name:"workflow-kit",marketplaceName:"custom",version:"6.2.0",installed:true,enabled:false,source:{source:"git",url:"git@github.com:obra/superpowers.git"},marketplaceSource:{sourceType:"git",source:"custom/plugins"},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}] else [] end)),available:[]}'
    elif [ "$profile" = superpowers ] \
      && { [ -f "$state/plugin" ] || [ -f "$state/unrelated-same-marketplace" ]; }; then
      if [ -f "$state/plugin" ] && [ -f "$state/unrelated-same-marketplace" ]; then
        jq -cn '{installed:[{pluginId:"superpowers@superpowers-marketplace",name:"superpowers",marketplaceName:"superpowers-marketplace",version:"6.2.0",installed:true,enabled:true,source:{source:"git",url:"https://github.com/obra/superpowers.git"},marketplaceSource:{sourceType:"git",source:"https://github.com/obra/superpowers-marketplace.git"},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"},{pluginId:"unrelated@superpowers-marketplace",name:"unrelated",marketplaceName:"superpowers-marketplace",version:"1.0.0",installed:true,enabled:true,source:{source:"git",url:"https://example.com/unrelated.git"},marketplaceSource:{sourceType:"git",source:"https://github.com/obra/superpowers-marketplace.git"},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}],available:[]}'
      elif [ -f "$state/plugin" ]; then
        jq -cn '{installed:[{pluginId:"superpowers@superpowers-marketplace",name:"superpowers",marketplaceName:"superpowers-marketplace",version:"6.2.0",installed:true,enabled:true,source:{source:"git",url:"https://github.com/obra/superpowers.git"},marketplaceSource:{sourceType:"git",source:"https://github.com/obra/superpowers-marketplace.git"},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}],available:[]}'
      else
        jq -cn '{installed:[{pluginId:"unrelated@superpowers-marketplace",name:"unrelated",marketplaceName:"superpowers-marketplace",version:"1.0.0",installed:true,enabled:true,source:{source:"git",url:"https://example.com/unrelated.git"},marketplaceSource:{sourceType:"git",source:"https://github.com/obra/superpowers-marketplace.git"},installPolicy:"AVAILABLE",authPolicy:"ON_INSTALL"}],available:[]}'
      fi
    else
      printf '%s\n' '{"installed":[],"available":[]}'
    fi
    if [ -n "${FAKE_CODEX_ARM_ADAPTER_SWAP:-}" ]; then
      : >"$FAKE_CODEX_ARM_ADAPTER_SWAP"
    fi
    ;;
  'mcp list --json')
    jq -cn '[{name:"docs",enabled:true},{name:"disabled",enabled:false}]'
    ;;
  'debug prompt-input inventory')
    jq -cn '[{role:"user",content:[{type:"input_text",text:"### Available skills\n- alpha: First (file: r0/alpha/SKILL.md)\n- beta: Second (file: r1/beta/SKILL.md)\n- Not a skill: explanatory bullet\n### Instructions\nStatic inventory"}]}]'
    ;;
  plugin\ add\ *\ --json)
    if [ "${FAKE_CODEX_FAIL_MUTATION:-}" = 'plugin-add' ]; then
      printf '%s\n' 'native plugin add failed: simulated Codex diagnostic' >&2
      exit 72
    fi
    : >"$state/plugin"
    persist_plugin_config "${3:-}"
    if [ "$profile" = superpowers ]; then
      mkdir -p "$CODEX_HOME/plugins"
      printf '%s\n' 'plugin-add selected plugin install metadata' \
        >"$CODEX_HOME/plugins/.fake-installed-superpowers"
      materialize_selected_plugin_cache plugin-add
    fi
    printf '%s\n' '{"installed":true}'
    ;;
  plugin\ remove\ *\ --json)
    [ "${FAKE_CODEX_FAIL_MUTATION:-}" != 'plugin-remove' ] || exit 73
    case "${3:-}" in
      superpowers@openai-curated) rm -f "$state/forbidden-superpowers" ;;
      superpowers) rm -f "$state/forbidden-superpowers-direct" ;;
      workflow-kit@custom) rm -f "$state/forbidden-superpowers-renamed" ;;
      *) rm -f "$state/plugin" ;;
    esac
    if [ "$profile" = superpowers ]; then
      rm -rf "$CODEX_HOME/plugins/cache/superpowers-marketplace/superpowers/6.2.0"
    fi
    remove_plugin_config "${3:-}"
    printf '%s\n' '{"removed":true}'
    ;;
  plugin\ marketplace\ upgrade\ *\ --json)
    [ "${FAKE_CODEX_FAIL_MUTATION:-}" != 'marketplace-upgrade' ] || exit 74
    : >"$state/marketplace"
    if [ "$profile" = superpowers ]; then
      mkdir -p "$CODEX_HOME/.tmp/marketplaces/superpowers-marketplace"
      persist_marketplace_revision superpowers-marketplace \
        "${FAKE_CODEX_MARKETPLACE_REVISION:-0123456789abcdef0123456789abcdef01234567}"
      prime_git_marketplace upgrade
    fi
    printf '%s\n' '{"upgraded":true}'
    ;;
  *)
    if [ "${1:-}" = '--sandbox' ] \
      && [ "${FAKE_CODEX_APPEND_PROJECT_TRUST:-}" = 1 ]; then
      fake_project_append_count="${FAKE_CODEX_APPEND_PROJECT_TRUST_COUNT:-1}"
      [ "${FAKE_CODEX_APPEND_PROJECT_TRUST_TWICE:-}" != 1 ] \
        || fake_project_append_count=2
      fake_project_append_index=0
      while [ "$fake_project_append_index" -lt "$fake_project_append_count" ]; do
        persist_project_trust
        fake_project_append_index=$((fake_project_append_index + 1))
      done
      [ -z "${FAKE_CODEX_CAPTURE_PROJECT_CONFIG:-}" ] \
        || cp "$CODEX_HOME/config.toml" "$FAKE_CODEX_CAPTURE_PROJECT_CONFIG"
    fi
    # Simulate Codex session-live native writes that must not fail cleanup.
    if [ "${1:-}" = '--sandbox' ] && [ "${FAKE_CODEX_BUMP_TUI_NUX:-}" = 1 ]; then
      staged="$CODEX_HOME/.fake-codex-config-nux.$$"
      awk -v marker='# trellage-managed-codex-provider-end' '
        $0 == marker {
          if (!seen_nux) {
            if (previous != "") print ""
            print "[tui.model_availability_nux]"
            print "\"gpt-5.6-sol\" = 2"
            print ""
          }
        }
        $0 == "[tui.model_availability_nux]" { seen_nux = 1; in_nux = 1; print; next }
        in_nux && /^\[/ { in_nux = 0 }
        in_nux && $0 ~ /^"gpt-5\.6-sol" = / {
          print "\"gpt-5.6-sol\" = 2"
          next
        }
        { print; previous = $0 }
      ' "$CODEX_HOME/config.toml" >"$staged" || exit 1
      mv "$staged" "$CODEX_HOME/config.toml" || exit 1
      chmod 0600 "$CODEX_HOME/config.toml" || exit 1
    fi
    [ -z "${FAKE_CODEX_ARM_CLEANUP_RACE:-}" ] \
      || : >"$FAKE_CODEX_ARM_CLEANUP_RACE"
    if [ -n "${FAKE_CODEX_TREE_DIR:-}" ]; then
      mkdir -p "$FAKE_CODEX_TREE_DIR"
      printf '%s\n' "$$" >"$FAKE_CODEX_TREE_DIR/child.pid"
      if [ "${FAKE_CODEX_WAIT_SECOND_SIGNAL:-}" = 1 ]; then
        fake_tree_signal_count=0
        fake_tree_signal() {
          fake_tree_signal_count=$((fake_tree_signal_count + 1))
          : >"$FAKE_CODEX_TREE_DIR/child-signal-$fake_tree_signal_count"
          [ "$fake_tree_signal_count" -lt 2 ] || {
            sleep 0.5
            : >"$FAKE_CODEX_TREE_DIR/child-exited"
            exit 0
          }
        }
        trap fake_tree_signal HUP INT TERM
      else
        trap 'printf "%s\n" child >"$FAKE_CODEX_TREE_DIR/child-signaled"; exit 0' \
          HUP INT TERM
      fi
      perl -e '
        use strict;
        use warnings;
        my $dir = $ENV{"FAKE_CODEX_TREE_DIR"};
        my $wait_second = ($ENV{"FAKE_CODEX_WAIT_SECOND_SIGNAL"} // "") eq "1";
        my $count = 0;
        my $finish = sub {
          $count++;
          if ($wait_second && $count < 2) {
            return;
          }
          open my $output, ">", "$dir/grandchild-signaled" or exit 1;
          print {$output} "grandchild\n";
          close $output;
          exit 0;
        };
        $SIG{"HUP"} = $finish;
        $SIG{"INT"} = $finish;
        $SIG{"TERM"} = $finish;
        sleep 1 while 1;
      ' &
      fake_grandchild_pid=$!
      printf '%s\n' "$fake_grandchild_pid" >"$FAKE_CODEX_TREE_DIR/grandchild.pid"
      : >"$FAKE_CODEX_TREE_DIR/ready"
      while :; do sleep 1; done
    fi
    if [ -n "${FAKE_CODEX_OVERLAP_DIR:-}" ]; then
      mkdir -p "$FAKE_CODEX_OVERLAP_DIR"
      if mkdir "$FAKE_CODEX_OVERLAP_DIR/first" 2>/dev/null; then
        printf '%s\n' "$$" >"$FAKE_CODEX_OVERLAP_DIR/first-child.pid"
        : >"$FAKE_CODEX_OVERLAP_DIR/first-started"
        while [ ! -f "$FAKE_CODEX_OVERLAP_DIR/release-first" ]; do
          sleep 0.05
        done
      else
        printf '%s\n' "$$" >"$FAKE_CODEX_OVERLAP_DIR/second-child.pid"
        : >"$FAKE_CODEX_OVERLAP_DIR/second-started"
      fi
    fi
    if [ -n "${FAKE_CODEX_TAKEOVER_DIR:-}" ]; then
      : >"$FAKE_CODEX_TAKEOVER_DIR/child-started"
    fi
    if [ -n "${FAKE_CODEX_RELEASE_RACE_DIR:-}" ]; then
      : >"$FAKE_CODEX_RELEASE_RACE_DIR/child-started"
    fi
    if [ "$profile" = superpowers ] \
      && [ "${1:-}" = '--sandbox' ]; then
      # Skip the fixed cdx-injected launch flags (--sandbox <mode>, repeatable
      # -c <value>, --ask-for-approval <value>, --disable <value>,
      # --dangerously-bypass-hook-trust with no value) to find the first
      # actual user-supplied argument, regardless of how many -c overrides
      # cdx currently injects ahead of it.
      launch_action=''
      while [ $# -gt 0 ]; do
        case "$1" in
          --sandbox|-c|--ask-for-approval|--disable) shift 2 ;;
          --dangerously-bypass-hook-trust) shift 1 ;;
          *) launch_action="$1"; break ;;
        esac
      done
      case "$launch_action" in
        debug|--*) ;;
        *)
          if ! git_marketplace_is_materialized; then
            persist_marketplace_revision superpowers-marketplace \
              '0123456789abcdef0123456789abcdef01234567'
            prime_git_marketplace app-startup
          fi
          ;;
      esac
    fi
    if [ "${FAKE_CODEX_TTY_READ:-}" = 1 ]; then
      printf 'TTY_READ_READY\n'
      IFS= read -r tty_input
      [ "$tty_input" = continue ] || exit 89
      printf 'TTY_READ_DONE\n'
    fi
    exit "${FAKE_CODEX_EXIT_STATUS:-0}"
    ;;
esac
EOF
chmod +x "$fake_bin/codex"
cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >>"$FAKE_CURL_LOG"
[ "$#" -eq 2 ] && [ "$1" = '-fsSL' ] || exit 81
if [ -f "${FAKE_CURL_OVERRIDE:-/nonexistent}" ]; then
  cat "$FAKE_CURL_OVERRIDE"
  exit 0
fi
case "$2" in
  https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json)
    jq -cn --arg version "${FAKE_HVE_AVAILABLE_VERSION:-3.3.101}" '{plugins:[{name:"hve-core-all",version:$version}]}' ;;
  https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json)
    jq -cn --arg version "${FAKE_SUPERPOWERS_AVAILABLE_VERSION:-6.2.0}" '{plugins:[{name:"superpowers",version:$version}]}' ;;
  *) exit 82 ;;
esac
EOF
chmod +x "$fake_bin/curl"

fake_env() {
  env PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    FAKE_CODEX_STATE="$fake_state" \
    FAKE_HVE_ADAPTER_ROOT="$fake_adapter_root" \
    FAKE_CODEX_MARKETPLACE_OVERRIDE="${FAKE_CODEX_MARKETPLACE_OVERRIDE:-$fixture_root/no-marketplace-override}" \
    FAKE_CODEX_PLUGIN_OVERRIDE="${FAKE_CODEX_PLUGIN_OVERRIDE:-$fixture_root/no-plugin-override}" \
    "$@"
}
export FAKE_CODEX_STATE="$fake_state"
export FAKE_HVE_ADAPTER_ROOT="$fake_adapter_root"
export FAKE_CODEX_MARKETPLACE_OVERRIDE="$fixture_root/no-marketplace-override"
export FAKE_CODEX_PLUGIN_OVERRIDE="$fixture_root/no-plugin-override"
export FAKE_CURL_LOG="$fixture_root/fake-curl.log"
export FAKE_CURL_OVERRIDE="$fixture_root/no-curl-override"
}

# Generic status and file-probe helpers shared by every block.
assert_early_status() {
  local expected="$1" label="$2" status=0
  shift 2
  "$@" >"$fixture_root/$label.out" 2>&1 || status=$?
  [ "$status" -eq "$expected" ] \
    || fail "$label exit was $status, expected $expected"
}

file_mode() {
  local value

  case "$host_system_name" in
    Darwin) value="$(stat -f '%Lp' "$1" 2>/dev/null)" || return 1 ;;
    Linux) value="$(stat -c '%a' "$1" 2>/dev/null)" || return 1 ;;
    *) return 1 ;;
  esac
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$value"
}

file_inode() {
  local value

  case "$host_system_name" in
    Darwin) value="$(stat -f '%i' "$1" 2>/dev/null)" || return 1 ;;
    Linux) value="$(stat -c '%i' "$1" 2>/dev/null)" || return 1 ;;
    *) return 1 ;;
  esac
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$value"
}

assert_command_fails() {
  local label="$1"
  shift
  if "$@" >"$fixture_root/$label.out" 2>&1; then
    fail "$label unexpectedly succeeded"
  else
    asserted_failure_status=$?
  fi
}

state_sha256() {
  local digest

  if command -v shasum >/dev/null 2>&1; then
    digest="$(shasum -a 256)" || return 1
  else
    digest="$(sha256sum)" || return 1
  fi
  printf '%s\n' "${digest%% *}"
}

state_file_hash() {
  if [ -f "$1" ] && [ ! -L "$1" ]; then
    state_sha256 <"$1"
  else
    printf '%s\n' missing
  fi
}

state_mcp_hash() {
  local config="$1"

  if [ ! -f "$config" ] || [ -L "$config" ]; then
    printf '%s\n' missing
    return
  fi
  sed -n \
    '/^# trellage-profile-local-config-begin$/,/^# trellage-profile-local-config-end$/p' \
    "$config" | state_sha256
}

# jq defs for launch-arg assertions. Launch injects one ephemeral
# -c projects={...trust_level...} override (cwd, git toplevel, main root).
strip_project_trust_c_jq() {
  cat <<'EOF'
def is_project_trust_override:
  type == "string" and (
    test("^projects\\..*\\.trust_level=\"trusted\"$")
    or test("^projects=\\{.*trust_level=\"trusted\".*\\}$")
  );
def strip_project_trust_c:
  . as $args
  | reduce range(0; $args|length) as $i ([];
      if $i > 0
        and $args[$i - 1] == "-c"
        and ($args[$i] | is_project_trust_override)
      then .
      elif $args[$i] == "-c"
        and (($i + 1) < ($args|length))
        and ($args[$i + 1] | is_project_trust_override)
      then .
      else . + [$args[$i]]
      end);
EOF
}
