#!/usr/bin/env bash

set -u
set -o pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
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

validate_adapter "$adapter" || fail 'adapter contract failed'

multiple_adapter="$fixture_root/multiple-adapter.json"
printf '{}\n' >"$multiple_adapter"
cat "$adapter" >>"$multiple_adapter"
if validate_adapter "$multiple_adapter"; then
  fail 'adapter validator accepted multiple JSON documents'
fi

jq -e '
  .schemaVersion == 1
  and (.profiles | keys | sort) == ["hve", "superpowers"]
  and .profiles.hve.description == "Codex CLI with HVE Core’s portable skill inventory for RPI evidence and specialist engineering workflows, defaulting to proxy-backed gpt-5.6-sol with unrestricted host access."
  and .profiles.hve.marketplaceKind == "local-adapter"
  and .profiles.hve.marketplaceSource == "marketplaces/hve-core"
  and .profiles.hve.marketplaceName == "hve-core"
  and .profiles.hve.upstreamRepository == "https://github.com/microsoft/hve-core.git"
  and .profiles.hve.upstreamSkillsPath == ".github/skills"
  and .profiles.hve.manifestUrl == "https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json"
  and .profiles.hve.plugin == "hve-core-all@hve-core"
  and .profiles.hve.standaloneMcps == []
  and .profiles.superpowers.description == "Codex CLI with Superpowers’ Codex-adapted design, plan, TDD, debugging, multi-agent review, verification, and branch-finishing workflow."
  and .profiles.superpowers.marketplaceKind == "git"
  and .profiles.superpowers.marketplaceSource == "obra/superpowers-marketplace"
  and .profiles.superpowers.marketplaceName == "superpowers-marketplace"
  and .profiles.superpowers.manifestUrl == "https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json"
  and .profiles.superpowers.plugin == "superpowers@superpowers-marketplace"
  and .profiles.superpowers.standaloneMcps == []
' "$catalog" >/dev/null || fail 'catalog contract failed'

fixture_profiles="$fixture_root/profiles"
fixture_launcher="$fixture_profiles/bin/cdx"
fixture_catalog="$fixture_profiles/catalog.json"
fixture_adapter="$fixture_profiles/marketplaces/hve-core/.agents/plugins/marketplace.json"
mkdir -p "$(dirname "$fixture_launcher")" "$(dirname "$fixture_adapter")" "$fixture_root/home"
cp "$launcher" "$fixture_launcher"
cp "$catalog" "$fixture_catalog"
cp "$adapter" "$fixture_adapter"
chmod +x "$fixture_launcher"

HOME="$fixture_root/home" "$fixture_launcher" list >"$fixture_root/list.out" || fail 'list failed'
cmp -s "$fixture_root/list.out" <(printf '%s\n' \
  $'hve\thve-core-all@hve-core' \
  $'superpowers\tsuperpowers@superpowers-marketplace') \
  || fail 'list output differs'

HOME="$fixture_root/home" "$fixture_launcher" list --json >"$fixture_root/list.json" \
  || fail 'JSON list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "cdx"
  and .harness == "codex"
  and [.profiles[].name] == ["hve", "superpowers"]
  and all(.profiles[]; (.description | type == "string" and length > 0))
  and .profiles[0].plugin == "hve-core-all@hve-core"
  and .profiles[0].source == null
  and .profiles[0].marketplace == {
    "kind": "local-adapter",
    "source": "marketplaces/hve-core",
    "name": "hve-core",
    "manifestUrl": "https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json"
  }
  and .profiles[0].standaloneMcps == []
  and .profiles[1].marketplace.kind == "git"
  and .profiles[1].standaloneMcps == []
' "$fixture_root/list.json" >/dev/null || fail 'JSON list output differs'

if HOME="$fixture_root/home" "$fixture_launcher" >"$fixture_root/bare.out" 2>&1; then
  fail 'bare cdx unexpectedly succeeded'
else
  status=$?
  [ "$status" -eq 2 ] || fail "bare cdx exit was $status, expected 2"
fi

fake_bin="$fixture_root/fake-bin"
fake_state="$fixture_root/fake-state"
fake_adapter_root="$(CDPATH= cd -P -- "${fixture_adapter%/.agents/plugins/marketplace.json}" && pwd -P)"
mkdir -p "$fake_bin" "$fake_state" "$fixture_root/home"
cat >"$fake_bin/codex" <<'EOF'
#!/usr/bin/env bash
set -u

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
    if [ "${1:-}" = '--dangerously-bypass-approvals-and-sandbox' ] \
      && [ "${FAKE_CODEX_APPEND_PROJECT_TRUST:-}" = 1 ]; then
      persist_project_trust
    fi
    kill -s "$FAKE_CODEX_SIGNAL_PARENT" "$PPID"
    exit 90
    ;;
esac

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
    if [ "${1:-}" = '--dangerously-bypass-approvals-and-sandbox' ] \
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
      && [ "${1:-}" = '--dangerously-bypass-approvals-and-sandbox' ]; then
      case "${2:-}" in
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

profile_login_home="$fixture_root/home/.local/share/trellage/profiles/codex/hve/home"
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
  assert_usage_status "native-$lifecycle_profile" --native-auth "$lifecycle_profile" hve
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

HOME="$fixture_root/home" fake_env "$fixture_launcher" setup hve \
  >"$fixture_root/setup-hve.out" || fail 'setup hve failed'
hve_home="$fixture_root/home/.local/share/trellage/profiles/codex/hve/home"
[ -d "$hve_home" ] || fail 'setup did not create hve home'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'setup created host authentication'
auth_is_absent "$hve_home/auth.json" || fail 'setup created profile authentication'
[ -f "$hve_home/config.toml" ] || fail 'setup did not create profile config'
if grep -F -e 'host-only-secret' -e 'mcp_servers.host-only' -e 'must-not-copy' \
  "$hve_home/config.toml" >/dev/null; then
  fail 'setup imported host config bytes'
fi

jq -se '
  any(.[]; .args == ["plugin","marketplace","list","--json"])
  and any(.[]; .args == ["plugin","list","--json"])
  and any(.[]; .args == ["plugin","marketplace","add",$adapter,"--json"])
  and any(.[]; .args == ["plugin","add","hve-core-all@hve-core","--json"])
' --arg adapter "$fake_adapter_root" \
  "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'setup hve native lifecycle calls differ'

printf '%s\n' '{"tokens":{"access_token":"host-only-access","refresh_token":"host-only-refresh"},"last_refresh":"2026-07-30T00:00:00Z"}' \
  >"$fixture_root/home/.codex/auth.json"
chmod 0600 "$fixture_root/home/.codex/auth.json"
host_auth_hash="$(shasum -a 256 "$fixture_root/home/.codex/auth.json" | awk '{print $1}')"
cp "$hve_home/config.toml" "$fixture_root/proxy-launch-config-before.toml"
(cd "$original_cwd" && \
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  "$fixture_launcher" hve -m gpt-5.5 exec --json 'hello world') \
  || fail 'hve launch failed'
cmp -s "$fixture_root/proxy-launch-config-before.toml" "$hve_home/config.toml" \
  || fail 'proxy launch did not restore exact prelaunch config bytes'
jq -se --arg codexHome "$hve_home" \
  --arg home "$fixture_root/home" \
  --arg cwd "$original_cwd" '
    map(select(.args[0] == "--dangerously-bypass-approvals-and-sandbox")) as $launches |
    ($launches | length) == 1
    and $launches[0].codexHome == $codexHome
    and $launches[0].home == $home
    and $launches[0].cwd == $cwd
    and $launches[0].args == [
      "--dangerously-bypass-approvals-and-sandbox",
      "-m", "gpt-5.5", "exec", "--json", "hello world"
    ]
  ' "$fixture_root/fake-codex.log" >/dev/null || fail 'launch environment or arguments differ'
auth_is_absent "$hve_home/auth.json" || fail 'launch copied host authentication'
[ "$(shasum -a 256 "$fixture_root/home/.codex/auth.json" | awk '{print $1}')" = "$host_auth_hash" ] \
  || fail 'launch changed host authentication'
rm "$fixture_root/home/.codex/auth.json"

proxy_config_before="$fixture_root/proxy-launch-config-before.toml"
assert_early_status() {
  local expected="$1" label="$2" status=0
  shift 2
  "$@" >"$fixture_root/$label.out" 2>&1 || status=$?
  [ "$status" -eq "$expected" ] \
    || fail "$label exit was $status, expected $expected"
}
assert_early_status 37 proxy-launch-child-status env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_APPEND_PROJECT_TRUST_TWICE=1 \
  FAKE_CODEX_EXIT_STATUS=37 "$fixture_launcher" hve --version
cmp -s "$proxy_config_before" "$hve_home/config.toml" \
  || fail 'failed proxy child did not restore exact prelaunch config bytes'

proxy_config_with_separator="$fixture_root/proxy-launch-config-with-separator.toml"
awk -v marker='# trellage-managed-codex-provider-end' '
  $0 == marker { print "" }
  { print }
' "$proxy_config_before" >"$proxy_config_with_separator"
cp "$proxy_config_with_separator" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  "$fixture_launcher" hve --version \
  || fail 'separator-preserving project trust launch failed'
cmp -s "$proxy_config_with_separator" "$hve_home/config.toml" \
  || fail 'separator-preserving launch did not restore exact prelaunch bytes'
cp "$proxy_config_before" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"

# Eight bounds compatibility well above normal one-stanza writes and the
# two-stanza recovery case while keeping accepted native-tail growth small.
generated_project_trust_cap=8
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  FAKE_CODEX_APPEND_PROJECT_TRUST_COUNT="$generated_project_trust_cap" \
  "$fixture_launcher" hve --version \
  || fail 'boundary generated project trust chain was rejected'
cmp -s "$proxy_config_before" "$hve_home/config.toml" \
  || fail 'boundary project trust cleanup changed prelaunch config bytes'

over_cap_project_config="$fixture_root/over-cap-project-config.toml"
over_cap_status=0
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  FAKE_CODEX_APPEND_PROJECT_TRUST_COUNT="$((generated_project_trust_cap + 1))" \
  FAKE_CODEX_CAPTURE_PROJECT_CONFIG="$over_cap_project_config" \
  "$fixture_launcher" hve --version \
  >"$fixture_root/over-cap-project-launch.out" 2>&1 \
  || over_cap_status=$?
[ "$over_cap_status" -eq 1 ] \
  || fail 'over-cap generated project trust chain was accepted'
cmp -s "$over_cap_project_config" "$hve_home/config.toml" \
  || fail 'over-cap project trust rejection changed live config bytes'
cp "$proxy_config_before" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"

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
    "$fixture_launcher" hve --version \
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
  cmp -s "$proxy_config_before" "$hve_home/config.toml" \
    || fail "pending launch signal iteration $pending_signal_iteration bypassed exact config cleanup"
  [ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
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
  "$fixture_launcher" hve --version >"$fixture_root/overlap-first.out" 2>&1 &
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
  "$fixture_launcher" hve --version >"$fixture_root/overlap-second.out" 2>&1 &
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
[ "$overlap_entered_early" = no ] \
  || fail 'second overlapping launch entered Codex before first cleanup'
[ "$overlap_first_status" -eq 0 ] || fail 'first overlapping launch failed'
[ "$overlap_second_status" -eq 0 ] \
  || { cat "$fixture_root/overlap-second.out" >&2; fail 'second overlapping launch failed'; }
[ -f "$overlap_dir/second-started" ] || fail 'second overlapping launch never started'
cmp -s "$proxy_config_before" "$hve_home/config.toml" \
  || fail 'overlapping launches did not restore exact canonical config bytes'
[ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
  || fail 'overlapping launches left profile lock state'
untrack_async_pid "$overlap_first_pid"
untrack_async_group "$overlap_first_group"
untrack_async_pid "$overlap_second_pid"
[ -z "$overlap_second_group" ] || untrack_async_group "$overlap_second_group"

printf '%s %s %s\n' 2147483647 stalebirth 999-1 >"$hve_home/.launch.lock"
chmod 0600 "$hve_home/.launch.lock"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" hve --version \
  || fail 'launch did not recover stale profile lock'
[ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
  || fail 'stale profile lock recovery left lock state'

printf '%s %s %s\n' "$$" mismatchedbirth 999-2 >"$hve_home/.launch.lock"
chmod 0600 "$hve_home/.launch.lock"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" hve --version \
  || fail 'launch did not recover reused-PID lock identity mismatch'
[ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
  || fail 'reused-PID lock recovery left lock state'

printf '%s %s %s\n' 2147483647 stalebirth 999-3 >"$hve_home/.launch.lock"
printf '%s %s %s\n' 2147483646 olderbirth 999-4 >"$hve_home/.launch-lock-reap"
chmod 0600 "$hve_home/.launch.lock" "$hve_home/.launch-lock-reap"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" hve --version \
  || fail 'launch did not recover mismatched stale recovery link'
[ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
  || fail 'mismatched recovery-link test left profile lock'
[ ! -e "$hve_home/.launch-lock-reap" ] \
  && [ ! -L "$hve_home/.launch-lock-reap" ] \
  || fail 'mismatched recovery-link test left recovery link'

release_race_dir="$fixture_root/launch-lock-owner-release"
mkdir "$release_race_dir"
printf '%s %s %s\n' 2147483647 stalebirth 999-5 >"$hve_home/.launch.lock"
chmod 0600 "$hve_home/.launch.lock"
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
  CDX_TEST_RELEASE_RACE_LOCK="$hve_home/.launch.lock" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  FAKE_CODEX_RELEASE_RACE_DIR="$release_race_dir" \
  "$fixture_launcher" hve --version >"$release_race_dir/waiter.out" 2>&1 \
  || release_race_status=$?
[ -f "$release_race_dir/injected" ] \
  || fail 'owner release race was not injected before owner read'
[ "$release_race_status" -eq 0 ] \
  || fail 'waiter did not retry after owner released launch lock'
[ -f "$release_race_dir/child-started" ] \
  || fail 'waiter did not launch after owner released launch lock'
[ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
  || fail 'owner release race left profile lock state'

takeover_dir="$fixture_root/launch-lock-takeover"
mkdir "$takeover_dir"
takeover_birth="$(LC_ALL=C ps -p "$$" -o lstart= | tr -cd '[:alnum:]')"
[ -n "$takeover_birth" ] || fail 'could not determine takeover lock owner birth'
takeover_owner="$$ $takeover_birth 999-5"
printf '%s %s %s\n' 2147483647 stalebirth 999-4 >"$hve_home/.launch.lock"
printf '%s\n' "$takeover_owner" >"$takeover_dir/active-owner"
chmod 0600 "$hve_home/.launch.lock" "$takeover_dir/active-owner"
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
  CDX_TEST_TAKEOVER_LOCK="$hve_home/.launch.lock" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 FAKE_CODEX_TAKEOVER_DIR="$takeover_dir" \
  "$fixture_launcher" hve --version >"$takeover_dir/contender.out" 2>&1 &
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
[ -f "$hve_home/.launch.lock" ] \
  && [ "$(cat "$hve_home/.launch.lock")" = "$takeover_owner" ] \
  || fail 'takeover race removed active profile lock'
[ ! -f "$takeover_dir/child-started" ] \
  || fail 'takeover contender entered Codex while active lock was held'
kill -0 "$takeover_contender_pid" 2>/dev/null \
  || fail 'takeover contender did not wait for active lock release'
rm -f -- "$hve_home/.launch.lock"
takeover_status=0
wait "$takeover_contender_pid" || takeover_status=$?
[ "$takeover_status" -eq 0 ] || fail 'takeover contender failed after lock release'
[ -f "$takeover_dir/child-started" ] \
  || fail 'takeover contender did not launch after lock release'
[ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
  || fail 'takeover contender left profile lock state'
[ ! -e "$hve_home/.launch-lock-reap" ] \
  && [ ! -L "$hve_home/.launch-lock-reap" ] \
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
    "$fixture_launcher" hve --version
  cmp -s "$proxy_config_before" "$hve_home/config.toml" \
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
  "$fixture_launcher" hve --version >"$fixture_root/retry-wait-signal.out" 2>&1 &
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
cmp -s "$proxy_config_before" "$hve_home/config.toml" \
  || fail 'retrying wait bypassed exact config cleanup'
[ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
  || fail 'retrying wait released lock before process tree reaped'
untrack_async_pid "$retry_wait_launcher_pid"
untrack_async_group "$retry_wait_group"
rm "$fake_bin/cp"

assert_early_status 1 proxy-launch-unrelated-mutation env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 \
  FAKE_CODEX_PROJECT_EXTRA_FIELD='unexpected = true' \
  "$fixture_launcher" hve --version
grep -F -- 'cdx: post-launch config cleanup refused unrelated mutation: hve' \
  "$fixture_root/proxy-launch-unrelated-mutation.out" >/dev/null \
  || fail 'unrelated launch mutation cleanup diagnostic differs'
grep -F -- 'unexpected = true' "$hve_home/config.toml" >/dev/null \
  || fail 'cleanup clobbered unrelated launch mutation'
cp "$proxy_config_before" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"

awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
    print ""
  }
  { print }
' "$hve_home/config.toml" >"$fixture_root/stale-project-config.toml"
mv "$fixture_root/stale-project-config.toml" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor hve \
  >"$fixture_root/doctor-stale-project.out" \
  || fail 'doctor did not recover stale generated project trust'
cmp -s "$proxy_config_with_separator" "$hve_home/config.toml" \
  || fail 'stale project trust recovery changed other config bytes'

awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
    print ""
  }
  { print }
' "$hve_home/config.toml" >"$fixture_root/stale-project-repair.toml"
mv "$fixture_root/stale-project-repair.toml" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair hve \
  >"$fixture_root/repair-stale-project.out" \
  || fail 'repair did not recover stale generated project trust'
cmp -s "$proxy_config_with_separator" "$hve_home/config.toml" \
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
' "$hve_home/config.toml" >"$fixture_root/stale-project-extra-blanks.toml"
mv "$fixture_root/stale-project-extra-blanks.toml" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
cp "$hve_home/config.toml" "$fixture_root/stale-project-extra-blanks-before.toml"
extra_blank_status=0
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor hve \
  >"$fixture_root/doctor-stale-project-extra-blanks.out" 2>&1 \
  || extra_blank_status=$?
[ "$extra_blank_status" -eq 1 ] \
  || fail 'doctor accepted multiple trailing project trust blanks'
cmp -s "$fixture_root/stale-project-extra-blanks-before.toml" \
  "$hve_home/config.toml" \
  || fail 'doctor changed project trust with multiple trailing blanks'
cp "$proxy_config_before" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"

awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
  }
  { print }
' "$hve_home/config.toml" >"$fixture_root/stale-project-setup.toml"
mv "$fixture_root/stale-project-setup.toml" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" setup hve \
  >"$fixture_root/setup-stale-project.out" \
  || fail 'setup did not recover stale generated project trust'
cmp -s "$proxy_config_with_separator" "$hve_home/config.toml" \
  || fail 'setup stale project recovery changed other config bytes'

awk -v marker='# trellage-managed-codex-provider-end' -v cwd="$original_cwd" '
  $0 == marker {
    print ""
    print "[projects.\"" cwd "\"]"
    print "trust_level = \"trusted\""
  }
  { print }
' "$hve_home/config.toml" >"$fixture_root/stale-project-launch.toml"
mv "$fixture_root/stale-project-launch.toml" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" hve --version \
  || fail 'launch did not recover stale generated project trust'
cmp -s "$proxy_config_with_separator" "$hve_home/config.toml" \
  || fail 'launch stale project recovery changed other config bytes'

awk '
  $0 == "# trellage-profile-local-config-end" {
    print "[projects.\"/user/owned/project\"]"
    print "trust_level = \"trusted\""
  }
  { print }
' "$hve_home/config.toml" >"$fixture_root/local-project-config.toml"
mv "$fixture_root/local-project-config.toml" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
cp "$hve_home/config.toml" "$fixture_root/local-project-config-before.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor hve \
  >"$fixture_root/doctor-local-project.out" \
  || fail 'doctor rejected profile-local project table'
cmp -s "$fixture_root/local-project-config-before.toml" "$hve_home/config.toml" \
  || fail 'recovery changed profile-local project table bytes'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 "$fixture_launcher" hve --version \
  || fail 'launch with profile-local project table failed'
cmp -s "$fixture_root/local-project-config-before.toml" "$hve_home/config.toml" \
  || fail 'launch cleanup changed profile-local project table bytes'
cp "$proxy_config_before" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"

real_cmp="$(command -v cmp)"
sed 's/model = "gpt-5.6-sol"/model = "concurrent-launch-winner"/' \
  "$proxy_config_before" >"$fixture_root/concurrent-launch-config.toml"
chmod 0600 "$fixture_root/concurrent-launch-config.toml"
cat >"$fake_bin/cmp" <<'EOF'
#!/usr/bin/env bash
"$CDX_TEST_REAL_CMP" "$@"
status=$?
case "${2:-}:${3:-}" in
  */.config-snapshot.*:*/.config.*)
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
assert_early_status 1 proxy-launch-cleanup-race env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  FAKE_CODEX_APPEND_PROJECT_TRUST=1 CDX_TEST_REAL_CMP="$real_cmp" \
  FAKE_CODEX_ARM_CLEANUP_RACE="$fixture_root/arm-launch-cleanup-race" \
  CDX_TEST_REAL_MV="$(command -v mv)" \
  CDX_TEST_CLEANUP_RACE_ARM="$fixture_root/arm-launch-cleanup-race" \
  CDX_TEST_CLEANUP_RACE_EXTERNAL="$fixture_root/concurrent-launch-config.toml" \
  CDX_TEST_CLEANUP_RACE_TARGET="$hve_home/config.toml" \
  "$fixture_launcher" hve --version
grep -F -- 'cdx: post-launch config cleanup detected concurrent mutation: hve' \
  "$fixture_root/proxy-launch-cleanup-race.out" >/dev/null \
  || fail 'concurrent launch cleanup diagnostic differs'
grep -F -- 'model = "concurrent-launch-winner"' "$hve_home/config.toml" >/dev/null \
  || fail 'launch cleanup clobbered concurrent config mutation'
rm "$fake_bin/cmp"
cp "$proxy_config_before" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"

file_mode() {
  local system_name value

  system_name="$(uname -s 2>/dev/null)" || return 1
  case "$system_name" in
    Darwin) value="$(stat -f '%Lp' "$1" 2>/dev/null)" || return 1 ;;
    Linux) value="$(stat -c '%a' "$1" 2>/dev/null)" || return 1 ;;
    *) return 1 ;;
  esac
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$value"
}

file_inode() {
  local system_name value

  system_name="$(uname -s 2>/dev/null)" || return 1
  case "$system_name" in
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

dangling_auth_probe="$fixture_root/dangling-auth.json"
ln -s "$fixture_root/missing-auth-target.json" "$dangling_auth_probe"
if auth_is_absent "$dangling_auth_probe"; then
  fail 'auth absence check accepted a dangling symlink'
fi
rm "$dangling_auth_probe"

state_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
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

write_isolation_snapshot() {
  local label="$1" profile home

  for profile in hve superpowers; do
    home="$fixture_root/home/.local/share/trellage/profiles/codex/$profile/home"
    printf '%s\t%s\n' "$profile.config" "$(state_file_hash "$home/config.toml")"
    printf '%s\t%s\n' "$profile.session" "$(state_file_hash "$home/sessions/keep.jsonl")"
    printf '%s\t%s\n' "$profile.mcp" "$(state_mcp_hash "$home/config.toml")"
    printf '%s\t%s\n' "$profile.plugin-selected" "$(state_file_hash "$fake_state/$profile/plugin")"
    printf '%s\t%s\n' "$profile.plugin-unrelated" "$(state_file_hash "$home/plugins/unrelated/state")"
    printf '%s\t%s\n' "$profile.marketplace-materialized" \
      "$(state_file_hash "$home/.tmp/marketplaces/superpowers-marketplace/.fake-materialized-revision")"
    printf '%s\t%s\n' "$profile.plugin-metadata" \
      "$(state_file_hash "$home/plugins/.fake-installed-superpowers")"
    printf '%s\t%s\n' "$profile.plugin-cache" \
      "$(state_file_hash "$home/plugins/cache/superpowers-marketplace/superpowers/6.2.0/.fake-materialized-cache")"
    printf '%s\t%s\n' "$profile.plugin-unrelated-same-marketplace" \
      "$(state_file_hash "$home/plugins/cache/superpowers-marketplace/unrelated/1.0.0/.fake-materialized-cache")"
  done >"$fixture_root/$label.state-before"
}

assert_isolation_snapshot_unchanged() {
  local label="$1"

  write_isolation_snapshot "$label-after"
  cmp -s "$fixture_root/$label.state-before" "$fixture_root/$label-after.state-before" \
    || {
      diff -u "$fixture_root/$label.state-before" \
        "$fixture_root/$label-after.state-before" >&2 || :
      fail "$label changed config, session, MCP, plugin, or other-profile state"
    }
}

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
root_profile_target='/.local/share/trellage/profiles/codex/hve/home'
if [ -e "$root_profile_target" ] || [ -L "$root_profile_target" ]; then
  root_target_identity="$(file_inode "$root_profile_target"):$(file_mode "$root_profile_target")"
else
  root_target_identity='missing'
fi
assert_root_home_rejected() {
  local label="$1"
  local unsafe_home="$2"
  local expected_path="${unsafe_home%/}/.local/share/trellage/profiles/codex/hve/home"
  assert_command_fails "root-home-doctor-$label" env HOME="$unsafe_home" \
    PATH="$root_write_blocker_bin:$PATH" CDX_TEST_ROOT_WRITE_LOG="$root_write_log" \
    "$fixture_launcher" doctor hve
  grep -F -- "cdx: unsafe profile home path: $expected_path" \
    "$fixture_root/root-home-doctor-$label.out" >/dev/null \
    || fail "canonical root HOME doctor diagnostic differs for $label"
  assert_command_fails "root-home-setup-$label" env HOME="$unsafe_home" \
    PATH="$root_write_blocker_bin:$PATH" CDX_TEST_ROOT_WRITE_LOG="$root_write_log" \
    "$fixture_launcher" setup hve
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

[marketplaces.hve-core]
last_updated = "2026-07-30T21:16:34Z"
source_type = "local"
source = "$fake_adapter_root"

[plugins."hve-core-all@hve-core"]
enabled = true
# trellage-managed-codex-provider-end
EOF

cmp -s "$expected_config" "$hve_home/config.toml" || fail 'initial managed config differs'
[ "$(file_mode "$hve_home")" = '700' ] || fail 'hve home mode is not 0700'
[ "$(file_mode "$hve_home/config.toml")" = '600' ] || fail 'hve config mode is not 0600'
hve_cache="$hve_home/plugins/cache/hve-core/hve-core-all/3.3.101"
mkdir -p "$hve_cache/.codex-plugin" \
  "$hve_cache/.github/skills/package-one" \
  "$hve_cache/.github/skills/package-two" \
  "$hve_home/plugins/cache/hve-core/unrelated/9.9.9/skills/not-selected"
printf '%s\n' '{"name":"hve-core-all","version":"3.3.101","skills":"./.github/skills"}' \
  >"$hve_cache/.codex-plugin/plugin.json"
printf '%s\n' '# Package one' >"$hve_cache/.github/skills/package-one/SKILL.md"
printf '%s\n' '# Package two' >"$hve_cache/.github/skills/package-two/SKILL.md"
printf '%s\n' '# Unrelated package' \
  >"$hve_home/plugins/cache/hve-core/unrelated/9.9.9/skills/not-selected/SKILL.md"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" doctor hve \
  >"$fixture_root/doctor-hve.out" || fail 'doctor hve failed'
: >"$fake_state/hve/forbidden-superpowers"
if HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" doctor hve \
  >"$fixture_root/doctor-hve-superpowers.out" \
  2>"$fixture_root/doctor-hve-superpowers.err"; then
  fail 'doctor accepted Superpowers in the HVE profile'
fi
grep -F -- 'cdx: forbidden Superpowers plugin is installed: hve; run: cdx repair hve' \
  "$fixture_root/doctor-hve-superpowers.err" >/dev/null \
  || fail 'Codex forbidden-Superpowers diagnostic differs'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" repair hve \
  >"$fixture_root/repair-hve-superpowers.out" \
  || fail 'repair did not remove forbidden Superpowers from HVE'
[ ! -e "$fake_state/hve/forbidden-superpowers" ] \
  || fail 'repair preserved forbidden Superpowers in HVE'
: >"$fake_state/hve/forbidden-superpowers-direct"
: >"$fake_state/hve/forbidden-superpowers-renamed"
launches_before="$(jq -s '[.[] | select(.args[0] == "--dangerously-bypass-approvals-and-sandbox")] | length' \
  "$fixture_root/fake-codex.log")"
mkdir -p "$fixture_root/home/.codex"
printf '%s\n' '{"tokens":{"access_token":"contamination-check"}}' \
  >"$fixture_root/home/.codex/auth.json"
chmod 0600 "$fixture_root/home/.codex/auth.json"
export FAKE_CODEX_LOGIN_STATUS=0
for contaminated_launch in proxy native; do
  contaminated_args=(hve --version)
  [ "$contaminated_launch" = proxy ] \
    || contaminated_args=(--native-auth hve --version)
  if HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" "${contaminated_args[@]}" \
    >"$fixture_root/$contaminated_launch-contaminated.out" \
    2>"$fixture_root/$contaminated_launch-contaminated.err"; then
    fail "$contaminated_launch launch accepted direct/source-renamed Superpowers"
  fi
  grep -F -- 'cdx: forbidden Superpowers plugin is installed: hve; run: cdx repair hve' \
    "$fixture_root/$contaminated_launch-contaminated.err" >/dev/null \
    || fail "$contaminated_launch forbidden-Superpowers diagnostic differs"
done
unset FAKE_CODEX_LOGIN_STATUS
rm "$fixture_root/home/.codex/auth.json"
[ -e "$fake_state/hve/forbidden-superpowers-direct" ] \
  && [ -e "$fake_state/hve/forbidden-superpowers-renamed" ] \
  || fail 'contaminated launch mutated installed plugins'
[ "$(jq -s '[.[] | select(.args[0] == "--dangerously-bypass-approvals-and-sandbox")] | length' \
  "$fixture_root/fake-codex.log")" = "$launches_before" ] \
  || fail 'contaminated launch started the underlying Codex agent'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" repair hve \
  >"$fixture_root/repair-hve-multiple-superpowers.out" \
  || fail 'repair did not remove all forbidden Superpowers variants'
[ ! -e "$fake_state/hve/forbidden-superpowers-direct" ] \
  && [ ! -e "$fake_state/hve/forbidden-superpowers-renamed" ] \
  || fail 'repair preserved a forbidden Superpowers variant'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" inventory hve --json \
  >"$fixture_root/inventory-hve.json" || fail 'inventory hve failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "cdx"
  and .harness == "codex"
  and .profile == "hve"
  and .readiness == "healthy"
  and .plugins == [{name:"hve-core-all@hve-core",version:"3.3.101"}]
  and .skills == {packageCount:2,visibleCount:2}
  and .mcps == ["docs"]
' "$fixture_root/inventory-hve.json" >/dev/null \
  || fail 'Codex inventory output differs'
mv "$hve_cache" "$hve_cache.safe"
ln -s "$hve_home/plugins/cache/hve-core/unrelated/9.9.9" "$hve_cache"
if HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
  "$fixture_launcher" inventory hve --json \
  >"$fixture_root/inventory-hve-symlink.out" \
  2>"$fixture_root/inventory-hve-symlink.err"; then
  fail 'Codex inventory accepted a redirected selected plugin cache'
fi
grep -F -- 'selected plugin cache is invalid: hve' \
  "$fixture_root/inventory-hve-symlink.err" >/dev/null \
  || fail 'Codex redirected-cache diagnostic differs'
rm "$hve_cache"
mv "$hve_cache.safe" "$hve_cache"
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
auth_is_absent "$hve_home/auth.json" || fail 'doctor created profile authentication'

sed 's/2026-07-30T21:16:34Z/2026-07-30T22:17:35Z/' \
  "$hve_home/config.toml" >"$fixture_root/config-new-timestamp.toml"
mv "$fixture_root/config-new-timestamp.toml" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
HOME="$fixture_root/home" fake_env "$fixture_launcher" doctor hve \
  >"$fixture_root/doctor-hve-new-timestamp.out" \
  || fail 'doctor rejected mutable native marketplace timestamp'
HOME="$fixture_root/home" fake_env "$fixture_launcher" setup hve \
  >"$fixture_root/setup-hve-new-timestamp.out" \
  || fail 'repeated setup rejected mutable native marketplace timestamp'
grep -F -- 'last_updated = "2026-07-30T22:17:35Z"' \
  "$hve_home/config.toml" >/dev/null \
  || fail 'repeated setup changed native marketplace timestamp'
cp "$expected_config" "$hve_home/config.toml"

: >"$fixture_root/fake-codex.log"
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" setup --all \
  >"$fixture_root/setup-all.out" || fail 'setup --all failed'
superpowers_home="$fixture_root/home/.local/share/trellage/profiles/codex/superpowers/home"
[ -d "$superpowers_home" ] || fail 'setup --all did not create superpowers home'
expected_superpowers_config="$fixture_root/expected-superpowers-config.toml"
sed \
  -e 's/\[marketplaces\.hve-core\]/[marketplaces.superpowers-marketplace]/' \
  -e 's/\[plugins\."hve-core-all@hve-core"\]/[plugins."superpowers@superpowers-marketplace"]/' \
  -e 's/source_type = "local"/source_type = "git"/' \
  -e 's|^source = ".*"$|source = "https://github.com/obra/superpowers-marketplace.git"|' \
  "$expected_config" >"$expected_superpowers_config"
awk '
  /^source = "https:\/\/github.com\/obra\/superpowers-marketplace.git"$/ {
    print
    getline
    print "last_revision = \"0123456789abcdef0123456789abcdef01234567\""
    print ""
    next
  }
  { print }
' "$expected_superpowers_config" \
  >"$fixture_root/expected-superpowers-config-with-revision.toml"
mv "$fixture_root/expected-superpowers-config-with-revision.toml" \
  "$expected_superpowers_config"
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
jq -se --arg hve "$hve_home" '
  all(.[] | select(.codexHome == $hve);
    .args[0:3] != ["plugin","marketplace","upgrade"])
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'HVE setup upgraded its local marketplace'
[ "$(file_mode "$superpowers_home")" = '700' ] \
  || fail 'superpowers home mode is not 0700'
[ "$(file_mode "$superpowers_home/config.toml")" = '600' ] \
  || fail 'superpowers config mode is not 0600'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'setup --all created host authentication'
auth_is_absent "$hve_home/auth.json" \
  || fail 'setup --all created hve authentication'
auth_is_absent "$superpowers_home/auth.json" \
  || fail 'setup --all created superpowers authentication'
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" doctor superpowers \
  >"$fixture_root/doctor-superpowers.out" || fail 'doctor superpowers failed'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'doctor created host authentication'
auth_is_absent "$hve_home/auth.json" || fail 'doctor created hve authentication'
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
  and all(.[]; .args[0] != "--dangerously-bypass-approvals-and-sandbox")
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

profile_local="$fixture_root/profile-local.bytes"
cat >"$profile_local" <<'EOF'
profile_root_key = "stays-root"

[mcp_servers.profile_only]
command = "profile-mcp"
args = ["hello world", "literal # text"]

[profile_local]
keep = "byte-for-byte"
EOF
custom_config="$fixture_root/custom-config.toml"
{
  sed -n '1,7p' "$expected_config"
  cat "$profile_local"
  sed -n '9,$p' "$expected_config"
} >"$custom_config"
sed '/# trellage-managed-codex-provider-end/i\
[marketplaces.user-owned]\
last_updated = "2026-07-30T20:15:33Z"\
source_type = "git"\
source = "example/user-owned"' "$custom_config" \
  >"$fixture_root/custom-config-with-user-marketplace.toml"
mv "$fixture_root/custom-config-with-user-marketplace.toml" "$custom_config"
escaped_marketplace="$fixture_root/escaped-marketplace.toml"
cat >"$escaped_marketplace" <<'EOF'
[marketplaces.escaped-owned]
last_updated = "2026-07-30T20:15:34Z"
source_type = "local"
source = "C:\\Users\"quoted\""

[marketplaces.scalar-owned]
last_updated = "2026-07-30T20:15:35Z"
source_type = "local"
source = "\uD7FF\uE000\U0010FFFF"
future_scalar = "preserve-marketplace-field"

[plugins."unrelated@user-owned"]
enabled = false
future_flag = true

[plugins."valid\u002Dplugin@user-owned"]
enabled = false
EOF
{
  sed '$d' "$custom_config"
  cat "$escaped_marketplace"
  printf '%s\n' '# trellage-managed-codex-provider-end'
} >"$fixture_root/custom-config-with-escaped-marketplace.toml"
mv "$fixture_root/custom-config-with-escaped-marketplace.toml" "$custom_config"
sed 's/model = "gpt-5.6-sol"/model = "wrong-managed-model"/' \
  "$custom_config" >"$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
assert_command_fails doctor-wrong-managed env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor hve
HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" repair hve \
  >"$fixture_root/repair-hve.out" || fail 'repair hve failed'
cmp -s "$custom_config" "$hve_home/config.toml" \
  || fail 'repair did not restore managed config and preserve profile-local bytes'
root_key_line="$(grep -Fn 'profile_root_key = "stays-root"' \
  "$hve_home/config.toml" | cut -d: -f1)"
provider_table_line="$(grep -Fn '[model_providers.copilotproxy]' \
  "$hve_home/config.toml" | cut -d: -f1)"
[ "$root_key_line" -lt "$provider_table_line" ] \
  || fail 'repair moved a root-level profile-local key into provider table scope'
grep -F -- '[marketplaces.hve-core]' "$hve_home/config.toml" >/dev/null \
  && grep -F -- '[marketplaces.user-owned]' "$hve_home/config.toml" >/dev/null \
  && grep -F -- 'source = "C:\\Users\"quoted\""' \
    "$hve_home/config.toml" >/dev/null \
  && grep -F -- '[plugins."unrelated@user-owned"]' \
    "$hve_home/config.toml" >/dev/null \
  && grep -F -- 'source = "\uD7FF\uE000\U0010FFFF"' \
    "$hve_home/config.toml" >/dev/null \
  && grep -F -- '[plugins."valid\u002Dplugin@user-owned"]' \
    "$hve_home/config.toml" >/dev/null \
  && grep -F -- 'future_scalar = "preserve-marketplace-field"' \
    "$hve_home/config.toml" >/dev/null \
  && grep -F -- 'future_flag = true' "$hve_home/config.toml" >/dev/null \
  || fail 'repair lost selected or unrelated native config state'
auth_is_absent "$fixture_root/home/.codex/auth.json" \
  || fail 'repair created host authentication'
auth_is_absent "$hve_home/auth.json" || fail 'repair created profile authentication'
[ "$(file_mode "$hve_home/config.toml")" = '600' ] \
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
  "$custom_config" >"$hve_home/config.toml"
sed 's/2026-07-30T21:16:34Z/2026-07-30T21:16:35Z/' \
  "$hve_home/config.toml" >"$fixture_root/config-snapshot-race-expected.toml"
assert_command_fails config-snapshot-race env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" CDX_TEST_REAL_CP="$real_cp" \
  CDX_TEST_REAL_SED="$real_sed" CDX_TEST_REAL_MV="$real_mv" \
  CDX_TEST_CONFIG_TARGET="$hve_home/config.toml" \
  CDX_TEST_CONFIG_EXTERNAL="$fixture_root/config-snapshot-race-external.toml" \
  "$fixture_launcher" repair hve
grep -F -- 'cdx: profile config changed during snapshot: hve' \
  "$fixture_root/config-snapshot-race.out" >/dev/null \
  || fail 'snapshot-race diagnostic differs'
cmp -s "$fixture_root/config-snapshot-race-expected.toml" \
  "$hve_home/config.toml" || fail 'snapshot race overwrote external config bytes'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.config*' -print -quit)" ] \
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
  "$custom_config" >"$hve_home/config.toml"
sed 's/2026-07-30T21:16:34Z/2026-07-30T21:16:36Z/' \
  "$hve_home/config.toml" >"$fixture_root/config-publish-race-expected.toml"
assert_command_fails config-publish-race env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" CDX_TEST_REAL_CHMOD="$real_chmod" \
  CDX_TEST_REAL_SED="$real_sed" CDX_TEST_REAL_MV="$real_mv" \
  CDX_TEST_CONFIG_TARGET="$hve_home/config.toml" \
  CDX_TEST_CONFIG_EXTERNAL="$fixture_root/config-publish-race-external.toml" \
  "$fixture_launcher" repair hve
grep -F -- 'cdx: profile config changed during repair: hve' \
  "$fixture_root/config-publish-race.out" >/dev/null \
  || fail 'publish-race diagnostic differs'
cmp -s "$fixture_root/config-publish-race-expected.toml" \
  "$hve_home/config.toml" || fail 'publish race overwrote external config bytes'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.config*' -print -quit)" ] \
  || fail 'publish race left config staging debris'
rm "$fake_bin/chmod"
cp "$custom_config" "$hve_home/config.toml"

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
  "$custom_config" >"$hve_home/config.toml"
cp "$hve_home/config.toml" "$fixture_root/config-write-failure-before.toml"
assert_command_fails config-write-failure env HOME="$fixture_root/home" \
  PATH="$fake_bin:$PATH" CDX_TEST_REAL_CAT="$real_cat" \
  "$fixture_launcher" repair hve
grep -F -- 'cdx: failed to write profile config' \
  "$fixture_root/config-write-failure.out" >/dev/null \
  || fail 'config write-failure diagnostic differs'
cmp -s "$fixture_root/config-write-failure-before.toml" \
  "$hve_home/config.toml" || fail 'config write failure published partial bytes'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.config*' -print -quit)" ] \
  || fail 'config write failure left staging debris'
rm "$fake_bin/cat"
cp "$custom_config" "$hve_home/config.toml"

cp "$hve_home/config.toml" "$fixture_root/config-valid"

marker_migration="$fixture_root/config-marker-migration.toml"
{
  sed -n '1,/^wire_api = "responses"$/p' "$custom_config"
  printf '\n'
  sed -n '/^\[marketplaces\.hve-core\]$/,/^enabled = true$/p' \
    "$custom_config"
  printf '%s\n\n' '# trellage-managed-codex-provider-end'
  printf '%s\n' '# trellage-codex-native-marketplaces-begin'
  sed -n '/^\[marketplaces\.user-owned\]$/,/# trellage-managed-codex-provider-end/p' \
    "$custom_config" | sed '$d'
  printf '%s\n' '# trellage-codex-native-marketplaces-end'
} >"$marker_migration"
cp "$marker_migration" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"
assert_command_fails doctor-marker-migration env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor hve
HOME="$fixture_root/home" fake_env "$fixture_launcher" repair hve \
  >"$fixture_root/repair-marker-migration.out" \
  || fail 'repair rejected bounded marker migration layout'
cmp -s "$custom_config" "$hve_home/config.toml" \
  || fail 'marker migration did not merge and preserve both native tails'
cp "$hve_home/config.toml" "$fixture_root/config-valid"

assert_invalid_markers_rejected() {
  label="$1"
  before="$fixture_root/config-before-$label"
  cp "$hve_home/config.toml" "$before"
  inode="$(file_inode "$hve_home/config.toml")"
  assert_command_fails "doctor-$label" env HOME="$fixture_root/home" \
    "$fixture_launcher" doctor hve
  assert_command_fails "repair-$label" env HOME="$fixture_root/home" \
    "$fixture_launcher" repair hve
  cmp -s "$before" "$hve_home/config.toml" \
    || fail "repair changed invalid $label config bytes"
  [ "$(file_inode "$hve_home/config.toml")" = "$inode" ] \
    || fail "repair changed invalid $label config inode"
  [ -z "$(find "$hve_home" -maxdepth 1 -name '.config*' -print -quit)" ] \
    || fail "repair left staging debris for $label"
}

grep -Fv '# trellage-profile-local-config-end' "$fixture_root/config-valid" \
  >"$hve_home/config.toml"
assert_invalid_markers_rejected missing-marker
cp "$fixture_root/config-valid" "$hve_home/config.toml"
printf '%s\n' '# trellage-profile-local-config-begin' >>"$hve_home/config.toml"
assert_invalid_markers_rejected duplicate-marker
sed \
  -e 's/# trellage-profile-local-config-begin/# local-marker-temporary/' \
  -e 's/# trellage-profile-local-config-end/# trellage-profile-local-config-begin/' \
  -e 's/# local-marker-temporary/# trellage-profile-local-config-end/' \
  "$fixture_root/config-valid" >"$hve_home/config.toml"
assert_invalid_markers_rejected out-of-order-markers
sed 's/\[marketplaces\.user-owned\]/[plugins.user-owned]/' \
  "$fixture_root/config-valid" >"$hve_home/config.toml"
assert_invalid_markers_rejected non-marketplace-native-table
invalid_native_block="$fixture_root/invalid-native-block.toml"
write_config_with_invalid_native() {
  {
    sed '$d' "$fixture_root/config-valid"
    cat "$invalid_native_block"
    printf '%s\n' '# trellage-managed-codex-provider-end'
  } >"$hve_home/config.toml"
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
  "$fixture_root/config-valid" >"$hve_home/config.toml"
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
' "$fixture_root/config-valid" >"$hve_home/config.toml"
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
[plugins."hve-core-all@hve-core"]\
enabled = true' "$fixture_root/config-valid" >"$hve_home/config.toml"
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
  "$fixture_root/config-valid" >"$hve_home/config.toml"
assert_invalid_markers_rejected duplicate-native-plugin-enabled
sed '/# trellage-codex-native-marketplaces-end/i\
[plugins."hve-core-all@hve-core"]\
enabled = true' "$marker_migration" >"$hve_home/config.toml"
assert_invalid_markers_rejected duplicate-plugin-across-marker-regions
sed '/# trellage-managed-codex-provider-end/a\
unexpected-native-tail-content' "$marker_migration" >"$hve_home/config.toml"
assert_invalid_markers_rejected invalid-marker-layout-separator
grep -Fv '# trellage-codex-native-marketplaces-end' "$marker_migration" \
  >"$hve_home/config.toml"
assert_invalid_markers_rejected partial-marker-migration-layout
sed '/\[marketplaces\.hve-core\]/i\
provider_api_key = "must-reject"
' \
  "$fixture_root/config-valid" >"$hve_home/config.toml"
assert_invalid_markers_rejected bare-provider-assignment-before-marketplace
cp "$fixture_root/config-valid" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"

sed 's/model = "gpt-5.6-sol"/model = "publication-must-fail"/' \
  "$fixture_root/config-valid" >"$hve_home/config.toml"
cp "$hve_home/config.toml" "$fixture_root/config-before-publication-failure"
config_inode="$(file_inode "$hve_home/config.toml")"
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
  CDX_TEST_CONFIG_TARGET="$hve_home/config.toml" \
  CDX_TEST_CONFIG_SAVED="$fixture_root/config-post-stage.saved" \
  CDX_TEST_CONFIG_OUTSIDE="$outside_config" "$fixture_launcher" repair hve
grep -F -- "cdx: unsafe profile config path: $hve_home/config.toml" \
  "$fixture_root/config-post-stage-safety.out" >/dev/null \
  || fail 'config post-stage safety diagnostic differs'
rm "$hve_home/config.toml"
mv "$fixture_root/config-post-stage.saved" "$hve_home/config.toml"
cmp -s "$fixture_root/config-before-publication-failure" "$hve_home/config.toml" \
  || fail 'config post-stage safety failure changed prior bytes'
[ "$(file_inode "$hve_home/config.toml")" = "$config_inode" ] \
  || fail 'config post-stage safety failure changed prior inode'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.config.*' -print -quit)" ] \
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
  "$fixture_launcher" repair hve
cmp -s "$fixture_root/config-before-publication-failure" "$hve_home/config.toml" \
  || fail 'config stage signal changed prior bytes'
[ "$(file_inode "$hve_home/config.toml")" = "$config_inode" ] \
  || fail 'config stage signal changed prior inode'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.config.*' -print -quit)" ] \
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
  "$fixture_launcher" repair hve
cmp -s "$fixture_root/config-before-publication-failure" "$hve_home/config.toml" \
  || fail 'failed config publication changed prior bytes'
[ "$(file_inode "$hve_home/config.toml")" = "$config_inode" ] \
  || fail 'failed config publication changed prior inode'
[ -z "$(find "$hve_home" -maxdepth 1 -name '.config.*' -print -quit)" ] \
  || fail 'failed config publication left staging debris'
rm "$fake_bin/mv"
cp "$fixture_root/config-valid" "$hve_home/config.toml"
chmod 0600 "$hve_home/config.toml"

config_inode="$(file_inode "$hve_home/config.toml")"
sed 's/model = "gpt-5.6-sol"/model = "setup-must-not-replace"/' \
  "$fixture_root/config-valid" >"$hve_home/config.toml"
cp "$hve_home/config.toml" "$fixture_root/config-before-setup"
assert_command_fails setup-does-not-replace env HOME="$fixture_root/home" \
  "$fixture_launcher" setup hve
cmp -s "$fixture_root/config-before-setup" "$hve_home/config.toml" \
  || fail 'setup replaced existing profile config'
cp "$fixture_root/config-valid" "$hve_home/config.toml"
chmod 0644 "$hve_home/config.toml"
assert_command_fails config-mode env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor hve
chmod 0600 "$hve_home/config.toml"

mv "$hve_home/config.toml" "$fixture_root/config-target.saved"
ln -s "$fixture_root/config-target.saved" "$hve_home/config.toml"
assert_command_fails symlink-config env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor hve
rm "$hve_home/config.toml"
mv "$fixture_root/config-target.saved" "$hve_home/config.toml"

mv "$hve_home/config.toml" "$fixture_root/config-target.saved"
mkdir "$hve_home/config.toml"
assert_command_fails non-regular-config env HOME="$fixture_root/home" \
  "$fixture_launcher" doctor hve
rmdir "$hve_home/config.toml"
mv "$fixture_root/config-target.saved" "$hve_home/config.toml"

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
  "$fixture_launcher" setup hve
race_config="$race_home/.local/share/trellage/profiles/codex/hve/home/config.toml"
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
assert_command_fails symlink-home env HOME="$unsafe_home" "$fixture_launcher" setup hve

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
  "$fixture_launcher" setup hve

symlink_profile_home="$fixture_root/symlink-profile-home"
prepare_test_home "$symlink_profile_home"
mkdir -p "$symlink_profile_home/.local/share/trellage/profiles/codex"
mkdir "$fixture_root/profile-target"
ln -s "$fixture_root/profile-target" \
  "$symlink_profile_home/.local/share/trellage/profiles/codex/hve"
assert_command_fails symlink-profile-component env HOME="$symlink_profile_home" \
  "$fixture_launcher" setup hve

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
assert_command_fails launch-before-setup env HOME="$fresh_home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" hve --version
assert_command_fails native-launch-before-setup env HOME="$fresh_home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" FAKE_CODEX_LOGIN_STATUS=0 \
  "$fixture_launcher" --native-auth hve --version
assert_command_fails unsafe-profile-slug env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" '../hve' --version
[ "$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')" = "$codex_count" ] \
  || fail 'unsafe or unprepared profile invoked Codex'

ln -s "$fixture_launcher" "$fake_bin/codex-recursive"
mv "$fake_bin/codex" "$fake_bin/codex-real"
ln -s "$fixture_launcher" "$fake_bin/codex"
assert_command_fails recursive-launcher env HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
  FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" hve --version
rm "$fake_bin/codex"
mv "$fake_bin/codex-real" "$fake_bin/codex"

jq -se '
  all(.[] | select(.args[0] == "--dangerously-bypass-approvals-and-sandbox");
    ((.args | join(" ")) | test("marketplace add|plugin add|marketplace upgrade|plugin remove") | not))
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'launch invoked a forbidden marketplace or plugin mutation'

printf 'trellage Codex auth contract: PASS\n'
printf 'trellage Codex config contract: PASS\n'
printf 'trellage Codex launch contract: PASS\n'

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
jq -se --arg hve "$hve_home" --arg superpowers "$superpowers_home" '
  length == 8
  and all(.[0:4][]; .codexHome == $hve)
  and all(.[4:8][]; .codexHome == $superpowers)
  and all(.[]; (.args | join(" ") | test(" add | remove | upgrade ") | not))
' "$fixture_root/fake-codex.log" >/dev/null || fail 'setup --all order or idempotence differs'

# Every top-level lifecycle action shares the launch lock. Each contender must
# reach the lock, remain blocked without native lifecycle activity, then finish
# after the held launch releases it.
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

assert_lifecycle_waits_for_launch() {
  local label="$1" hold_dir="$fixture_root/lifecycle-lock-$1"
  local launch_pid launch_group contender_pid wait_count before_calls after_calls
  local launch_status=0 contender_status=0
  shift

  mkdir "$hold_dir"
  : >"$fixture_root/fake-codex.log"
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    FAKE_CODEX_OVERLAP_DIR="$hold_dir" \
    "$fixture_launcher" hve --version >"$hold_dir/launch.out" 2>&1 &
  launch_pid=$!
  track_async_pid "$launch_pid"
  wait_count=0
  while [ ! -f "$hold_dir/first-started" ] && [ "$wait_count" -lt 100 ]; do
    sleep 0.05
    wait_count=$((wait_count + 1))
  done
  [ -f "$hold_dir/first-started" ] \
    || fail "$label held launch did not start"
  launch_group="$(cat "$hold_dir/first-child.pid")"
  track_async_group "$launch_group"
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
    || fail "$label did not wait for the held launch"
  after_calls="$(wc -l <"$fixture_root/fake-codex.log" | tr -d ' ')"
  [ "$after_calls" = "$before_calls" ] \
    || fail "$label invoked native lifecycle activity while launch held the lock"

  : >"$hold_dir/release-first"
  wait "$launch_pid" || launch_status=$?
  wait "$contender_pid" || contender_status=$?
  [ "$launch_status" -eq 0 ] || fail "$label held launch failed"
  [ "$contender_status" -eq 0 ] \
    || fail "$label did not proceed after launch lock release"
  [ ! -e "$hve_home/.launch.lock" ] && [ ! -L "$hve_home/.launch.lock" ] \
    || fail "$label left profile launch lock state"
  [ ! -e "$hve_home/.launch-lock-reap" ] \
    && [ ! -L "$hve_home/.launch-lock-reap" ] \
    || fail "$label left profile launch lock recovery state"
  untrack_async_pid "$launch_pid"
  untrack_async_group "$launch_group"
  untrack_async_pid "$contender_pid"
}

assert_lifecycle_waits_for_launch doctor doctor hve
assert_lifecycle_waits_for_launch update update hve
assert_lifecycle_waits_for_launch setup setup hve
assert_lifecycle_waits_for_launch repair repair hve
assert_lifecycle_waits_for_launch update-check update --check hve

# Launch is isolated from lifecycle mutations and network fetches.
: >"$fixture_root/fake-codex.log"
rm -f "$fixture_root/fake-curl.log"
write_isolation_snapshot launch-ordinary
HOME="$fixture_root/home" fake_env "$fixture_launcher" superpowers --version \
  || fail 'superpowers launch failed'
assert_isolation_snapshot_unchanged launch-ordinary
jq -se '
  length == 1
  and .[0].args == ["--dangerously-bypass-approvals-and-sandbox","--version"]
' "$fixture_root/fake-codex.log" >/dev/null || fail 'launch lifecycle isolation differs'
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
  and (map(select(.args[0] == "--dangerously-bypass-approvals-and-sandbox")) | length) == 0
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
  --arg home "$fixture_root/home" --arg cwd "$original_cwd" '
  . == [
    {
      codexHome: $host,
      home: $home,
      cwd: $cwd,
      args: ["login","status"]
    },
    {
      codexHome: $profile,
      home: $home,
      cwd: $cwd,
      args: ["plugin","list","--json"]
    },
    {
      codexHome: $profile,
      home: $home,
      cwd: $cwd,
      args: [
        "--dangerously-bypass-approvals-and-sandbox",
        "-c", "model_provider=\"openai\"",
        "-m", "gpt-5.5", "exec", "--json", "hello world"
      ]
    }
  ]
' "$fixture_root/fake-codex.log" >/dev/null \
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
    map(select(.args[0] == "--dangerously-bypass-approvals-and-sandbox")) | length == 0
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
  map(select(.args[0] == "--dangerously-bypass-approvals-and-sandbox")) | length == 0
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
jq -se '
  length == 2
  and .[0].args == ["plugin","list","--json"]
  and .[1].args == ["--dangerously-bypass-approvals-and-sandbox","--version"]
' "$fixture_root/fake-codex.log" >/dev/null \
  || fail 'launch with preserved authentication injected a provider override'
[ "$(shasum -a 256 "$hve_home/auth.json" | awk '{print $1}')" = "$profile_auth_hash" ] \
  || fail 'default launch changed profile authentication bytes'
[ "$(file_inode "$hve_home/auth.json")" = "$profile_auth_inode" ] \
  || fail 'default launch replaced profile authentication'
[ "$(file_mode "$hve_home/auth.json")" = '600' ] \
  || fail 'default launch changed profile authentication mode'

printf 'trellage Codex lifecycle contract: PASS\n'

[ "$(grep -Fc -- '3.3.101' "$fixture_launcher")" -eq 0 ] \
  || fail 'launcher duplicates the HVE adapter version literal'
[ "$(grep -Fc -- 'https://github.com/obra/superpowers.git' "$fixture_launcher")" -eq 1 ] \
  || fail 'launcher does not centralize the Superpowers plugin repository'

restore_catalog() {
  cp "$catalog" "$fixture_catalog" || fail 'could not restore copied catalog'
}

assert_invalid_catalog_command() {
  label="$1"
  shift
  command_name="$1"
  shift
  output="$fixture_root/invalid-catalog-$label-$command_name.out"
  if HOME="$fixture_root/home" PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" "$@" >"$output" 2>&1; then
    fail "untrusted catalog accepted for $label via $command_name"
  else
    status=$?
    [ "$status" -eq 1 ] || fail "untrusted catalog exit for $label via $command_name was $status, expected 1"
  fi
  grep -F -- 'cdx: invalid catalog:' "$output" >/dev/null \
    || fail "untrusted catalog was not rejected for $label via $command_name"
  grep -F -- 'not implemented' "$output" >/dev/null \
    && fail "untrusted catalog reached deferred path for $label via $command_name"
}

assert_catalog_rejected() {
  label="$1"
  rm -f "$fixture_root/fake-codex.log"
  assert_invalid_catalog_command "$label" list list
  assert_invalid_catalog_command "$label" deferred setup hve
  [ ! -e "$fixture_root/fake-codex.log" ] || fail "untrusted catalog invoked fake Codex for $label"
}

mutate_catalog() {
  label="$1"
  filter="$2"
  restore_catalog
  jq "$filter" "$fixture_catalog" >"$fixture_root/$label.json" \
    || fail "could not create $label catalog"
  mv "$fixture_root/$label.json" "$fixture_catalog"
  assert_catalog_rejected "$label"
}

restore_catalog
printf '{\n' >"$fixture_catalog"
assert_catalog_rejected malformed-json

restore_catalog
: >"$fixture_catalog"
assert_catalog_rejected zero-documents

restore_catalog
printf '\n' >>"$fixture_catalog"
cat "$catalog" >>"$fixture_catalog"
assert_catalog_rejected multiple-documents

mutate_catalog renamed-profile '.profiles.renamed = .profiles.hve | del(.profiles.hve)'
mutate_catalog missing-profile 'del(.profiles.hve)'
mutate_catalog extra-profile '.profiles.extra = .profiles.hve'
mutate_catalog changed-source '.profiles.hve.marketplaceSource = "other/source"'
mutate_catalog changed-kind '.profiles.hve.marketplaceKind = "git"'
mutate_catalog changed-name '.profiles.hve.marketplaceName = "other-marketplace"'
mutate_catalog changed-manifest '.profiles.hve.manifestUrl = "https://example.com/marketplace.json"'
mutate_catalog changed-upstream-repository '.profiles.hve.upstreamRepository = "https://example.com/hve.git"'
mutate_catalog changed-upstream-path '.profiles.hve.upstreamSkillsPath = ".github/other"'
mutate_catalog changed-plugin '.profiles.hve.plugin = "other@hve-core"'
mutate_catalog wrong-type '.profiles.hve.plugin = 1'
mutate_catalog extra-profile-field '.profiles.hve.untrusted = "value"'
mutate_catalog changed-superpowers-source '.profiles.superpowers.marketplaceSource = "other/source"'
mutate_catalog changed-superpowers-kind '.profiles.superpowers.marketplaceKind = "local-adapter"'
mutate_catalog changed-superpowers-name '.profiles.superpowers.marketplaceName = "other-marketplace"'
mutate_catalog changed-superpowers-manifest '.profiles.superpowers.manifestUrl = "https://example.com/marketplace.json"'
mutate_catalog changed-superpowers-plugin '.profiles.superpowers.plugin = "other@superpowers-marketplace"'
mutate_catalog extra-superpowers-field '.profiles.superpowers.untrusted = "value"'

printf 'trellage Codex catalog contract: PASS\n'

install_script="$root/install.sh"
uninstall_script="$root/uninstall.sh"
[ -f "$install_script" ] || fail 'install.sh is missing'
[ -f "$uninstall_script" ] || fail 'uninstall.sh is missing'

path_mode() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) stat -f '%Lp' "$1" ;;
    Linux) stat -c '%a' "$1" ;;
    *) return 1 ;;
  esac
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}' || return
  else
    sha256sum "$1" | awk '{print $1}' || return
  fi
}

assert_install_line() {
  grep -Fx -- "$1" "$2" >/dev/null || fail "missing exact line: $1"
}

assert_install_text() {
  grep -F -- "$1" "$2" >/dev/null || fail "missing text: $1"
}

printf 'assertion sentinel\n' >"$fixture_root/install-assertion-self-check"
assert_install_line 'assertion sentinel' "$fixture_root/install-assertion-self-check"
if (assert_install_line 'missing sentinel' \
  "$fixture_root/install-assertion-self-check") 2>/dev/null; then
  fail 'installation assertion helper accepted a missing line'
fi

readme="$root/README.md"
[ -f "$readme" ] || fail 'README.md is missing'
assert_install_text '~/.local/share/trellage/profiles/codex/<profile>/home/' "$readme"
assert_install_text '~/.local/share/trellage/profiles/copilot/<profile>/home/' "$readme"
assert_install_text '~/.local/share/trellage/profiles/grok/<profile>/home/' "$readme"
assert_install_text 'cdx setup --all' "$readme"
assert_install_text 'cdx --native-auth hve exec "Review this repository"' "$readme"
assert_install_text '`--dangerously-bypass-approvals-and-sandbox`' "$readme"
assert_install_text 'MCP servers are profile-local.' "$readme"
assert_install_text 'do not require or copy `~/.codex/auth.json`.' "$readme"
assert_install_text 'only the selected profile' "$readme"
assert_install_text 'Missing or invalid native auth fails without proxy fallback.' "$readme"
assert_install_text 'official whole-repository Git source `https://github.com/microsoft/hve-core.git`' "$readme"
assert_install_text 'with `.github/skills` fallback metadata.' "$readme"
assert_install_text 'HVE update deliberately removes and reinstalls' "$readme"
assert_install_line 'Doctor performs no native marketplace/plugin mutation, but may atomically remove only exact Codex-generated project-trust stanzas during stale recovery.' "$readme"
assert_install_text 'Reload Fish after install' "$readme"
assert_install_text 'It preserves every Codex profile home' "$readme"
assert_install_text 'existing readable, writable, regular' "$readme"
assert_install_text 'non-symlink `~/.config/fish/config.fish`' "$readme"
assert_install_text 'sequential atomic renames with guarded' "$readme"
assert_install_text 'Fish with' "$readme"
assert_install_text '`fish_indent`' "$readme"
assert_install_text 'explicit literal `cdx` alias or function' "$readme"
assert_install_text 'installation preserves' "$readme"
assert_install_text 'records that no line was removed' "$readme"
assert_install_text 'uninstall preserves that state and does not add a line' "$readme"
assert_install_text 'Dynamic or escaped alias/function names' "$readme"
assert_install_text 'Dynamic command names, `eval`, sourced files, and runtime function calls' "$readme"

assert_no_install_staging() {
  fixture_home="$1"
  staging_paths="$(find "$fixture_home" \( -name '.cdx-install.*' -o -name '.cdx-command.*' \
    -o -name '.cdx-fish.*' -o -name '.cdx-uninstall.*' \
    -o -name '.cdx-uninstall-command.*' -o -name '.cdx-uninstall-fish.*' \
    \) -print)" || fail "could not inspect installation staging beneath $fixture_home"
  [ -z "$staging_paths" ] \
    || fail "installation staging debris remains beneath $fixture_home: $staging_paths"
}

write_directory_topology() {
  topology_home="$1"
  topology_output="$2"
  find "$topology_home" -type d -print \
    | sed "s|^$topology_home||" \
    | LC_ALL=C sort >"$topology_output" \
    || fail "could not record directory topology beneath $topology_home"
}

write_owned_runtime_snapshot() {
  snapshot_root="$1"
  snapshot_output="$2"
  (
    CDPATH= cd -- "$snapshot_root"
    find . -print | LC_ALL=C sort | while IFS= read -r entry; do
      if [ -L "$entry" ]; then
        printf 'l\t%s\t%s\t%s\n' \
          "$(path_mode "$entry")" "$entry" "$(readlink "$entry")"
      elif [ -f "$entry" ]; then
        printf 'f\t%s\t%s\t%s\n' \
          "$(path_mode "$entry")" "$entry" "$(sha256_file "$entry")"
      elif [ -d "$entry" ]; then
        printf 'd\t%s\t%s\n' "$(path_mode "$entry")" "$entry"
      else
        fail "unsupported runtime entry in snapshot: $entry"
      fi
    done
  ) >"$snapshot_output" \
    || fail "could not snapshot owned runtime: $snapshot_root"
}

write_legacy_fish() {
  fixture_home="$1"
  mkdir -p "$fixture_home/.config/fish"
  printf '%s\n' \
    '# preserved before' \
    'set -gx TRELLAGE_FISH_SENTINEL "sp ace"' \
    'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
    '# preserved after' >"$fixture_home/.config/fish/config.fish"
  chmod 0640 "$fixture_home/.config/fish/config.fish"
}

write_absent_definition_fish() {
  fixture_home="$1"
  mkdir -p "$fixture_home/.config/fish"
  printf '%s\n' \
    '# preserved without cdx before' \
    'set -gx TRELLAGE_FISH_SENTINEL "no cdx definition"' \
    '# preserved without cdx after' >"$fixture_home/.config/fish/config.fish"
  chmod 0640 "$fixture_home/.config/fish/config.fish"
}

assert_install_published() {
  fixture_home="$1"
  installed="$fixture_home/.local/share/trellage/cdx"
  command="$fixture_home/.local/bin/cdx"
  logical_home="$(CDPATH= cd -L -- "$fixture_home" && pwd -L)"
  [ -d "$installed" ] && [ ! -L "$installed" ] || fail 'managed runtime root was not published'
  cmp -s "$installed/.managed-by-trellage-codex-profiles" \
    <(printf 'trellage-codex-profiles-v1\n') || fail 'ownership marker differs'
  cmp -s "$installed/bin/cdx" "$launcher" || fail 'installed launcher bytes differ'
  cmp -s "$installed/catalog.json" "$catalog" || fail 'installed catalog bytes differ'
  cmp -s "$installed/marketplaces/hve-core/.agents/plugins/marketplace.json" \
    "$adapter" || fail 'installed HVE adapter bytes differ'
  [ -L "$command" ] || fail 'managed command is not a symlink'
  [ "$(readlink "$command")" = "$logical_home/.local/share/trellage/cdx/bin/cdx" ] \
    || fail 'managed command target differs'
}

clean_uninstall_home="$fixture_root/clean-uninstall-home"
mkdir -p "$clean_uninstall_home"
write_directory_topology "$clean_uninstall_home" \
  "$fixture_root/clean-uninstall.topology-before"
HOME="$clean_uninstall_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/clean-uninstall.out" \
  || fail 'uninstall rejected a clean HOME'
assert_install_line 'cdx is not installed; Codex profile homes were preserved.' \
  "$fixture_root/clean-uninstall.out"
write_directory_topology "$clean_uninstall_home" \
  "$fixture_root/clean-uninstall.topology-after"
cmp -s "$fixture_root/clean-uninstall.topology-before" \
  "$fixture_root/clean-uninstall.topology-after" \
  || fail 'clean HOME uninstall changed directory topology'

clean_collision_home="$fixture_root/clean-collision-home"
mkdir -p "$clean_collision_home/.local/bin"
printf 'unrelated command\n' >"$clean_collision_home/.local/bin/cdx"
if HOME="$clean_collision_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/clean-collision.out" 2>&1; then
  fail 'uninstall treated an unrelated command collision as not installed'
fi
assert_install_line 'unrelated command' "$clean_collision_home/.local/bin/cdx"

clean_symlink_home="$fixture_root/clean-symlink-home"
mkdir -p "$clean_symlink_home" "$fixture_root/clean-symlink-outside"
ln -s "$fixture_root/clean-symlink-outside" "$clean_symlink_home/.local"
if HOME="$clean_symlink_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/clean-symlink.out" 2>&1; then
  fail 'uninstall treated a symlinked parent collision as not installed'
fi
[ -L "$clean_symlink_home/.local" ] \
  || fail 'uninstall changed a symlinked parent collision'

install_home="$fixture_root/install-home"
mkdir -p "$install_home"
write_legacy_fish "$install_home"
fish_config="$install_home/.config/fish/config.fish"
cp "$fish_config" "$fixture_root/fish-before"
fish_before_hash="$(sha256_file "$fish_config")"
fish_before_mode="$(path_mode "$fish_config")"
HOME="$install_home" /bin/bash "$install_script" >"$fixture_root/install.out" \
  || fail 'fixture install failed'
assert_install_published "$install_home"
HOME="$install_home" "$install_home/.local/bin/cdx" list \
  >"$fixture_root/installed-list.out" 2>"$fixture_root/installed-list.err" \
  || fail "installed cdx list failed: $(cat "$fixture_root/installed-list.err")"
cmp -s "$fixture_root/installed-list.out" <(printf '%s\n' \
  $'hve\thve-core-all@hve-core' \
  $'superpowers\tsuperpowers@superpowers-marketplace') \
  || fail 'installed cdx list output differs'
ln -s cdx "$install_home/.local/bin/cdx-relative"
HOME="$install_home" "$install_home/.local/bin/cdx-relative" list \
  >"$fixture_root/relative-list.out" 2>"$fixture_root/relative-list.err" \
  || fail "relative symlink cdx list failed: $(cat "$fixture_root/relative-list.err")"
cmp -s "$fixture_root/relative-list.out" "$fixture_root/installed-list.out" \
  || fail 'relative symlink cdx list output differs'
rm "$install_home/.local/bin/cdx-relative"
printf '%s\n' \
  '# preserved before' \
  'set -gx TRELLAGE_FISH_SENTINEL "sp ace"' \
  '# preserved after' >"$fixture_root/fish-after-expected"
cmp -s "$fish_config" "$fixture_root/fish-after-expected" \
  || fail 'install changed Fish bytes other than the legacy alias'
[ "$(path_mode "$fish_config")" = "$fish_before_mode" ] || fail 'install changed Fish config mode'
recovery="$install_home/.local/share/trellage/cdx/.fish-recovery"
[ "$(sed -n '1p' "$recovery/original-mode")" = "$fish_before_mode" ] \
  || fail 'Fish recovery did not record original mode'
[ "$(sed -n '1p' "$recovery/sha256-before")" = "$fish_before_hash" ] \
  || fail 'Fish recovery did not record the pre-removal hash'
[ "$(sed -n '1p' "$recovery/sha256-after")" = "$(sha256_file "$fish_config")" ] \
  || fail 'Fish recovery did not record the post-removal hash'
cmp -s "$recovery/removed-line" \
  <(printf 'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"\n') \
  || fail 'Fish recovery did not record the exact removed line'
assert_no_install_staging "$install_home"

mkdir -p "$install_home/.local/share/trellage/profiles/codex/hve/home"
printf 'preserved profile\n' \
  >"$install_home/.local/share/trellage/profiles/codex/hve/home/sentinel"
HOME="$install_home" /bin/bash "$uninstall_script" >"$fixture_root/uninstall.out" \
  || fail 'fixture uninstall failed'
cmp -s "$fish_config" "$fixture_root/fish-before" || fail 'uninstall did not restore exact Fish bytes'
[ "$(path_mode "$fish_config")" = "$fish_before_mode" ] || fail 'uninstall did not restore Fish mode'
[ ! -e "$install_home/.local/share/trellage/cdx" ] || fail 'uninstall left managed runtime'
[ ! -e "$install_home/.local/bin/cdx" ] && [ ! -L "$install_home/.local/bin/cdx" ] \
  || fail 'uninstall left managed command'
assert_install_line 'preserved profile' \
  "$install_home/.local/share/trellage/profiles/codex/hve/home/sentinel"
assert_no_install_staging "$install_home"

absent_definition_home="$fixture_root/absent-definition-home"
mkdir -p "$absent_definition_home"
write_absent_definition_fish "$absent_definition_home"
absent_fish="$absent_definition_home/.config/fish/config.fish"
cp "$absent_fish" "$fixture_root/absent-definition.fish-before"
absent_fish_hash="$(sha256_file "$absent_fish")"
absent_fish_mode="$(path_mode "$absent_fish")"
HOME="$absent_definition_home" /bin/bash "$install_script" \
  >"$fixture_root/absent-definition-install.out" \
  || fail 'absent-definition fixture install failed'
assert_install_published "$absent_definition_home"
cmp -s "$absent_fish" "$fixture_root/absent-definition.fish-before" \
  || fail 'absent-definition install changed Fish bytes'
[ "$(path_mode "$absent_fish")" = "$absent_fish_mode" ] \
  || fail 'absent-definition install changed Fish mode'
absent_recovery="$absent_definition_home/.local/share/trellage/cdx/.fish-recovery"
cmp -s "$absent_recovery/config-before" "$fixture_root/absent-definition.fish-before" \
  || fail 'absent-definition recovery backup differs'
[ "$(sed -n '1p' "$absent_recovery/original-mode")" = "$absent_fish_mode" ] \
  || fail 'absent-definition recovery mode differs'
[ "$(sed -n '1p' "$absent_recovery/sha256-before")" = "$absent_fish_hash" ] \
  || fail 'absent-definition recovery pre-install hash differs'
[ "$(sed -n '1p' "$absent_recovery/sha256-after")" = "$absent_fish_hash" ] \
  || fail 'absent-definition recovery post-install hash differs'
[ ! -s "$absent_recovery/removed-line" ] \
  || fail 'absent-definition recovery recorded a removed Fish line'
assert_no_install_staging "$absent_definition_home"

mkdir "$fixture_root/absent-definition.recovery-before-reinstall"
cp "$absent_recovery/"* "$fixture_root/absent-definition.recovery-before-reinstall/"
HOME="$absent_definition_home" /bin/bash "$install_script" \
  >"$fixture_root/absent-definition-reinstall.out" \
  || fail 'absent-definition fixture reinstall failed'
cmp -s "$absent_fish" "$fixture_root/absent-definition.fish-before" \
  || fail 'absent-definition reinstall changed Fish bytes'
[ "$(path_mode "$absent_fish")" = "$absent_fish_mode" ] \
  || fail 'absent-definition reinstall changed Fish mode'
for name in config-before original-mode sha256-before sha256-after removed-line; do
  cmp -s "$absent_recovery/$name" \
    "$fixture_root/absent-definition.recovery-before-reinstall/$name" \
    || fail "absent-definition reinstall changed recovery $name"
done
assert_install_published "$absent_definition_home"
assert_no_install_staging "$absent_definition_home"

HOME="$absent_definition_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/absent-definition-uninstall.out" \
  || fail 'absent-definition fixture uninstall failed'
cmp -s "$absent_fish" "$fixture_root/absent-definition.fish-before" \
  || fail 'absent-definition uninstall changed Fish bytes'
[ "$(path_mode "$absent_fish")" = "$absent_fish_mode" ] \
  || fail 'absent-definition uninstall changed Fish mode'
[ ! -e "$absent_definition_home/.local/share/trellage/cdx" ] \
  || fail 'absent-definition uninstall left managed runtime'
[ ! -e "$absent_definition_home/.local/bin/cdx" ] \
  && [ ! -L "$absent_definition_home/.local/bin/cdx" ] \
  || fail 'absent-definition uninstall left managed command'
assert_no_install_staging "$absent_definition_home"

absent_origin_home="$fixture_root/absent-origin-owned-reinstall-home"
mkdir -p "$absent_origin_home"
write_absent_definition_fish "$absent_origin_home"
absent_origin_fish="$absent_origin_home/.config/fish/config.fish"
cp "$absent_origin_fish" "$fixture_root/absent-origin.original-fish"
HOME="$absent_origin_home" /bin/bash "$install_script" >/dev/null \
  || fail 'absent-origin fixture install failed'
absent_origin_runtime="$absent_origin_home/.local/share/trellage/cdx"
write_owned_runtime_snapshot "$absent_origin_runtime" \
  "$fixture_root/absent-origin.runtime-before-refused-reinstall"
absent_origin_command_target="$(readlink "$absent_origin_home/.local/bin/cdx")"
printf '%s\n' 'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
  >>"$absent_origin_fish"
cp "$absent_origin_fish" "$fixture_root/absent-origin.edited-fish"
if HOME="$absent_origin_home" /bin/bash "$install_script" \
  >"$fixture_root/absent-origin-refused-reinstall.out" 2>&1; then
  fail 'absent-origin owned reinstall accepted a newly added legacy alias'
fi
cmp -s "$absent_origin_fish" "$fixture_root/absent-origin.edited-fish" \
  || fail 'absent-origin refused reinstall changed Fish bytes'
write_owned_runtime_snapshot "$absent_origin_runtime" \
  "$fixture_root/absent-origin.runtime-after-refused-reinstall"
cmp -s "$fixture_root/absent-origin.runtime-before-refused-reinstall" \
  "$fixture_root/absent-origin.runtime-after-refused-reinstall" \
  || fail 'absent-origin refused reinstall changed runtime or recovery state'
[ -L "$absent_origin_home/.local/bin/cdx" ] \
  && [ "$(readlink "$absent_origin_home/.local/bin/cdx")" = \
    "$absent_origin_command_target" ] \
  || fail 'absent-origin refused reinstall changed managed command'
assert_no_install_staging "$absent_origin_home"

cp "$fixture_root/absent-origin.original-fish" "$absent_origin_fish"
chmod 0640 "$absent_origin_fish"
HOME="$absent_origin_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/absent-origin-uninstall.out" \
  || fail 'absent-origin uninstall failed after restoring unchanged Fish state'
cmp -s "$absent_origin_fish" "$fixture_root/absent-origin.original-fish" \
  || fail 'absent-origin uninstall added or restored a Fish definition'
[ ! -e "$absent_origin_home/.local/share/trellage/cdx" ] \
  || fail 'absent-origin uninstall left managed runtime'
[ ! -e "$absent_origin_home/.local/bin/cdx" ] \
  && [ ! -L "$absent_origin_home/.local/bin/cdx" ] \
  || fail 'absent-origin uninstall left managed command'
assert_no_install_staging "$absent_origin_home"

alias_origin_home="$fixture_root/alias-origin-owned-reinstall-home"
mkdir -p "$alias_origin_home"
write_legacy_fish "$alias_origin_home"
cp "$alias_origin_home/.config/fish/config.fish" \
  "$fixture_root/alias-origin.original-fish"
HOME="$alias_origin_home" /bin/bash "$install_script" >/dev/null \
  || fail 'alias-origin fixture install failed'
alias_origin_runtime="$alias_origin_home/.local/share/trellage/cdx"
write_owned_runtime_snapshot "$alias_origin_runtime" \
  "$fixture_root/alias-origin.runtime-before-reinstall"
HOME="$alias_origin_home" /bin/bash "$install_script" >/dev/null \
  || fail 'alias-origin owned reinstall failed'
write_owned_runtime_snapshot "$alias_origin_runtime" \
  "$fixture_root/alias-origin.runtime-after-reinstall"
cmp -s "$fixture_root/alias-origin.runtime-before-reinstall" \
  "$fixture_root/alias-origin.runtime-after-reinstall" \
  || fail 'alias-origin owned reinstall changed runtime or recovery state'
HOME="$alias_origin_home" /bin/bash "$uninstall_script" >/dev/null \
  || fail 'alias-origin uninstall failed after owned reinstall'
cmp -s "$alias_origin_home/.config/fish/config.fish" \
  "$fixture_root/alias-origin.original-fish" \
  || fail 'alias-origin owned reinstall lost legacy alias recovery metadata'
assert_no_install_staging "$alias_origin_home"

for failure_point in \
  after-runtime-staging \
  after-fish-staging \
  during-fish-publication \
  after-fish-publication \
  after-runtime-publication \
  after-command-publication; do
  absent_failure_home="$fixture_root/absent-definition-failure-$failure_point"
  mkdir -p "$absent_failure_home"
  write_absent_definition_fish "$absent_failure_home"
  cp "$absent_failure_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-$failure_point.fish-before"
  absent_failure_mode="$(path_mode "$absent_failure_home/.config/fish/config.fish")"
  write_directory_topology "$absent_failure_home" \
    "$fixture_root/absent-definition-$failure_point.topology-before"
  if HOME="$absent_failure_home" CDX_INSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$install_script" \
    >"$fixture_root/absent-definition-$failure_point.out" 2>&1; then
    fail "absent-definition injected install failure unexpectedly succeeded: $failure_point"
  fi
  assert_install_text "injected failure at $failure_point" \
    "$fixture_root/absent-definition-$failure_point.out"
  cmp -s "$absent_failure_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-$failure_point.fish-before" \
    || fail "absent-definition install rollback changed Fish bytes: $failure_point"
  [ "$(path_mode "$absent_failure_home/.config/fish/config.fish")" = \
    "$absent_failure_mode" ] \
    || fail "absent-definition install rollback changed Fish mode: $failure_point"
  [ ! -e "$absent_failure_home/.local/share/trellage/cdx" ] \
    || fail "absent-definition install rollback left runtime: $failure_point"
  [ ! -e "$absent_failure_home/.local/bin/cdx" ] \
    && [ ! -L "$absent_failure_home/.local/bin/cdx" ] \
    || fail "absent-definition install rollback left command: $failure_point"
  assert_no_install_staging "$absent_failure_home"
  write_directory_topology "$absent_failure_home" \
    "$fixture_root/absent-definition-$failure_point.topology-after"
  cmp -s "$fixture_root/absent-definition-$failure_point.topology-before" \
    "$fixture_root/absent-definition-$failure_point.topology-after" \
    || fail "absent-definition install rollback changed topology: $failure_point"
done

for failure_point in \
  after-runtime-staging \
  after-fish-staging \
  during-fish-publication \
  after-fish-publication \
  after-runtime-publication \
  after-command-publication; do
  absent_reinstall_home="$fixture_root/absent-definition-reinstall-$failure_point"
  mkdir -p "$absent_reinstall_home"
  write_absent_definition_fish "$absent_reinstall_home"
  HOME="$absent_reinstall_home" /bin/bash "$install_script" >/dev/null \
    || fail "absent-definition reinstall rollback fixture install failed: $failure_point"
  cp "$absent_reinstall_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-reinstall-$failure_point.fish-before"
  mkdir "$fixture_root/absent-definition-reinstall-$failure_point.recovery"
  cp "$absent_reinstall_home/.local/share/trellage/cdx/.fish-recovery/"* \
    "$fixture_root/absent-definition-reinstall-$failure_point.recovery/"
  if HOME="$absent_reinstall_home" CDX_INSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$install_script" \
    >"$fixture_root/absent-definition-reinstall-$failure_point.out" 2>&1; then
    fail "absent-definition injected reinstall failure unexpectedly succeeded: $failure_point"
  fi
  assert_install_text "injected failure at $failure_point" \
    "$fixture_root/absent-definition-reinstall-$failure_point.out"
  cmp -s "$absent_reinstall_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-reinstall-$failure_point.fish-before" \
    || fail "absent-definition reinstall rollback changed Fish bytes: $failure_point"
  for name in config-before original-mode sha256-before sha256-after removed-line; do
    cmp -s "$absent_reinstall_home/.local/share/trellage/cdx/.fish-recovery/$name" \
      "$fixture_root/absent-definition-reinstall-$failure_point.recovery/$name" \
      || fail "absent-definition reinstall rollback changed recovery $name: $failure_point"
  done
  assert_install_published "$absent_reinstall_home"
  assert_no_install_staging "$absent_reinstall_home"
done

for failure_point in \
  during-fish-publication \
  after-fish-publication \
  after-command-removal \
  after-runtime-removal; do
  absent_uninstall_home="$fixture_root/absent-definition-uninstall-$failure_point"
  mkdir -p "$absent_uninstall_home"
  write_absent_definition_fish "$absent_uninstall_home"
  HOME="$absent_uninstall_home" /bin/bash "$install_script" >/dev/null \
    || fail "absent-definition uninstall rollback fixture install failed: $failure_point"
  cp "$absent_uninstall_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-uninstall-$failure_point.fish-before"
  absent_uninstall_mode="$(path_mode "$absent_uninstall_home/.config/fish/config.fish")"
  if HOME="$absent_uninstall_home" CDX_UNINSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$uninstall_script" \
    >"$fixture_root/absent-definition-uninstall-$failure_point.out" 2>&1; then
    fail "absent-definition injected uninstall failure unexpectedly succeeded: $failure_point"
  fi
  assert_install_text "injected failure at $failure_point" \
    "$fixture_root/absent-definition-uninstall-$failure_point.out"
  cmp -s "$absent_uninstall_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-uninstall-$failure_point.fish-before" \
    || fail "absent-definition uninstall rollback changed Fish bytes: $failure_point"
  [ "$(path_mode "$absent_uninstall_home/.config/fish/config.fish")" = \
    "$absent_uninstall_mode" ] \
    || fail "absent-definition uninstall rollback changed Fish mode: $failure_point"
  assert_install_published "$absent_uninstall_home"
  assert_no_install_staging "$absent_uninstall_home"
done

for conflict_kind in \
  alias \
  function \
  hash-in-token \
  continued-alias \
  and-alias \
  or-alias \
  not-alias \
  repeated-prefix-alias \
  andand-alias \
  oror-alias \
  time-alias \
  and-function \
  repeated-prefix-function \
  escaped-alias \
  escaped-hex-alias \
  escaped-function \
  escaped-hex-function; do
  conflict_home="$fixture_root/conflict-$conflict_kind"
  mkdir -p "$conflict_home/.config/fish"
  case "$conflict_kind" in
    alias) printf '%s\n' 'alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    function) printf '%s\n' 'function cdx; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
    hash-in-token) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'echo foo#bar; alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    continued-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'alias \' \
      'cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    and-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'true; and alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    or-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'false; or alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    not-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'not alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    repeated-prefix-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'true; and not not alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    andand-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'true && alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    oror-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'false || alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    time-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'time alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    and-function) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'true; and function cdx; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
    repeated-prefix-function) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'false; or not not function cdx; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
    escaped-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'alias c\dx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    escaped-hex-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'alias c\x64x="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    escaped-function) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'function c\dx; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
    escaped-hex-function) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'function c\x64x; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
  esac
  cp "$conflict_home/.config/fish/config.fish" "$fixture_root/conflict-$conflict_kind.before"
  if HOME="$conflict_home" /bin/bash "$install_script" \
    >"$fixture_root/conflict-$conflict_kind.out" 2>&1; then
    fail "install accepted a different cdx $conflict_kind"
  fi
  cmp -s "$conflict_home/.config/fish/config.fish" \
    "$fixture_root/conflict-$conflict_kind.before" || fail "rejected $conflict_kind was changed"
  [ ! -e "$conflict_home/.local/share/trellage/cdx" ] \
    || fail "rejected $conflict_kind published runtime"
  assert_no_install_staging "$conflict_home"
done

incompatible_fish_home="$fixture_root/incompatible-fish-home"
incompatible_fish_bin="$fixture_root/incompatible-fish-bin"
mkdir -p "$incompatible_fish_home" "$incompatible_fish_bin"
write_legacy_fish "$incompatible_fish_home"
cat >"$incompatible_fish_bin/fish_indent" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '<not-fish-indent-html>'
EOF
chmod +x "$incompatible_fish_bin/fish_indent"
if PATH="$incompatible_fish_bin:$PATH" HOME="$incompatible_fish_home" \
  /bin/bash "$install_script" >"$fixture_root/incompatible-fish.out" 2>&1; then
  fail 'install accepted incompatible fish_indent semantic output'
fi
cmp -s "$incompatible_fish_home/.config/fish/config.fish" \
  "$fixture_root/fish-before" \
  || fail 'incompatible fish_indent changed Fish config'
assert_no_install_staging "$incompatible_fish_home"

analysis_signal_home="$fixture_root/analysis-signal-home"
analysis_signal_bin="$fixture_root/analysis-signal-bin"
analysis_signal_tmp="$fixture_root/analysis-signal-tmp"
mkdir -p "$analysis_signal_home" "$analysis_signal_bin" "$analysis_signal_tmp"
write_legacy_fish "$analysis_signal_home"
cat >"$analysis_signal_bin/fish_indent" <<'EOF'
#!/usr/bin/env bash
kill -HUP "$PPID"
exit 129
EOF
chmod +x "$analysis_signal_bin/fish_indent"
if TMPDIR="$analysis_signal_tmp" PATH="$analysis_signal_bin:$PATH" \
  HOME="$analysis_signal_home" \
  /bin/bash "$install_script" >"$fixture_root/analysis-signal.out" 2>&1; then
  fail 'analysis-signal install unexpectedly succeeded'
fi
if find "$analysis_signal_tmp" -mindepth 1 -print -quit | grep -q .; then
  fail 'Fish analysis signal left temporary state'
fi
cmp -s "$analysis_signal_home/.config/fish/config.fish" \
  "$fixture_root/fish-before" \
  || fail 'Fish analysis signal changed Fish config'
assert_no_install_staging "$analysis_signal_home"

for conflict_kind in alias-save alias-short-save alias-wraps function-description function-wraps; do
  conflict_home="$fixture_root/option-conflict-$conflict_kind"
  mkdir -p "$conflict_home/.config/fish"
  {
    printf '%s\n' 'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"'
    case "$conflict_kind" in
      alias-save) printf '%s\n' 'alias --save cdx="codex --ask-for-approval"' ;;
      alias-short-save) printf '%s\n' 'alias -s cdx="codex --ask-for-approval"' ;;
      alias-wraps) printf '%s\n' 'alias --wraps codex cdx="codex --ask-for-approval"' ;;
      function-description) printf '%s\n' 'function cdx --description custom; codex $argv; end' ;;
      function-wraps) printf '%s\n' 'function cdx --wraps codex; codex $argv; end' ;;
    esac
  } >"$conflict_home/.config/fish/config.fish"
  cp "$conflict_home/.config/fish/config.fish" \
    "$fixture_root/option-conflict-$conflict_kind.before"
  write_directory_topology "$conflict_home" \
    "$fixture_root/option-conflict-$conflict_kind.topology"
  if HOME="$conflict_home" /bin/bash "$install_script" \
    >"$fixture_root/option-conflict-$conflict_kind.out" 2>&1; then
    fail "install accepted option-bearing cdx definition: $conflict_kind"
  fi
  cmp -s "$conflict_home/.config/fish/config.fish" \
    "$fixture_root/option-conflict-$conflict_kind.before" \
    || fail "rejected option-bearing definition changed Fish: $conflict_kind"
  write_directory_topology "$conflict_home" \
    "$fixture_root/option-conflict-$conflict_kind.after-topology"
  cmp -s "$fixture_root/option-conflict-$conflict_kind.topology" \
    "$fixture_root/option-conflict-$conflict_kind.after-topology" \
    || fail "rejected option-bearing definition changed topology: $conflict_kind"
done

non_definition_home="$fixture_root/non-definition-cdx-text"
mkdir -p "$non_definition_home/.config/fish"
printf '%s\n' \
  '# alias --save cdx="not a definition"' \
  'set -g cdx_note '\''alias --save cdx="not a definition"'\''' \
  'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
  >"$non_definition_home/.config/fish/config.fish"
HOME="$non_definition_home" /bin/bash "$install_script" >/dev/null \
  || fail 'install treated comment or quoted cdx text as a definition'
assert_install_published "$non_definition_home"

non_cdx_definition_home="$fixture_root/non-cdx-definitions"
mkdir -p "$non_cdx_definition_home/.config/fish"
printf '%s\n' \
  'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
  'alias foo cdx' \
  'alias --wraps cdx foo="codex --ask-for-approval"' \
  'alias --wraps=cdx bar="codex --ask-for-approval"' \
  'alias --help cdx' \
  'alias -h cdx' \
  'alias -sh cdx' \
  'alias -hs cdx' \
  'function --help cdx' \
  'function -h cdx' \
  'function foo --description cdx; echo harmless; end' \
  'function bar --description=cdx; echo harmless; end' \
  'function baz --wraps cdx; echo harmless; end' \
  'alias escaped-body="echo c\dx"' \
  'function escaped-body; echo c\dx; end' \
  'echo and alias cdx="not a command"' \
  'not echo alias cdx="not a command"' \
  'true; and echo alias cdx="not a command"' \
  'echo harmless\; alias cdx="not a command"' \
  'echo '\''harmless; alias cdx="not a command"'\''' \
  >"$non_cdx_definition_home/.config/fish/config.fish"
HOME="$non_cdx_definition_home" /bin/bash "$install_script" >/dev/null \
  || fail 'install treated an option value or alias body as the cdx definition name'
assert_install_published "$non_cdx_definition_home"

for separator_kind in alias function alias-after-double-dash; do
  separator_home="$fixture_root/separator-conflict-$separator_kind"
  mkdir -p "$separator_home/.config/fish"
  case "$separator_kind" in
    alias)
      printf '%s\n' \
        'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
        'echo harmless; alias --save cdx="codex --ask-for-approval"' \
        >"$separator_home/.config/fish/config.fish"
      ;;
    function)
      printf '%s\n' \
        'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
        'echo harmless; function cdx --wraps codex; codex $argv; end' \
        >"$separator_home/.config/fish/config.fish"
      ;;
    alias-after-double-dash)
      printf '%s\n' \
        'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
        'echo harmless; alias --save -- cdx="codex --ask-for-approval"' \
        >"$separator_home/.config/fish/config.fish"
      ;;
  esac
  cp "$separator_home/.config/fish/config.fish" \
    "$fixture_root/separator-conflict-$separator_kind.before"
  if HOME="$separator_home" /bin/bash "$install_script" \
    >"$fixture_root/separator-conflict-$separator_kind.out" 2>&1; then
    fail "install accepted cdx definition after command separator: $separator_kind"
  fi
  cmp -s "$separator_home/.config/fish/config.fish" \
    "$fixture_root/separator-conflict-$separator_kind.before" \
    || fail "separator conflict changed Fish bytes: $separator_kind"
done

for failure_point in \
  after-runtime-staging \
  after-fish-staging \
  during-fish-publication \
  after-fish-publication \
  after-runtime-publication \
  after-command-publication; do
  failure_home="$fixture_root/failure-$failure_point"
  mkdir -p "$failure_home"
  write_legacy_fish "$failure_home"
  write_directory_topology "$failure_home" "$fixture_root/$failure_point.topology-before"
  cp "$failure_home/.config/fish/config.fish" "$fixture_root/$failure_point.fish-before"
  failure_mode="$(path_mode "$failure_home/.config/fish/config.fish")"
  if HOME="$failure_home" CDX_INSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$install_script" >"$fixture_root/$failure_point.out" 2>&1; then
    fail "injected install failure unexpectedly succeeded: $failure_point"
  fi
  cmp -s "$failure_home/.config/fish/config.fish" "$fixture_root/$failure_point.fish-before" \
    || fail "Fish bytes changed after injected failure: $failure_point"
  [ "$(path_mode "$failure_home/.config/fish/config.fish")" = "$failure_mode" ] \
    || fail "Fish mode changed after injected failure: $failure_point"
  [ ! -e "$failure_home/.local/share/trellage/cdx" ] \
    || fail "runtime remained after injected failure: $failure_point"
  [ ! -e "$failure_home/.local/bin/cdx" ] && [ ! -L "$failure_home/.local/bin/cdx" ] \
    || fail "command remained after injected failure: $failure_point"
  assert_no_install_staging "$failure_home"
  write_directory_topology "$failure_home" "$fixture_root/$failure_point.topology-after"
  cmp -s "$fixture_root/$failure_point.topology-before" \
    "$fixture_root/$failure_point.topology-after" \
    || fail "directory topology changed after injected failure: $failure_point"
done

preexisting_parent_home="$fixture_root/preexisting-parent-home"
write_legacy_fish "$preexisting_parent_home"
mkdir -p "$preexisting_parent_home/.local/bin" \
  "$preexisting_parent_home/.local/share/trellage"
printf 'keep bin\n' >"$preexisting_parent_home/.local/bin/keep"
printf 'keep runtime parent\n' >"$preexisting_parent_home/.local/share/trellage/keep"
write_directory_topology "$preexisting_parent_home" \
  "$fixture_root/preexisting-parent.topology-before"
if HOME="$preexisting_parent_home" CDX_INSTALL_TEST_FAIL_AT=after-fish-staging \
  /bin/bash "$install_script" >"$fixture_root/preexisting-parent.out" 2>&1; then
  fail 'pre-existing parent failure injection unexpectedly succeeded'
fi
write_directory_topology "$preexisting_parent_home" \
  "$fixture_root/preexisting-parent.topology-after"
cmp -s "$fixture_root/preexisting-parent.topology-before" \
  "$fixture_root/preexisting-parent.topology-after" \
  || fail 'failed install changed pre-existing parent topology'
assert_install_line 'keep bin' "$preexisting_parent_home/.local/bin/keep"
assert_install_line 'keep runtime parent' \
  "$preexisting_parent_home/.local/share/trellage/keep"

for failure_point in \
  after-runtime-staging \
  after-fish-staging \
  during-fish-publication \
  after-fish-publication \
  after-runtime-publication \
  after-command-publication; do
  reinstall_home="$fixture_root/reinstall-$failure_point"
  mkdir -p "$reinstall_home"
  write_legacy_fish "$reinstall_home"
  HOME="$reinstall_home" /bin/bash "$install_script" >/dev/null \
    || fail "reinstall rollback fixture install failed: $failure_point"
  write_directory_topology "$reinstall_home" \
    "$fixture_root/reinstall-$failure_point.topology-before"
  cp "$reinstall_home/.config/fish/config.fish" \
    "$fixture_root/reinstall-$failure_point.fish-before"
  mkdir "$fixture_root/reinstall-$failure_point.recovery"
  cp "$reinstall_home/.local/share/trellage/cdx/.fish-recovery/"* \
    "$fixture_root/reinstall-$failure_point.recovery/"
  if HOME="$reinstall_home" CDX_INSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$install_script" >"$fixture_root/reinstall-$failure_point.out" 2>&1; then
    fail "injected reinstall failure unexpectedly succeeded: $failure_point"
  fi
  cmp -s "$reinstall_home/.config/fish/config.fish" \
    "$fixture_root/reinstall-$failure_point.fish-before" \
    || fail "reinstall rollback changed Fish bytes: $failure_point"
  for name in config-before original-mode sha256-before sha256-after removed-line; do
    cmp -s "$reinstall_home/.local/share/trellage/cdx/.fish-recovery/$name" \
      "$fixture_root/reinstall-$failure_point.recovery/$name" \
      || fail "reinstall rollback changed recovery $name: $failure_point"
  done
  assert_install_published "$reinstall_home"
  assert_no_install_staging "$reinstall_home"
  write_directory_topology "$reinstall_home" \
    "$fixture_root/reinstall-$failure_point.topology-after"
  cmp -s "$fixture_root/reinstall-$failure_point.topology-before" \
    "$fixture_root/reinstall-$failure_point.topology-after" \
    || fail "reinstall rollback changed directory topology: $failure_point"
done

signal_mv_bin="$fixture_root/signal-mv-bin"
mkdir "$signal_mv_bin"
real_mv="$(command -v mv)" || fail 'could not resolve real mv for signal rollback tests'
cat >"$signal_mv_bin/mv" <<'EOF'
#!/usr/bin/env bash
set -u

source_path="$1"
destination_path="$2"
"$CDX_TEST_REAL_MV" "$@" || exit $?

case "$CDX_TEST_SIGNAL_MV:$source_path:$destination_path" in
  install-fish-old:*/.config/fish/config.fish:*/.config/fish/.cdx-fish.*|\
  install-fish-new:*/.config/fish/.cdx-fish.*:*/.config/fish/config.fish|\
  install-runtime-old:*/.local/share/trellage/cdx:*/.cdx-install.*/old-runtime|\
  install-runtime-new:*/.cdx-install.*/new-runtime:*/.local/share/trellage/cdx|\
  install-command-old:*/.local/bin/cdx:*/.cdx-command.*/old-command|\
  install-command-new:*/.cdx-command.*/new-command:*/.local/bin/cdx|\
  uninstall-fish-old:*/.config/fish/config.fish:*/.config/fish/.cdx-uninstall-fish.*|\
  uninstall-fish-new:*/.config/fish/.cdx-uninstall-fish.*:*/.config/fish/config.fish|\
  uninstall-command:*/.local/bin/cdx:*/.cdx-uninstall-command.*/command|\
  uninstall-runtime:*/.local/share/trellage/cdx:*/.cdx-uninstall.*/runtime)
    if [ ! -e "$CDX_TEST_SIGNAL_ONCE" ]; then
      : >"$CDX_TEST_SIGNAL_ONCE"
      kill -s "$CDX_TEST_SIGNAL_NAME" "$PPID"
    fi
    ;;
esac
EOF
chmod +x "$signal_mv_bin/mv"

for signal_name in TERM INT HUP; do
for signal_boundary in \
  install-fish-old \
  install-fish-new \
  install-runtime-old \
  install-runtime-new \
  install-command-old \
  install-command-new; do
  signal_home="$fixture_root/signal-$signal_name-$signal_boundary"
  mkdir -p "$signal_home"
  write_legacy_fish "$signal_home"
  case "$signal_boundary" in
    install-runtime-old|install-command-old)
      HOME="$signal_home" /bin/bash "$install_script" >/dev/null \
        || fail "could not prepare reinstall signal fixture: $signal_boundary"
      ;;
  esac
  cp "$signal_home/.config/fish/config.fish" \
    "$fixture_root/$signal_boundary.fish-before"
  write_directory_topology "$signal_home" \
    "$fixture_root/$signal_boundary.topology-before"
  if PATH="$signal_mv_bin:$PATH" CDX_TEST_REAL_MV="$real_mv" \
    CDX_TEST_SIGNAL_MV="$signal_boundary" \
    CDX_TEST_SIGNAL_NAME="$signal_name" \
    CDX_TEST_SIGNAL_ONCE="$fixture_root/$signal_name-$signal_boundary.signaled" \
    HOME="$signal_home" \
    /bin/bash "$install_script" >"$fixture_root/$signal_boundary.out" 2>&1; then
    fail "signal-boundary install unexpectedly succeeded: $signal_boundary"
  else
    signal_status=$?
  fi
  case "$signal_name:$signal_status" in
    HUP:129|INT:130|TERM:143) ;;
    *) fail "signal-boundary install exit differed: $signal_name/$signal_status" ;;
  esac
  cmp -s "$signal_home/.config/fish/config.fish" \
    "$fixture_root/$signal_boundary.fish-before" \
    || fail "signal-boundary install lost Fish config: $signal_boundary"
  case "$signal_boundary" in
    install-runtime-old|install-command-old)
      assert_install_published "$signal_home"
      ;;
    *)
      [ ! -e "$signal_home/.local/share/trellage/cdx" ] \
        || fail "signal-boundary install left runtime: $signal_boundary"
      [ ! -e "$signal_home/.local/bin/cdx" ] && [ ! -L "$signal_home/.local/bin/cdx" ] \
        || fail "signal-boundary install left command: $signal_boundary"
      ;;
  esac
  assert_no_install_staging "$signal_home"
  write_directory_topology "$signal_home" \
    "$fixture_root/$signal_boundary.topology-after"
  cmp -s "$fixture_root/$signal_boundary.topology-before" \
    "$fixture_root/$signal_boundary.topology-after" \
    || fail "signal-boundary install changed topology: $signal_boundary"
done

for signal_boundary in \
  uninstall-fish-old \
  uninstall-fish-new \
  uninstall-command \
  uninstall-runtime; do
  signal_home="$fixture_root/signal-$signal_name-$signal_boundary"
  mkdir -p "$signal_home"
  write_legacy_fish "$signal_home"
  HOME="$signal_home" /bin/bash "$install_script" >/dev/null \
    || fail "could not prepare uninstall signal fixture: $signal_boundary"
  cp "$signal_home/.config/fish/config.fish" \
    "$fixture_root/$signal_boundary.fish-before"
  write_directory_topology "$signal_home" \
    "$fixture_root/$signal_boundary.topology-before"
  if PATH="$signal_mv_bin:$PATH" CDX_TEST_REAL_MV="$real_mv" \
    CDX_TEST_SIGNAL_MV="$signal_boundary" \
    CDX_TEST_SIGNAL_NAME="$signal_name" \
    CDX_TEST_SIGNAL_ONCE="$fixture_root/$signal_name-$signal_boundary.signaled" \
    HOME="$signal_home" \
    /bin/bash "$uninstall_script" >"$fixture_root/$signal_boundary.out" 2>&1; then
    fail "signal-boundary uninstall unexpectedly succeeded: $signal_boundary"
  else
    signal_status=$?
  fi
  case "$signal_name:$signal_status" in
    HUP:129|INT:130|TERM:143) ;;
    *) fail "signal-boundary uninstall exit differed: $signal_name/$signal_status" ;;
  esac
  cmp -s "$signal_home/.config/fish/config.fish" \
    "$fixture_root/$signal_boundary.fish-before" \
    || fail "signal-boundary uninstall lost Fish config: $signal_boundary"
  assert_install_published "$signal_home"
  assert_no_install_staging "$signal_home"
  write_directory_topology "$signal_home" \
    "$fixture_root/$signal_boundary.topology-after"
  cmp -s "$fixture_root/$signal_boundary.topology-before" \
    "$fixture_root/$signal_boundary.topology-after" \
    || fail "signal-boundary uninstall changed topology: $signal_boundary"
done
done

edited_home="$fixture_root/edited-home"
mkdir -p "$edited_home"
write_legacy_fish "$edited_home"
HOME="$edited_home" /bin/bash "$install_script" >/dev/null || fail 'edited fixture install failed'
printf '# user edit\n' >>"$edited_home/.config/fish/config.fish"
cp "$edited_home/.config/fish/config.fish" "$fixture_root/edited-fish-before"
mkdir "$fixture_root/edited-recovery-before-reinstall"
cp "$edited_home/.local/share/trellage/cdx/.fish-recovery/"* \
  "$fixture_root/edited-recovery-before-reinstall/"
HOME="$edited_home" /bin/bash "$install_script" \
  >"$fixture_root/edited-reinstall.out" \
  || fail 'reinstall rejected an unrelated Fish config edit'
cmp -s "$edited_home/.config/fish/config.fish" "$fixture_root/edited-fish-before" \
  || fail 'reinstall changed unrelated Fish config edits'
for name in config-before original-mode sha256-before sha256-after removed-line; do
  cmp -s "$edited_home/.local/share/trellage/cdx/.fish-recovery/$name" \
    "$fixture_root/edited-recovery-before-reinstall/$name" \
    || fail "reinstall changed Fish recovery metadata after unrelated edit: $name"
done
if HOME="$edited_home" /bin/bash "$uninstall_script" >"$fixture_root/edited-uninstall.out" 2>&1; then
  fail 'uninstall overwrote Fish config after a user edit'
fi
cmp -s "$edited_home/.config/fish/config.fish" "$fixture_root/edited-fish-before" \
  || fail 'refused uninstall changed edited Fish config'
assert_install_published "$edited_home"

for failure_point in \
  during-fish-publication \
  after-fish-publication \
  after-command-removal \
  after-runtime-removal; do
  uninstall_home="$fixture_root/uninstall-failure-$failure_point"
  mkdir -p "$uninstall_home"
  write_legacy_fish "$uninstall_home"
  cp "$uninstall_home/.config/fish/config.fish" \
    "$fixture_root/uninstall-$failure_point.original"
  HOME="$uninstall_home" /bin/bash "$install_script" >/dev/null \
    || fail "uninstall rollback fixture install failed: $failure_point"
  cp "$uninstall_home/.config/fish/config.fish" \
    "$fixture_root/uninstall-$failure_point.post-install"
  post_mode="$(path_mode "$uninstall_home/.config/fish/config.fish")"
  if HOME="$uninstall_home" CDX_UNINSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$uninstall_script" >"$fixture_root/uninstall-$failure_point.out" 2>&1; then
    fail "injected uninstall failure unexpectedly succeeded: $failure_point"
  fi
  cmp -s "$uninstall_home/.config/fish/config.fish" \
    "$fixture_root/uninstall-$failure_point.post-install" \
    || fail "uninstall rollback changed Fish bytes: $failure_point"
  [ "$(path_mode "$uninstall_home/.config/fish/config.fish")" = "$post_mode" ] \
    || fail "uninstall rollback changed Fish mode: $failure_point"
  assert_install_published "$uninstall_home"
  assert_no_install_staging "$uninstall_home"
done

unrelated_command_home="$fixture_root/unrelated-command-home"
mkdir -p "$unrelated_command_home/.local/bin"
write_legacy_fish "$unrelated_command_home"
printf 'unrelated command\n' >"$unrelated_command_home/.local/bin/cdx"
if HOME="$unrelated_command_home" /bin/bash "$install_script" \
  >"$fixture_root/unrelated-command.out" 2>&1; then
  fail 'install replaced an unrelated cdx command'
fi
assert_install_line 'unrelated command' "$unrelated_command_home/.local/bin/cdx"

symlink_runtime_home="$fixture_root/symlink-runtime-home"
mkdir -p "$symlink_runtime_home/.local/share/trellage" "$symlink_runtime_home/outside"
write_legacy_fish "$symlink_runtime_home"
ln -s "$symlink_runtime_home/outside" \
  "$symlink_runtime_home/.local/share/trellage/cdx"
if HOME="$symlink_runtime_home" /bin/bash "$install_script" \
  >"$fixture_root/symlink-runtime.out" 2>&1; then
  fail 'install followed a symlinked runtime root'
fi
[ -L "$symlink_runtime_home/.local/share/trellage/cdx" ] \
  || fail 'rejected symlinked runtime was changed'

printf 'trellage Codex installation contract: PASS\n'
printf 'trellage Codex profiles contract: PASS\n'
