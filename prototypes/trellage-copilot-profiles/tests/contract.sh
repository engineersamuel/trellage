#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
prototype_root="$PWD"
. "$prototype_root/../../tests/helpers/floating_skills_fixture.sh"

fail() {
  printf 'trellage profiles contract: FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local needle="$1"
  local file="$2"
  grep -Fq -- "$needle" "$file" || fail "missing '$needle' in $file"
}

assert_line() {
  local expected="$1"
  local file="$2"
  grep -Fxq -- "$expected" "$file" || fail "missing exact line '$expected' in $file"
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  if grep -Fq -- "$needle" "$file"; then
    fail "unexpected '$needle' in $file"
  fi
}

profile_tree_hash() {
  local root="$1"
  (
    cd "$root"
    find . -print | LC_ALL=C sort | while IFS= read -r entry; do
      if [[ -L "$entry" ]]; then
        printf 'link\t%s\t%s\n' "$entry" "$(readlink "$entry")"
      elif [[ -d "$entry" ]]; then
        printf 'directory\t%s\n' "$entry"
      elif [[ -f "$entry" ]]; then
        printf 'file\t%s\t%s\n' "$entry" "$(shasum -a 256 "$entry" | awk '{print $1}')"
      fi
    done
  ) | shasum -a 256 | awk '{print $1}'
}

fixture_root="$(mktemp -d)"
cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT

fixture_home="$fixture_root/home"
fake_bin="$fixture_root/bin"
fake_copilot_log="$fixture_root/copilot.log"
fake_copilot_argv_log="$fixture_root/copilot-argv.jsonl"
fake_curl_log="$fixture_root/curl.log"
fake_native_auth_file="$fixture_root/native-credentials/copilot.auth"
mkdir -p "$fixture_home" "$fake_bin"

cat >"$fake_bin/copilot" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1-}" == --version ]]; then
  printf 'copilot %s\n' "${FAKE_COPILOT_VERSION:-1.0.81}"
  exit 0
fi

: "${COPILOT_HOME:?COPILOT_HOME must be set}"
: "${FAKE_COPILOT_LOG:?FAKE_COPILOT_LOG must be set}"
: "${FAKE_COPILOT_ARGV_LOG:?FAKE_COPILOT_ARGV_LOG must be set}"
: "${FAKE_COPILOT_NATIVE_AUTH_FILE:?FAKE_COPILOT_NATIVE_AUTH_FILE must be set}"
[[ -f "$FAKE_COPILOT_NATIVE_AUTH_FILE" ]] || {
  printf 'fixture native authentication unavailable\n' >&2
  exit 77
}
[[ "$FAKE_COPILOT_NATIVE_AUTH_FILE" != "$COPILOT_HOME"/* ]] || {
  printf 'fixture native authentication was copied into COPILOT_HOME\n' >&2
  exit 78
}
if [[ "${FAKE_COPILOT_FAILURE_HOME-}" == "$COPILOT_HOME" && "${1-}" != plugin ]]; then
  printf '%s' "${FAKE_COPILOT_FAILURE_STDOUT-}"
  printf '%s' "${FAKE_COPILOT_FAILURE_STDERR-}" >&2
  exit "${FAKE_COPILOT_FAILURE_STATUS:?FAKE_COPILOT_FAILURE_STATUS must be set}"
fi
if [[ "${FAKE_COPILOT_BINARY_STDERR_HOME-}" == "$COPILOT_HOME" && "${1-}" != plugin ]]; then
  printf 'binary\0stderr\n' >&2
  exit 42
fi
if [[ -n "${FAKE_COPILOT_SIGNAL_PID_FILE-}" && "${1-}" != plugin ]]; then
  printf '%s\n' "$$" >"$FAKE_COPILOT_SIGNAL_PID_FILE"
  trap 'exit 143' TERM
  while :; do
    sleep 1
  done
fi
jq -cn \
  --arg home "$COPILOT_HOME" \
  --arg cwd "$PWD" \
  '$ARGS.named + {args: $ARGS.positional}' \
  --args -- "$@" >>"$FAKE_COPILOT_ARGV_LOG"
printf 'home=%s\tcwd=%s\thome_env=%s\targs=' "$COPILOT_HOME" "$PWD" "$HOME" >>"$FAKE_COPILOT_LOG"
printf '%q ' "$@" >>"$FAKE_COPILOT_LOG"
printf '\tnative_auth=%s\n' "$FAKE_COPILOT_NATIVE_AUTH_FILE" >>"$FAKE_COPILOT_LOG"
if [[ "${FAKE_COPILOT_STREAM_HOME-}" == "$COPILOT_HOME" && "${1-}" != plugin ]]; then
  [[ -z "${FAKE_COPILOT_STREAM_STDOUT_FILE-}" \
    || ( -f "$FAKE_COPILOT_STREAM_STDOUT_FILE" && ! -L "$FAKE_COPILOT_STREAM_STDOUT_FILE" ) ]] \
    || exit 79
  [[ -z "${FAKE_COPILOT_STREAM_STDERR_FILE-}" \
    || ( -f "$FAKE_COPILOT_STREAM_STDERR_FILE" && ! -L "$FAKE_COPILOT_STREAM_STDERR_FILE" ) ]] \
    || exit 79
  [[ -z "${FAKE_COPILOT_STREAM_STDOUT_FILE-}" ]] || cat -- "$FAKE_COPILOT_STREAM_STDOUT_FILE"
  [[ -z "${FAKE_COPILOT_STREAM_STDERR_FILE-}" ]] || cat -- "$FAKE_COPILOT_STREAM_STDERR_FILE" >&2
  exit "${FAKE_COPILOT_STREAM_STATUS:-0}"
fi

installed="$COPILOT_HOME/fake-state/plugins"
marketplaces="$COPILOT_HOME/fake-state/marketplaces"
if [[ "${1-} ${2-} ${3-} ${4-}" == '--autopilot --allow-all --no-ask-user --fixture-capability-inventory' ]]; then
  if [[ -f "$installed" ]]; then
    while IFS=$'\t' read -r plugin _version; do
      printf 'plugin:%s\n' "$plugin"
      if [[ "$plugin" == 'awesome-copilot@awesome-copilot' ]]; then
        printf '%s\n' \
          'plugin-skill:suggest-awesome-github-copilot-agents' \
          'plugin-skill:suggest-awesome-github-copilot-instructions' \
          'plugin-skill:suggest-awesome-github-copilot-skills'
      elif [[ "$plugin" == 'plannotator-effective-html@effective-html' ]]; then
        printf '%s\n' \
          'plugin-skill:design-artifact' \
          'plugin-skill:html' \
          'plugin-skill:html-diagram' \
          'plugin-skill:html-plan' \
          'plugin-skill:html-prototype' \
          'plugin-skill:html-wireframe'
      fi
    done <"$installed"
  fi
  if [[ -d "$COPILOT_HOME/skills" ]]; then
    for capability_path in "$COPILOT_HOME"/skills/*; do
      [[ -e "$capability_path" ]] || continue
      printf 'profile-skill:%s\n' "${capability_path##*/}"
    done
  fi
  if [[ -f "$COPILOT_HOME/mcp-config.json" ]]; then
    jq -r '.mcpServers // {} | keys[] | "profile-mcp:\(.)"' "$COPILOT_HOME/mcp-config.json"
  fi
  if [[ -d "$PWD/.github/skills" ]]; then
    for capability_path in "$PWD"/.github/skills/*; do
      [[ -e "$capability_path" ]] || continue
      printf 'repository-skill:%s\n' "${capability_path##*/}"
    done
  fi
  exit 0
fi

case "${1-} ${2-} ${3-}" in
  'plugin marketplace list')
    printf '  ◆ awesome-copilot-preview (GitHub: fixture/awesome-copilot-preview)\n'
    if [[ "${FAKE_HIDE_AWESOME_MARKETPLACE:-0}" != '1' ]]; then
      printf '  ◆ awesome-copilot (GitHub: github/awesome-copilot)\n'
    fi
    if [[ -f "$marketplaces" ]]; then
      while IFS=$'\t' read -r marketplace_name marketplace_source; do
        printf '  • %s (GitHub: %s)\n' "$marketplace_name" "$marketplace_source"
      done <"$marketplaces"
    fi
    ;;
  'plugin marketplace add')
    marketplace_source="${4:?marketplace source required}"
    marketplace_name="${marketplace_source##*/}"
    mkdir -p "$(dirname "$marketplaces")"
    if [[ ! -f "$marketplaces" ]] \
      || ! awk -F '\t' -v expected="$marketplace_name" '$1 == expected { found = 1 } END { exit !found }' "$marketplaces"; then
      printf '%s\t%s\n' "$marketplace_name" "$marketplace_source" >>"$marketplaces"
    fi
    ;;
esac

case "${1-} ${2-}" in
  'plugin list')
    if [[ "${FAKE_COPILOT_LIST_FAILURE_HOME-}" == "$COPILOT_HOME" ]]; then
      printf 'fixture plugin-list failure: %s\n' "$COPILOT_HOME" >&2
      exit 66
    fi
    if [[ -f "$installed" ]]; then
      printf 'Installed plugins:\n'
      while IFS=$'\t' read -r plugin version; do
        if [[ -n "$version" ]]; then
          printf '  • %s (v%s)\n' "$plugin" "$version"
        else
          printf '  • %s\n' "$plugin"
        fi
      done <"$installed"
    else
      # Matches installed GitHub Copilot CLI 1.0.81 output: trailing period
      # plus an install hint line, not the bare legacy string.
      printf 'No plugins installed.\n\n'
      printf "Use 'copilot plugin install <source>' to install a plugin.\n"
    fi
    ;;
  'plugin install')
    plugin="${3:?plugin required}"
    version='unknown'
    case "$plugin" in
      awesome-copilot@awesome-copilot) version='1.1.0' ;;
      hve-core@hve-core) version='3.2.2' ;;
      plannotator-effective-html@effective-html) version='' ;;
      superpowers@superpowers-marketplace) version='6.2.0' ;;
    esac
    mkdir -p "$(dirname "$installed")"
    printf '%s\t%s\n' "$plugin" "$version" >"$installed"
    if [[ "$plugin" == 'plannotator-effective-html@effective-html' ]]; then
      plugin_root="$COPILOT_HOME/installed-plugins/effective-html/plannotator-effective-html"
      mkdir -p "$plugin_root/.codex-plugin"
      printf '%s\n' \
        '{"name":"plannotator-effective-html","version":"0.4.0","skills":"./skills/"}' \
        >"$plugin_root/.codex-plugin/plugin.json"
      for skill in \
        design-artifact \
        html \
        html-diagram \
        html-plan \
        html-prototype \
        html-wireframe; do
        mkdir -p "$plugin_root/skills/$skill"
        printf '# %s\n' "$skill" >"$plugin_root/skills/$skill/SKILL.md"
      done
    fi
    ;;
  'plugin update')
    plugin="${3:?plugin required}"
    version='unknown'
    case "$plugin" in
      awesome-copilot@awesome-copilot) version='1.1.0' ;;
      hve-core@hve-core) version='3.2.2' ;;
      plannotator-effective-html@effective-html) version='' ;;
      superpowers@superpowers-marketplace) version='6.2.0' ;;
    esac
    mkdir -p "$(dirname "$installed")"
    printf '%s\t%s\n' "$plugin" "$version" >"$installed"
    ;;
  'plugin uninstall')
    plugin="${3:?plugin required}"
    if [[ -f "$installed" ]]; then
      awk -F '\t' -v plugin="$plugin" '$1 != plugin' "$installed" >"$installed.next"
      mv "$installed.next" "$installed"
    fi
    ;;
  'skill list')
    [[ "${3-}" == '--json' && -f "$installed" ]] || exit 67
    IFS=$'\t' read -r plugin version <"$installed"
    plugin_name="${plugin%%@*}"
    marketplace_name="${plugin#*@}"
    if [[ "$plugin" == 'plannotator-effective-html@effective-html' ]]; then
      jq -cn \
        --arg root "$COPILOT_HOME/installed-plugins/$marketplace_name/$plugin_name/" \
        --arg disabled "${FAKE_COPILOT_DISABLED_SKILL-}" \
        --arg omitted "${FAKE_COPILOT_OMITTED_SKILL-}" '[
        {name:"design-artifact",description:"Design artifact",source:"plugin",path:($root + "skills/design-artifact"),enabled:true},
        {name:"html",description:"HTML",source:"plugin",path:($root + "skills/html"),enabled:true},
        {name:"html-diagram",description:"HTML diagram",source:"plugin",path:($root + "skills/html-diagram"),enabled:true},
        {name:"html-plan",description:"HTML plan",source:"plugin",path:($root + "skills/html-plan"),enabled:true},
        {name:"html-prototype",description:"HTML prototype",source:"plugin",path:($root + "skills/html-prototype"),enabled:true},
        {name:"html-wireframe",description:"HTML wireframe",source:"plugin",path:($root + "skills/html-wireframe"),enabled:true},
        {name:"builtin-one",description:"Built-in skill",source:"builtin",path:"/fixture/builtin-one",enabled:true}
      ]
      | map(select(.name != $omitted))
      | map(if .name == $disabled then .enabled = false else . end)'
    else
      jq -cn --arg root "$COPILOT_HOME/installed-plugins/$marketplace_name/$plugin_name/" '[
        {name:"package-one",description:"Package skill",source:"plugin",path:($root + "skills/package-one"),enabled:true},
        {name:"package-two",description:"Package skill",source:"plugin",path:($root + "skills/package-two"),enabled:true},
        {name:"builtin-one",description:"Built-in skill",source:"builtin",path:"/fixture/builtin-one",enabled:true}
      ]'
    fi
    exit 0
    ;;
  'mcp list')
    [[ "${3-}" == '--json' ]] || exit 68
    printf '%s\n' '{"mcpServers":{"docs":{"type":"stdio"},"files":{"type":"stdio"}}}'
    exit 0
    ;;
esac

if [[ "${1-}" != 'plugin' ]]; then
  printf 'COPILOT_HOME=%s\nHOME=%s\nCWD=%s\n' "$COPILOT_HOME" "$HOME" "$PWD"
  printf 'ARG=%s\n' "$@"
fi
EOF

cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${FAKE_CURL_LOG:?FAKE_CURL_LOG must be set}"
url="${*: -1}"
printf '%s\n' "$url" >>"$FAKE_CURL_LOG"
if [[ "${FAKE_CURL_FAILURE_URL-}" == "$url" ]]; then
  printf 'fixture transport failure: %s\n' "$url" >&2
  exit 22
fi
if [[ "${FAKE_CURL_MALFORMED_VERSION_URL-}" == "$url" ]]; then
  printf '%s\n' '{"name":"plannotator-effective-html","version":42}'
  exit 0
fi
case "$url" in
  https://raw.githubusercontent.com/github/awesome-copilot/main/.github/plugin/marketplace.json)
    printf '%s\n' '{"name":"awesome-copilot","plugins":[{"name":"awesome-copilot","version":"1.1.0"}]}'
    ;;
  https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json)
    printf '%s\n' '{"name":"hve-core","plugins":[{"name":"hve-core","version":"3.2.2"}]}'
    ;;
  https://raw.githubusercontent.com/plannotator/effective-html/main/.agents/plugins/marketplace.json)
    printf '%s\n' '{"name":"effective-html","plugins":[{"name":"plannotator-effective-html"}]}'
    ;;
  https://raw.githubusercontent.com/plannotator/effective-html/main/.codex-plugin/plugin.json)
    printf '%s\n' '{"name":"plannotator-effective-html","version":"0.4.0","skills":"./skills/"}'
    ;;
  https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json)
    printf '%s\n' '{"name":"superpowers-marketplace","plugins":[{"name":"superpowers","version":"6.2.0"}]}'
    ;;
  *)
    printf 'unexpected URL: %s\n' "$url" >&2
    exit 22
    ;;
esac
EOF

cat >"$fake_bin/mkdir" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAKE_FORBID_PROFILE_MUTATION:-0}" == '1' \
  && -n "${COPILOT_HOME-}" \
  && " $* " == *" $COPILOT_HOME"* ]]; then
  printf 'fake copilot attempted profile mutation during read-only operation: mkdir %s\n' "$*" >&2
  exit 97
fi
exec /bin/mkdir "$@"
EOF

chmod 0555 "$fake_bin/copilot" "$fake_bin/curl" "$fake_bin/mkdir"
ln -s "$(command -v jq)" "$fake_bin/jq"
install_fixture_node "$fake_bin"
ln -s /bin/bash "$fake_bin/bash"
ln -s "$(command -v dirname)" "$fake_bin/dirname"
seed_floating_skills_cache "$fixture_home"
export HOME="$fixture_home"
export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export FAKE_COPILOT_LOG="$fake_copilot_log"
export FAKE_COPILOT_ARGV_LOG="$fake_copilot_argv_log"
export FAKE_CURL_LOG="$fake_curl_log"
: >"$fake_copilot_log"
: >"$fake_copilot_argv_log"
: >"$fake_curl_log"
mkdir -p "$(dirname "$fake_native_auth_file")"
printf '%s\n' 'native credential sentinel' >"$fake_native_auth_file"
export FAKE_COPILOT_NATIVE_AUTH_FILE="$fake_native_auth_file"

# Host-global content must never be selected by a profile.
mkdir -p "$HOME/.copilot/plugins/global-plugin" "$HOME/.copilot/skills/personal-skill"
mkdir -p "$HOME/.copilot/sessions"
printf '%s\n' '{"source":"host config"}' >"$HOME/.copilot/config.json"
printf '%s\n' '{"source":"host settings"}' >"$HOME/.copilot/settings.json"
printf '%s\n' '{"mcpServers":{"global-mcp-one":{},"global-mcp-two":{},"global-mcp-three":{},"global-mcp-four":{},"global-mcp-five":{},"global-mcp-six":{},"global-mcp-seven":{}}}' \
  >"$HOME/.copilot/mcp-config.json"
printf '%s\n' 'host session sentinel' >"$HOME/.copilot/sessions/host-session"
printf '%s\n' 'host encryption sentinel' >"$HOME/.copilot/encryption_key"

for profile in awesome hve plannotator superpowers; do
  profile_home="$HOME/.local/share/trellage/profiles/copilot/$profile/home"
  mkdir -p \
    "$profile_home/sessions" \
    "$profile_home/plugins/$profile-plugin"
  printf '{"profile":"%s"}\n' "$profile" >"$profile_home/config.json"
  printf '%s session\n' "$profile" >"$profile_home/sessions/$profile-session"
  printf '{"mcpServers":{},"profile":"%s"}\n' "$profile" >"$profile_home/mcp-config.json"
  printf '{"profile":"%s"}\n' "$profile" >"$profile_home/plugins/$profile-plugin/manifest.json"
done

launcher='./bin/cpx'
installer='./install.sh'
uninstaller='./uninstall.sh'
readme="$prototype_root/README.md"

[[ -x "$launcher" ]] || fail "missing executable launcher: $launcher"
[[ -x "$installer" ]] || fail "missing executable installer: $installer"
[[ -x "$uninstaller" ]] || fail "missing executable uninstaller: $uninstaller"
assert_line 'Copilot authentication is inherited through the CLI native credential mechanism; cpx never copies ~/.copilot into a profile home.' "$readme"
jq -e '
  .schemaVersion == 1
  and (.profiles | keys | sort) == ["awesome", "hve", "plannotator", "superpowers"]
  and .profiles.awesome.headless == {
    "schemaVersion": 1,
    "prompt": true,
    "outputFormats": ["text", "json"],
    "eventContract": null,
    "trellageEventContract": null,
    "sessionId": "none",
    "resume": false,
    "resumeWithPrompt": false,
    "questionToolControl": "hard-deny",
    "changedFiles": "none",
    "usage": false,
    "cost": false,
    "modelOverride": true,
    "effortOverride": false,
    "testedHarnessVersion": "1.0.81"
  }
  and (.profiles.awesome | del(.headless)) == {
    "description": "GitHub Copilot CLI for discovering and importing curated repository agents, instructions, and skills through Awesome Copilot meta-skills.",
    "marketplace": "github/awesome-copilot",
    "marketplaceName": "awesome-copilot",
    "manifestUrl": "https://raw.githubusercontent.com/github/awesome-copilot/main/.github/plugin/marketplace.json",
    "plugin": "awesome-copilot@awesome-copilot",
    "standaloneMcps": []
  }
  and .profiles.hve.headless == {
    "schemaVersion": 1,
    "prompt": true,
    "outputFormats": ["text", "json"],
    "eventContract": null,
    "trellageEventContract": null,
    "sessionId": "none",
    "resume": false,
    "resumeWithPrompt": false,
    "questionToolControl": "hard-deny",
    "changedFiles": "none",
    "usage": false,
    "cost": false,
    "modelOverride": true,
    "effortOverride": false,
    "testedHarnessVersion": "1.0.81"
  }
  and (.profiles.hve | del(.headless)) == {
    "description": "GitHub Copilot CLI for evidence-backed Research-Plan-Implement-Review delivery through native HVE Core RPI and specialist workflows.",
    "marketplace": "microsoft/hve-core",
    "marketplaceName": "hve-core",
    "manifestUrl": "https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json",
    "plugin": "hve-core@hve-core",
    "retiredPlugins": ["hve-core-all@hve-core"],
    "standaloneMcps": []
  }
  and .profiles.plannotator.headless == {
    "schemaVersion": 1,
    "prompt": true,
    "outputFormats": ["text", "json"],
    "eventContract": null,
    "trellageEventContract": null,
    "sessionId": "none",
    "resume": false,
    "resumeWithPrompt": false,
    "questionToolControl": "hard-deny",
    "changedFiles": "none",
    "usage": false,
    "cost": false,
    "modelOverride": true,
    "effortOverride": false,
    "testedHarnessVersion": "1.0.81"
  }
  and (.profiles.plannotator | del(.headless)) == {
    "description": "GitHub Copilot CLI for self-contained visual HTML artifacts, wireframes, prototypes, plans, and diagrams through Effective HTML skills.",
    "marketplace": "plannotator/effective-html",
    "marketplaceName": "effective-html",
    "manifestUrl": "https://raw.githubusercontent.com/plannotator/effective-html/main/.agents/plugins/marketplace.json",
    "versionManifestUrl": "https://raw.githubusercontent.com/plannotator/effective-html/main/.codex-plugin/plugin.json",
    "installedVersionManifest": ".codex-plugin/plugin.json",
    "plugin": "plannotator-effective-html@effective-html",
    "requiredPackageSkills": [
      "design-artifact",
      "html",
      "html-diagram",
      "html-plan",
      "html-prototype",
      "html-wireframe"
    ],
    "standaloneMcps": []
  }
  and .profiles.superpowers.headless == {
    "schemaVersion": 1,
    "prompt": true,
    "outputFormats": ["text", "json"],
    "eventContract": null,
    "trellageEventContract": null,
    "sessionId": "none",
    "resume": false,
    "resumeWithPrompt": false,
    "questionToolControl": "hard-deny",
    "changedFiles": "none",
    "usage": false,
    "cost": false,
    "modelOverride": true,
    "effortOverride": false,
    "testedHarnessVersion": "1.0.81"
  }
  and (.profiles.superpowers | del(.headless)) == {
    "description": "GitHub Copilot CLI for design-first TDD, root-cause fixes, review, verification, and clean branches through Superpowers.",
    "marketplace": "obra/superpowers-marketplace",
    "marketplaceName": "superpowers-marketplace",
    "manifestUrl": "https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json",
    "plugin": "superpowers@superpowers-marketplace",
    "standaloneMcps": []
  }
' catalog.json >/dev/null || fail 'catalog does not match the approved profile contract'

mkdir -p "$HOME/.ssh"
printf 'ssh sentinel\n' >"$HOME/.ssh/sentinel"
for malicious_profile in '../../../../../.ssh' 'bad/name' '.hidden' 'Upper'; do
  malicious_catalog="$fixture_root/malicious-$(printf '%s' "$malicious_profile" | tr '/.' '__').json"
  jq --arg profile "$malicious_profile" \
    '.profiles[$profile] = .profiles.hve' catalog.json >"$malicious_catalog"
  before_malicious_hash="$(profile_tree_hash "$HOME/.ssh")"
  before_malicious_log_lines="$(wc -l <"$fake_copilot_log" | tr -d ' ')"
  for malicious_operation in setup doctor launch; do
    malicious_status=0
    case "$malicious_operation" in
      setup) CPX_CATALOG="$malicious_catalog" "$launcher" setup "$malicious_profile" >"$fixture_root/malicious.out" 2>"$fixture_root/malicious.err" || malicious_status=$? ;;
      doctor) CPX_CATALOG="$malicious_catalog" "$launcher" doctor "$malicious_profile" >"$fixture_root/malicious.out" 2>"$fixture_root/malicious.err" || malicious_status=$? ;;
      launch) CPX_CATALOG="$malicious_catalog" "$launcher" "$malicious_profile" --prompt unsafe >"$fixture_root/malicious.out" 2>"$fixture_root/malicious.err" || malicious_status=$? ;;
    esac
    [[ "$malicious_status" -ne 0 ]] \
      || fail "$malicious_operation accepted malicious profile key: $malicious_profile"
    assert_contains 'invalid catalog:' "$fixture_root/malicious.err"
  done
  [[ "$(profile_tree_hash "$HOME/.ssh")" == "$before_malicious_hash" ]] \
    || fail "malicious profile key mutated filesystem: $malicious_profile"
  [[ "$(wc -l <"$fake_copilot_log" | tr -d ' ')" == "$before_malicious_log_lines" ]] \
    || fail "malicious profile key invoked Copilot: $malicious_profile"
done

invalid_headless_catalog="$fixture_root/invalid-headless.json"
jq '.profiles.hve.headless.questionToolControl = "invalid"' \
  catalog.json >"$invalid_headless_catalog"
for invalid_operation in list setup launch; do
  invalid_status=0
  case "$invalid_operation" in
    list) CPX_CATALOG="$invalid_headless_catalog" "$launcher" list --json >"$fixture_root/invalid-headless.out" 2>"$fixture_root/invalid-headless.err" || invalid_status=$? ;;
    setup) CPX_CATALOG="$invalid_headless_catalog" "$launcher" setup hve >"$fixture_root/invalid-headless.out" 2>"$fixture_root/invalid-headless.err" || invalid_status=$? ;;
    launch) CPX_CATALOG="$invalid_headless_catalog" "$launcher" hve --prompt unsafe >"$fixture_root/invalid-headless.out" 2>"$fixture_root/invalid-headless.err" || invalid_status=$? ;;
  esac
  [[ "$invalid_status" -ne 0 ]] || fail "$invalid_operation accepted invalid headless catalog"
  assert_contains 'invalid catalog:' "$fixture_root/invalid-headless.err"
done

worktree="$fixture_root/project with spaces"
mkdir -p "$worktree/.github/skills/repository-skill"
printf '%s\n' 'repository skill sentinel' >"$worktree/.github/skills/repository-skill/SKILL.md"
launch_output="$fixture_root/launch.out"
(
  cd "$worktree"
  CPX_PROFILES_ROOT="$fixture_root/forbidden-profile-root" \
    "$prototype_root/bin/cpx" hve --prompt 'hello world' --allow-tool 'git status'
) >"$launch_output"
expected_hve_home="$HOME/.local/share/trellage/profiles/copilot/hve/home"
assert_contains "COPILOT_HOME=$expected_hve_home" "$launch_output"
assert_not_contains "$fixture_root/forbidden-profile-root" "$launch_output"
assert_contains "HOME=$HOME" "$launch_output"
assert_contains "CWD=$worktree" "$launch_output"
assert_contains "home=$expected_hve_home" "$fake_copilot_log"
assert_contains "native_auth=$fake_native_auth_file" "$fake_copilot_log"
assert_not_contains "$HOME/.copilot" "$fake_copilot_log"
[[ -f "$worktree/.github/skills/repository-skill/SKILL.md" ]] \
  || fail 'repository-scoped skill disappeared during launch'

expected_hve_launch="$(jq -cn \
  --arg home "$expected_hve_home" \
  --arg cwd "$worktree" \
  '{home: $home, cwd: $cwd, args: ["--autopilot", "--allow-all", "--no-ask-user", "--prompt", "hello world", "--allow-tool", "git status"]}')"
actual_hve_launch="$(jq -c 'select(.args[0] != "plugin")' "$fake_copilot_argv_log" | sed -n '1p')"
[[ "$actual_hve_launch" == "$expected_hve_launch" ]] \
  || fail 'hve launch did not preserve the exact ordered argument vector'

expected_superpowers_home="$HOME/.local/share/trellage/profiles/copilot/superpowers/home"
(
  cd "$worktree"
  "$prototype_root/bin/cpx" superpowers --model 'gpt-5.5' --prompt 'two words' -- '--deny-tool'
) >"$fixture_root/superpowers-launch.out"
expected_superpowers_launch="$(jq -cn \
  --arg home "$expected_superpowers_home" \
  --arg cwd "$worktree" \
  '{home: $home, cwd: $cwd, args: ["--autopilot", "--allow-all", "--no-ask-user", "--model", "gpt-5.5", "--prompt", "two words", "--", "--deny-tool"]}')"
actual_superpowers_launch="$(jq -c 'select(.args[0] != "plugin")' "$fake_copilot_argv_log" | sed -n '2p')"
[[ "$actual_superpowers_launch" == "$expected_superpowers_launch" ]] \
  || fail 'superpowers launch did not preserve the exact ordered argument vector'

expected_awesome_home="$HOME/.local/share/trellage/profiles/copilot/awesome/home"
expected_plannotator_home="$HOME/.local/share/trellage/profiles/copilot/plannotator/home"
(
  cd "$worktree"
  "$prototype_root/bin/cpx" awesome --prompt 'find useful skills' --deny-url=example.com --model 'gpt-5.5'
) >"$fixture_root/awesome-launch.out"
expected_awesome_launch="$(jq -cn \
  --arg home "$expected_awesome_home" \
  --arg cwd "$worktree" \
  '{home: $home, cwd: $cwd, args: ["--autopilot", "--allow-all", "--no-ask-user", "--prompt", "find useful skills", "--deny-url=example.com", "--model", "gpt-5.5"]}')"
actual_awesome_launch="$(jq -c 'select(.args[0] != "plugin")' "$fake_copilot_argv_log" | sed -n '3p')"
[[ "$actual_awesome_launch" == "$expected_awesome_launch" ]] \
  || fail 'awesome launch did not preserve the exact ordered argument vector'

(
  cd "$worktree"
  "$prototype_root/bin/cpx" hve
) >"$fixture_root/bare-launch.out"
expected_bare_launch="$(jq -cn \
  --arg home "$expected_hve_home" \
  --arg cwd "$worktree" \
  '{home: $home, cwd: $cwd, args: ["--autopilot", "--allow-all", "--no-ask-user"]}')"
actual_bare_launch="$(tail -n 1 "$fake_copilot_argv_log")"
[[ "$actual_bare_launch" == "$expected_bare_launch" ]] \
  || fail 'bare launch did not add the default permission argument'

valid_json_stream="$fixture_root/headless-valid.jsonl"
printf '%s\n' \
  '{"type":"session.start","data":{"sessionId":"fixture-session"}}' \
  '{"type":"assistant.message","data":{"content":"CPX_JSON_OK"}}' \
  >"$valid_json_stream"
(
  cd "$worktree"
  FAKE_COPILOT_STREAM_HOME="$expected_hve_home" \
  FAKE_COPILOT_STREAM_STDOUT_FILE="$valid_json_stream" \
    "$prototype_root/bin/cpx" hve \
    --prompt 'machine output' --output-format json --stream off
) >"$fixture_root/headless-valid.out" 2>"$fixture_root/headless-valid.err" \
  || fail 'JSON headless launch failed'
cmp -s "$valid_json_stream" "$fixture_root/headless-valid.out" \
  || fail 'JSON headless launch changed native stdout'
[[ ! -s "$fixture_root/headless-valid.err" ]] \
  || fail 'JSON headless launch wrote unexpected stderr'
jq -se 'length == 2 and all(.[]; type == "object")' \
  "$fixture_root/headless-valid.out" >/dev/null \
  || fail 'JSON headless launch did not produce machine-only stdout'
expected_json_launch="$(jq -cn \
  --arg home "$expected_hve_home" \
  --arg cwd "$worktree" \
  '{home: $home, cwd: $cwd, args: ["--autopilot", "--allow-all", "--no-ask-user", "--prompt", "machine output", "--output-format", "json", "--stream", "off"]}')"
[[ "$(tail -n 1 "$fake_copilot_argv_log")" == "$expected_json_launch" ]] \
  || fail 'JSON headless launch argument vector differs'

malformed_json_stream="$fixture_root/headless-malformed.jsonl"
printf '%s\n' '{"type":"assistant.message","data":{"content":"partial"}}' 'not-json' \
  >"$malformed_json_stream"
(
  cd "$worktree"
  FAKE_COPILOT_STREAM_HOME="$expected_hve_home" \
  FAKE_COPILOT_STREAM_STDOUT_FILE="$malformed_json_stream" \
    "$prototype_root/bin/cpx" hve \
    --prompt 'malformed output' --output-format json --stream off
) >"$fixture_root/headless-malformed.out" 2>"$fixture_root/headless-malformed.err" \
  || fail 'malformed-output fixture launch failed'
cmp -s "$malformed_json_stream" "$fixture_root/headless-malformed.out" \
  || fail 'malformed-output fixture changed native stdout'
if jq -se 'all(.[]; type == "object")' "$fixture_root/headless-malformed.out" >/dev/null 2>&1; then
  fail 'malformed Copilot output passed JSON validation'
fi

permission_argument_vectors=(
  '--allow-all'
  '--yolo'
  '--allow-all-tools'
  '--allow-all-paths'
  '--allow-all-urls'
  '--allow-tool=write'
  $'--allow-tool\twrite'
  '--allow-url=example.com'
  $'--allow-url\texample.com'
  '--deny-tool=shell(git push)'
  $'--deny-tool\tshell(git push)'
  '--deny-url=example.com'
  $'--deny-url\texample.com'
  '--add-dir=/tmp'
  $'--add-dir\t/tmp'
  '--disallow-temp-dir'
)

for permission_argument_vector in "${permission_argument_vectors[@]}"; do
  IFS=$'\t' read -r -a permission_args <<<"$permission_argument_vector"
  (
    cd "$worktree"
    "$prototype_root/bin/cpx" hve "${permission_args[@]}" --prompt 'permission contract'
  ) >"$fixture_root/permission-launch.out"
  actual_permission_launch="$(tail -n 1 "$fake_copilot_argv_log")"
  expected_permission_launch="$(jq -cn \
    --arg home "$expected_hve_home" \
    --arg cwd "$worktree" \
    --args '{home: $home, cwd: $cwd, args: $ARGS.positional}' \
    -- "--autopilot" "--allow-all" "--no-ask-user" "${permission_args[@]}" --prompt 'permission contract')"
  [[ "$actual_permission_launch" == "$expected_permission_launch" ]] \
    || fail "explicit permission arguments changed: $permission_argument_vector"
done

# Setup, doctor, and launch must reject a profile home symlink that escapes the
# managed profile root without invoking Copilot or mutating the link target.
safe_hve_home="$fixture_root/safe-hve-home"
escaped_hve_home="$fixture_root/escaped-hve-home"
mv "$expected_hve_home" "$safe_hve_home"
mkdir -p "$escaped_hve_home"
ln -s "$escaped_hve_home" "$expected_hve_home"
before_unsafe_log_lines="$(wc -l <"$fake_copilot_log" | tr -d ' ')"
for unsafe_operation in setup doctor launch; do
  unsafe_status=0
  case "$unsafe_operation" in
    setup) "$launcher" setup hve >"$fixture_root/unsafe-$unsafe_operation.out" 2>"$fixture_root/unsafe-$unsafe_operation.err" || unsafe_status=$? ;;
    doctor) "$launcher" doctor hve >"$fixture_root/unsafe-$unsafe_operation.out" 2>"$fixture_root/unsafe-$unsafe_operation.err" || unsafe_status=$? ;;
    launch) "$launcher" hve --prompt unsafe >"$fixture_root/unsafe-$unsafe_operation.out" 2>"$fixture_root/unsafe-$unsafe_operation.err" || unsafe_status=$? ;;
  esac
  [[ "$unsafe_status" -ne 0 ]] \
    || fail "$unsafe_operation accepted a symlinked out-of-root profile home"
  assert_contains "unsafe profile home path: $expected_hve_home" \
    "$fixture_root/unsafe-$unsafe_operation.err"
done
after_unsafe_log_lines="$(wc -l <"$fake_copilot_log" | tr -d ' ')"
[[ "$before_unsafe_log_lines" == "$after_unsafe_log_lines" ]] \
  || fail 'unsafe profile home invoked Copilot'
[[ -z "$(find "$escaped_hve_home" -mindepth 1 -print -quit)" ]] \
  || fail 'unsafe profile home mutated its out-of-root target'
rm "$expected_hve_home"
mv "$safe_hve_home" "$expected_hve_home"

for profile in awesome hve plannotator superpowers; do
  inventory_output="$fixture_root/$profile-inventory.out"
  (
    cd "$worktree"
    "$prototype_root/bin/cpx" "$profile" --fixture-capability-inventory
  ) >"$inventory_output"
  assert_contains 'repository-skill' "$inventory_output"
  for global_capability in \
    global-plugin \
    personal-skill \
    global-mcp-one \
    global-mcp-two \
    global-mcp-three \
    global-mcp-four \
    global-mcp-five \
    global-mcp-six \
    global-mcp-seven; do
    assert_not_contains "$global_capability" "$inventory_output"
  done

  profile_home="$HOME/.local/share/trellage/profiles/copilot/$profile/home"
  [[ -f "$profile_home/config.json" \
    && -f "$profile_home/sessions/$profile-session" \
    && -f "$profile_home/mcp-config.json" \
    && -f "$profile_home/plugins/$profile-plugin/manifest.json" ]] \
    || fail "$profile did not retain distinct profile-local config, session, MCP, and plugin state"
  [[ "$(<"$profile_home/config.json")" == "{\"profile\":\"$profile\"}" \
    && "$(<"$profile_home/sessions/$profile-session")" == "$profile session" \
    && "$(<"$profile_home/mcp-config.json")" == "{\"mcpServers\":{},\"profile\":\"$profile\"}" \
    && "$(<"$profile_home/plugins/$profile-plugin/manifest.json")" == "{\"profile\":\"$profile\"}" \
    && ! -e "$profile_home/settings.json" \
    && ! -e "$profile_home/sessions/host-session" \
    && ! -e "$profile_home/encryption_key" ]] \
    || fail "$profile copied host Copilot configuration, sessions, MCPs, or encryption material"
done

before_native_auth_failure_hash="$(profile_tree_hash "$expected_hve_home")"
native_auth_failure_status=0
FAKE_COPILOT_FAILURE_HOME="$expected_hve_home" \
FAKE_COPILOT_FAILURE_STATUS=1 \
FAKE_COPILOT_FAILURE_STDERR=$'Error: No authentication information found.\n' \
  "$launcher" hve --prompt 'requires native authentication' \
  >"$fixture_root/native-auth-failure.out" \
  2>"$fixture_root/native-auth-failure.err" \
  || native_auth_failure_status=$?
printf '%s\n' 'Error: No authentication information found.' \
  >"$fixture_root/native-auth-failure.expected.err"
[[ "$(shasum -a 256 "$fixture_root/native-auth-failure.err" | awk '{print $1}')" \
  == "$(shasum -a 256 "$fixture_root/native-auth-failure.expected.err" | awk '{print $1}')" ]] \
  || fail 'native authentication diagnostic was not passed through exactly'
[[ "$native_auth_failure_status" == '1' ]] \
  || fail "native authentication failure returned status $native_auth_failure_status instead of 1"
after_native_auth_failure_hash="$(profile_tree_hash "$expected_hve_home")"
[[ "$before_native_auth_failure_hash" == "$after_native_auth_failure_hash" ]] \
  || fail 'native authentication failure copied or changed profile state'

signal_pid_file="$fixture_root/signal-copilot.pid"
signal_status=0
FAKE_COPILOT_SIGNAL_PID_FILE="$signal_pid_file" \
  "$launcher" hve --prompt 'wait for signal' \
  >"$fixture_root/signal.out" \
  2>"$fixture_root/signal.err" &
signal_launcher_pid=$!
signal_attempt=0
while [[ ! -s "$signal_pid_file" && "$signal_attempt" -lt 100 ]]; do
  sleep 0.01
  signal_attempt=$((signal_attempt + 1))
done
[[ -s "$signal_pid_file" ]] || fail 'signal fixture did not start Copilot'
signal_copilot_pid="$(<"$signal_pid_file")"
kill -TERM "$signal_launcher_pid"
wait "$signal_launcher_pid" || signal_status=$?
sleep 0.05
signal_orphan=0
if kill -0 "$signal_copilot_pid" 2>/dev/null; then
  signal_orphan=1
  kill -TERM "$signal_copilot_pid" 2>/dev/null || true
fi
[[ "$signal_copilot_pid" == "$signal_launcher_pid" \
  && "$signal_status" == '143' \
  && "$signal_orphan" == '0' ]] \
  || fail 'launch did not preserve Copilot process identity and SIGTERM behavior'

unrelated_status=0
FAKE_COPILOT_FAILURE_HOME="$expected_hve_home" \
FAKE_COPILOT_FAILURE_STATUS=1 \
FAKE_COPILOT_FAILURE_STDOUT=$'unrelated partial output\n' \
FAKE_COPILOT_FAILURE_STDERR=$'fixture unrelated status 1 failure\n' \
  "$launcher" hve --prompt 'unrelated status 1 failure' \
  >"$fixture_root/unrelated-status-one.out" \
  2>"$fixture_root/unrelated-status-one.err" \
  || unrelated_status=$?
printf '%s\n' 'unrelated partial output' >"$fixture_root/unrelated-status-one.expected.out"
printf '%s\n' 'fixture unrelated status 1 failure' >"$fixture_root/unrelated-status-one.expected.err"
[[ "$unrelated_status" == '1' \
  && "$(shasum -a 256 "$fixture_root/unrelated-status-one.out" | awk '{print $1}')" \
    == "$(shasum -a 256 "$fixture_root/unrelated-status-one.expected.out" | awk '{print $1}')" \
  && "$(shasum -a 256 "$fixture_root/unrelated-status-one.err" | awk '{print $1}')" \
    == "$(shasum -a 256 "$fixture_root/unrelated-status-one.expected.err" | awk '{print $1}')" ]] \
  || fail 'unrelated status 1 failure was not preserved exactly'

unrelated_status=0
FAKE_COPILOT_FAILURE_HOME="$expected_hve_home" \
FAKE_COPILOT_FAILURE_STATUS=77 \
FAKE_COPILOT_FAILURE_STDOUT=$'unrelated 77 partial output\n' \
FAKE_COPILOT_FAILURE_STDERR=$'fixture unrelated status 77 failure\n' \
  "$launcher" hve --prompt 'unrelated status 77 failure' \
  >"$fixture_root/unrelated-status-77.out" \
  2>"$fixture_root/unrelated-status-77.err" \
  || unrelated_status=$?
printf '%s\n' 'unrelated 77 partial output' >"$fixture_root/unrelated-status-77.expected.out"
printf '%s\n' 'fixture unrelated status 77 failure' >"$fixture_root/unrelated-status-77.expected.err"
[[ "$unrelated_status" == '77' \
  && "$(shasum -a 256 "$fixture_root/unrelated-status-77.out" | awk '{print $1}')" \
    == "$(shasum -a 256 "$fixture_root/unrelated-status-77.expected.out" | awk '{print $1}')" \
  && "$(shasum -a 256 "$fixture_root/unrelated-status-77.err" | awk '{print $1}')" \
    == "$(shasum -a 256 "$fixture_root/unrelated-status-77.expected.err" | awk '{print $1}')" ]] \
  || fail 'unrelated status 77 failure was not preserved exactly'

binary_status=0
FAKE_COPILOT_BINARY_STDERR_HOME="$expected_hve_home" \
  "$launcher" hve --prompt 'binary stderr failure' \
  >"$fixture_root/binary-stderr.out" \
  2>"$fixture_root/binary-stderr.err" \
  || binary_status=$?
printf 'binary\0stderr\n' >"$fixture_root/binary-stderr.expected.err"
[[ "$binary_status" == '42' \
  && ! -s "$fixture_root/binary-stderr.out" \
  && "$(shasum -a 256 "$fixture_root/binary-stderr.err" | awk '{print $1}')" \
    == "$(shasum -a 256 "$fixture_root/binary-stderr.expected.err" | awk '{print $1}')" ]] \
  || fail 'binary stderr and original status were not passed through exactly'

assert_contains 'args=plugin install hve-core@hve-core ' "$fake_copilot_log"
assert_contains $'hve-core@hve-core\t3.2.2' \
  "$expected_hve_home/fake-state/plugins"
assert_not_contains 'args=plugin update ' "$fake_copilot_log"

before_list_calls="$(wc -l <"$fake_copilot_log" | tr -d ' ')"
list_output="$fixture_root/list.out"
"$launcher" list >"$list_output"
assert_contains $'hve\thve-core@hve-core' "$list_output"
assert_contains $'plannotator\tplannotator-effective-html@effective-html' "$list_output"
assert_contains $'superpowers\tsuperpowers@superpowers-marketplace' "$list_output"
assert_contains $'awesome\tawesome-copilot@awesome-copilot' "$list_output"
json_list_output="$fixture_root/list.json"
"$launcher" list --json >"$json_list_output"
jq -e '
  .schemaVersion == 1
  and .launcher == "cpx"
  and .harness == "copilot"
  and .sandbox == false
  and [.profiles[].name] == ["awesome", "hve", "plannotator", "superpowers"]
  and all(.profiles[]; (.description | type == "string" and length > 0))
  and .profiles[0].headless == {
    "schemaVersion": 1,
    "prompt": true,
    "outputFormats": ["text", "json"],
    "eventContract": null,
    "trellageEventContract": null,
    "sessionId": "none",
    "resume": false,
    "resumeWithPrompt": false,
    "questionToolControl": "hard-deny",
    "changedFiles": "none",
    "usage": false,
    "cost": false,
    "modelOverride": true,
    "effortOverride": false,
    "testedHarnessVersion": "1.0.81"
  }
  and .profiles[1].headless == .profiles[0].headless
  and .profiles[2].headless == .profiles[0].headless
  and .profiles[3].headless == .profiles[0].headless
  and .profiles[0].plugin == "awesome-copilot@awesome-copilot"
  and .profiles[0].source == null
  and .profiles[0].marketplace == {
    "kind": "built-in",
    "source": "github/awesome-copilot",
    "name": "awesome-copilot",
    "manifestUrl": "https://raw.githubusercontent.com/github/awesome-copilot/main/.github/plugin/marketplace.json"
  }
  and .profiles[0].standaloneMcps == []
  and .profiles[1].marketplace.kind == "git"
  and .profiles[2].plugin == "plannotator-effective-html@effective-html"
  and .profiles[2].marketplace == {
    "kind": "git",
    "source": "plannotator/effective-html",
    "name": "effective-html",
    "manifestUrl": "https://raw.githubusercontent.com/plannotator/effective-html/main/.agents/plugins/marketplace.json"
  }
  and .profiles[3].standaloneMcps == []
' "$json_list_output" >/dev/null || fail 'JSON list output differs'

FAKE_COPILOT_VERSION=1.0.81 "$launcher" list --json >"$fixture_root/list-drift.json"
jq -e '
  all(.profiles[]; .headless.prompt == true and .headless.testedHarnessVersion == "1.0.81")
' "$fixture_root/list-drift.json" >/dev/null || fail 'Copilot 1.0.81 prompt capability was not published'
[[ "$(wc -l <"$fake_copilot_log" | tr -d ' ')" == "$before_list_calls" ]] \
  || fail 'list invoked Copilot'

mkdir -p "$expected_hve_home/fake-state"
printf '%s\t%s\n' 'hve-core-preview' 'fixture/hve-core-preview' \
  >"$expected_hve_home/fake-state/marketplaces"
"$launcher" setup hve
assert_contains 'args=plugin marketplace add microsoft/hve-core ' "$fake_copilot_log"
assert_contains 'args=plugin install hve-core@hve-core ' "$fake_copilot_log"
[[ -f "$expected_hve_home/fake-state/plugins" ]] || fail 'setup did not use isolated profile state'
managed_instructions="$expected_hve_home/instructions/rundown.instructions.md"
[[ -f "$managed_instructions" && ! -L "$managed_instructions" ]] \
  || fail 'setup did not seed the managed instructions'
cmp -s "$managed_instructions" "$prototype_root/assets/rundown/rundown.instructions.md" \
  || fail 'seeded managed instructions differ'
cmp -s "$prototype_root/assets/rundown/rundown.instructions.md" \
  "$prototype_root/../trellage/assets/rundown/rundown.instructions.md" \
  || fail 'vendored instructions differ from the canonical copy'
cmp -s "$prototype_root/assets/rundown/NOTICE.md" \
  "$prototype_root/../trellage/assets/rundown/NOTICE.md" \
  || fail 'vendored notice differs from the canonical copy'
printf 'stale\n' >"$managed_instructions"
"$launcher" setup hve
cmp -s "$managed_instructions" "$prototype_root/assets/rundown/rundown.instructions.md" \
  || fail 'setup did not refresh the managed instructions'
rm -f "$managed_instructions"
ln -s /dev/null "$managed_instructions"
managed_instruction_status=0
"$launcher" setup hve \
  >"$fixture_root/managed-instructions.out" 2>"$fixture_root/managed-instructions.err" \
  || managed_instruction_status=$?
rm -f "$managed_instructions"
[[ "$managed_instruction_status" -ne 0 ]] \
  || fail 'setup accepted symlinked managed instructions'
assert_contains 'unsafe managed instructions' "$fixture_root/managed-instructions.err"
"$launcher" setup hve
mkdir -p \
  "$expected_hve_home/installed-plugins/hve-core/hve-core/skills/package-one" \
  "$expected_hve_home/installed-plugins/hve-core/hve-core/skills/package-two" \
  "$expected_hve_home/installed-plugins/unrelated/unrelated/skills/not-selected"
printf '%s\n' '# Package one' \
  >"$expected_hve_home/installed-plugins/hve-core/hve-core/skills/package-one/SKILL.md"
printf '%s\n' '# Package two' \
  >"$expected_hve_home/installed-plugins/hve-core/hve-core/skills/package-two/SKILL.md"
printf '%s\n' '# Unrelated package' \
  >"$expected_hve_home/installed-plugins/unrelated/unrelated/skills/not-selected/SKILL.md"
[[ ! -e "$HOME/.copilot/plugins/hve-core@hve-core" ]] \
  || fail 'setup leaked into global Copilot state'
marketplace_add_count="$(grep -Fc 'args=plugin marketplace add microsoft/hve-core ' "$fake_copilot_log")"
"$launcher" setup hve
[[ "$(grep -Fc 'args=plugin marketplace add microsoft/hve-core ' "$fake_copilot_log")" == "$marketplace_add_count" ]] \
  || fail 'repeated setup re-added an already registered marketplace'

doctor_output="$fixture_root/doctor.out"
"$launcher" doctor hve >"$doctor_output"
assert_contains 'hve: healthy' "$doctor_output"
inventory_output="$fixture_root/inventory.json"
"$launcher" inventory hve --json >"$inventory_output"
jq -e '
  .schemaVersion == 1
  and .launcher == "cpx"
  and .harness == "copilot"
  and .profile == "hve"
  and .readiness == "healthy"
  and .plugins == [{name:"hve-core@hve-core",version:"3.2.2"}]
  and .skills == {packageCount:2,visibleCount:3}
  and .mcps == ["docs","files"]
' "$inventory_output" >/dev/null || fail 'healthy inventory output differs'

plannotator_plugin_root="$expected_plannotator_home/installed-plugins/effective-html/plannotator-effective-html"
plannotator_install_count="$(grep -Fc \
  'args=plugin install plannotator-effective-html@effective-html ' "$fake_copilot_log")"
"$launcher" setup plannotator >"$fixture_root/plannotator-setup.out"
[[ "$(grep -Fc 'args=plugin install plannotator-effective-html@effective-html ' \
  "$fake_copilot_log")" == "$plannotator_install_count" ]] \
  || fail 'repeated Plannotator setup reinstalled its versionless plugin'
"$launcher" plannotator --prompt 'reuse versionless plugin' \
  >"$fixture_root/plannotator-launch.out"
"$launcher" repair plannotator >"$fixture_root/plannotator-repair.out"
[[ "$(grep -Fc 'args=plugin install plannotator-effective-html@effective-html ' \
  "$fake_copilot_log")" == "$plannotator_install_count" ]] \
  || fail 'Plannotator launch or repair reinstalled its versionless plugin'
"$launcher" doctor plannotator >"$fixture_root/plannotator-doctor.out"
assert_contains \
  'plannotator: healthy (plugin plannotator-effective-html@effective-html, version 0.4.0)' \
  "$fixture_root/plannotator-doctor.out"
"$launcher" inventory plannotator --json >"$fixture_root/plannotator-inventory.json"
jq -e '
  .schemaVersion == 1
  and .launcher == "cpx"
  and .harness == "copilot"
  and .profile == "plannotator"
  and .readiness == "healthy"
  and .plugins == [{name:"plannotator-effective-html@effective-html",version:"0.4.0"}]
  and .skills == {packageCount:6,visibleCount:7}
  and .mcps == ["docs","files"]
' "$fixture_root/plannotator-inventory.json" >/dev/null \
  || fail 'Plannotator inventory output differs'

(
  cd "$worktree"
  "$prototype_root/bin/cpx" plannotator --fixture-capability-inventory
) >"$fixture_root/plannotator-capabilities.out"
assert_line 'plugin:plannotator-effective-html@effective-html' \
  "$fixture_root/plannotator-capabilities.out"
for skill in \
  design-artifact \
  html \
  html-diagram \
  html-plan \
  html-prototype \
  html-wireframe; do
  assert_line "plugin-skill:$skill" "$fixture_root/plannotator-capabilities.out"
done
[[ "$(grep -c '^plugin-skill:' "$fixture_root/plannotator-capabilities.out")" == '6' ]] \
  || fail 'Plannotator capability inventory did not expose exactly six plugin skills'

mv "$plannotator_plugin_root/skills/html-plan/SKILL.md" \
  "$plannotator_plugin_root/skills/html-plan/SKILL.md.safe"
if "$launcher" doctor plannotator \
  >"$fixture_root/plannotator-missing-skill.out" \
  2>"$fixture_root/plannotator-missing-skill.err"; then
  fail 'doctor accepted a missing required Plannotator skill'
fi
assert_contains \
  'cpx: required package skill is missing or unsafe: plannotator/html-plan' \
  "$fixture_root/plannotator-missing-skill.err"
if "$launcher" plannotator --prompt 'missing required skill' \
  >"$fixture_root/plannotator-missing-skill-launch.out" \
  2>"$fixture_root/plannotator-missing-skill-launch.err"; then
  fail 'launch accepted a missing required Plannotator skill'
fi
assert_contains \
  'cpx: required package skill is missing or unsafe: plannotator/html-plan' \
  "$fixture_root/plannotator-missing-skill-launch.err"
mv "$plannotator_plugin_root/skills/html-plan/SKILL.md.safe" \
  "$plannotator_plugin_root/skills/html-plan/SKILL.md"

if FAKE_COPILOT_DISABLED_SKILL=html-plan "$launcher" doctor plannotator \
  >"$fixture_root/plannotator-disabled-skill.out" \
  2>"$fixture_root/plannotator-disabled-skill.err"; then
  fail 'doctor accepted a disabled required Plannotator skill'
fi
assert_contains \
  'cpx: required package skill is not enabled by Copilot: plannotator/html-plan' \
  "$fixture_root/plannotator-disabled-skill.err"
if FAKE_COPILOT_DISABLED_SKILL=html-plan \
  "$launcher" plannotator --prompt 'disabled required skill' \
  >"$fixture_root/plannotator-disabled-skill-launch.out" \
  2>"$fixture_root/plannotator-disabled-skill-launch.err"; then
  fail 'launch accepted a disabled required Plannotator skill'
fi
assert_contains \
  'cpx: required package skill is not enabled by Copilot: plannotator/html-plan' \
  "$fixture_root/plannotator-disabled-skill-launch.err"

mv "$plannotator_plugin_root/skills/html-diagram" \
  "$plannotator_plugin_root/skills/html-diagram.safe"
ln -s "$plannotator_plugin_root/skills/html" \
  "$plannotator_plugin_root/skills/html-diagram"
if "$launcher" doctor plannotator \
  >"$fixture_root/plannotator-symlink-skill.out" \
  2>"$fixture_root/plannotator-symlink-skill.err"; then
  fail 'doctor accepted a redirected Plannotator skill'
fi
assert_contains \
  'cpx: required package skill is missing or unsafe: plannotator/html-diagram' \
  "$fixture_root/plannotator-symlink-skill.err"
rm "$plannotator_plugin_root/skills/html-diagram"
mv "$plannotator_plugin_root/skills/html-diagram.safe" \
  "$plannotator_plugin_root/skills/html-diagram"

mv "$plannotator_plugin_root/.codex-plugin/plugin.json" \
  "$plannotator_plugin_root/.codex-plugin/plugin.json.safe"
ln -s "$plannotator_plugin_root/.codex-plugin/plugin.json.safe" \
  "$plannotator_plugin_root/.codex-plugin/plugin.json"
if "$launcher" doctor plannotator \
  >"$fixture_root/plannotator-symlink-version.out" \
  2>"$fixture_root/plannotator-symlink-version.err"; then
  fail 'doctor accepted a redirected Plannotator version manifest'
fi
assert_contains \
  'cpx: failed to resolve installed plugin version: plannotator-effective-html@effective-html' \
  "$fixture_root/plannotator-symlink-version.err"
rm "$plannotator_plugin_root/.codex-plugin/plugin.json"
mv "$plannotator_plugin_root/.codex-plugin/plugin.json.safe" \
  "$plannotator_plugin_root/.codex-plugin/plugin.json"

before_plannotator_check_hash="$(profile_tree_hash "$expected_plannotator_home")"
export FAKE_FORBID_PROFILE_MUTATION=1
"$launcher" update --check plannotator >"$fixture_root/plannotator-check.out"
unset FAKE_FORBID_PROFILE_MUTATION
assert_contains 'plannotator: current (0.4.0)' "$fixture_root/plannotator-check.out"
assert_contains \
  'https://raw.githubusercontent.com/plannotator/effective-html/main/.codex-plugin/plugin.json' \
  "$fake_curl_log"
[[ "$(profile_tree_hash "$expected_plannotator_home")" == "$before_plannotator_check_hash" ]] \
  || fail 'Plannotator update --check mutated the profile home tree'

export FAKE_CURL_MALFORMED_VERSION_URL='https://raw.githubusercontent.com/plannotator/effective-html/main/.codex-plugin/plugin.json'
malformed_version_status=0
"$launcher" update --check plannotator \
  >"$fixture_root/plannotator-malformed-version.out" \
  2>"$fixture_root/plannotator-malformed-version.err" \
  || malformed_version_status=$?
unset FAKE_CURL_MALFORMED_VERSION_URL
[[ "$malformed_version_status" == '2' ]] \
  || fail "malformed Plannotator version returned status $malformed_version_status instead of 2"
assert_contains 'failed to fetch or parse official manifest for plannotator' \
  "$fixture_root/plannotator-malformed-version.err"
assert_not_contains 'plannotator: update available' \
  "$fixture_root/plannotator-malformed-version.out"

mv "$expected_hve_home/installed-plugins/hve-core/hve-core" \
  "$expected_hve_home/installed-plugins/hve-core/hve-core.safe"
ln -s "$expected_hve_home/installed-plugins/unrelated/unrelated" \
  "$expected_hve_home/installed-plugins/hve-core/hve-core"
if "$launcher" inventory hve --json \
  >"$fixture_root/symlink-plugin-root.out" 2>"$fixture_root/symlink-plugin-root.err"; then
  fail 'inventory accepted a redirected selected plugin root'
fi
assert_contains 'invalid installed plugin root for hve' \
  "$fixture_root/symlink-plugin-root.err"
rm "$expected_hve_home/installed-plugins/hve-core/hve-core"
mv "$expected_hve_home/installed-plugins/hve-core/hve-core.safe" \
  "$expected_hve_home/installed-plugins/hve-core/hve-core"
printf '%s\t%s\n' 'hve-core-all@hve-core' '3.3.101' \
  >>"$expected_hve_home/fake-state/plugins"
if "$launcher" doctor hve \
  >"$fixture_root/retired-hve-doctor.out" 2>"$fixture_root/retired-hve-doctor.err"; then
  fail 'doctor accepted a retired HVE plugin'
fi
assert_contains 'cpx: retired plugin is installed: hve; run: cpx repair hve' \
  "$fixture_root/retired-hve-doctor.err"
"$launcher" repair hve >"$fixture_root/retired-hve-repair.out"
assert_contains 'args=plugin uninstall hve-core-all@hve-core ' "$fake_copilot_log"
assert_not_contains 'hve-core-all@hve-core' "$expected_hve_home/fake-state/plugins"
assert_contains $'hve-core@hve-core\t3.2.2' "$expected_hve_home/fake-state/plugins"
rm -rf "$HOME/.local/share/trellage/profiles/copilot/awesome"
"$launcher" inventory awesome --json >"$fixture_root/not-setup-inventory.json"
jq -e '
  .profile == "awesome"
  and .readiness == "not-setup"
  and .plugins == []
  and .skills == {packageCount:null,visibleCount:null}
  and .mcps == []
' "$fixture_root/not-setup-inventory.json" >/dev/null \
  || fail 'not-setup inventory output differs'
mkdir -p "$expected_hve_home/skills/personal"
printf '%s\n' '# User-managed personal skill' >"$expected_hve_home/skills/personal/SKILL.md"
"$launcher" doctor hve >"$fixture_root/doctor-skill.out" \
  || fail 'doctor rejected an unrelated user-managed skill'
[[ -f "$expected_hve_home/skills/personal/SKILL.md" ]] \
  || fail 'doctor removed an unrelated user-managed skill'
rm -rf "$expected_hve_home/skills/personal"
printf '%s\n' '{"mcpServers":{"standalone":{}}}' >"$expected_hve_home/mcp-config.json"
if "$launcher" doctor hve >"$fixture_root/doctor-mcp.out" 2>"$fixture_root/doctor-mcp.err"; then
  fail 'doctor accepted a standalone profile MCP'
fi
printf '%s\n' '{"mcpServers":{}}' >"$expected_hve_home/mcp-config.json"

before_check_hash="$(profile_tree_hash "$expected_hve_home")"
before_check_calls="$(wc -l <"$fake_copilot_log" | tr -d ' ')"
check_output="$fixture_root/check.out"
export FAKE_FORBID_PROFILE_MUTATION=1
"$launcher" update --check hve >"$check_output"
unset FAKE_FORBID_PROFILE_MUTATION
assert_contains 'hve: current (3.2.2)' "$check_output"
assert_contains 'https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json' "$fake_curl_log"
after_check_hash="$(profile_tree_hash "$expected_hve_home")"
[[ "$before_check_hash" == "$after_check_hash" ]] || fail 'update --check mutated the profile home tree'
[[ "$(wc -l <"$fake_copilot_log" | tr -d ' ')" == "$((before_check_calls + 1))" ]] \
  || fail 'update --check invoked a mutating Copilot command'
assert_contains 'args=plugin list ' "$fake_copilot_log"

sessions_sentinel="$expected_hve_home/sessions/keep"
permissions_sentinel="$expected_hve_home/permissions/keep"
auth_sentinel="$expected_hve_home/auth.json"
mkdir -p "$(dirname "$sessions_sentinel")" "$(dirname "$permissions_sentinel")"
printf 'session\n' >"$sessions_sentinel"
printf 'permission\n' >"$permissions_sentinel"
printf 'auth\n' >"$auth_sentinel"

printf '%s\t%s\n' 'hve-core@hve-core' '3.2.1' >"$expected_hve_home/fake-state/plugins"
if "$launcher" update --check hve >"$fixture_root/outdated.out"; then
  fail 'update --check returned success for an outdated profile'
fi
assert_contains 'hve: update available (3.2.1 -> 3.2.2)' "$fixture_root/outdated.out"
before_update_curl_calls="$(wc -l <"$fake_curl_log" | tr -d ' ')"
"$launcher" update hve
[[ "$(wc -l <"$fake_curl_log" | tr -d ' ')" == "$before_update_curl_calls" ]] \
  || fail 'update fetched the manifest outside Copilot marketplace commands'
assert_contains 'args=plugin marketplace update hve-core ' "$fake_copilot_log"
assert_contains 'args=plugin update hve-core@hve-core ' "$fake_copilot_log"
assert_contains $'hve-core@hve-core\t3.2.2' "$expected_hve_home/fake-state/plugins"
[[ "$(<"$sessions_sentinel")" == 'session' \
  && "$(<"$permissions_sentinel")" == 'permission' \
  && "$(<"$auth_sentinel")" == 'auth' ]] \
  || fail 'update changed preserved profile state'

rm -f "$expected_hve_home/fake-state/plugins"
"$launcher" hve --prompt 'repair missing plugin during launch'
[[ "$(<"$sessions_sentinel")" == 'session' \
  && "$(<"$permissions_sentinel")" == 'permission' \
  && "$(<"$auth_sentinel")" == 'auth' ]] \
  || fail 'launch repair changed preserved profile state'
assert_contains $'hve-core@hve-core\t3.2.2' "$expected_hve_home/fake-state/plugins"
[[ "$(grep -Fc 'args=plugin marketplace add microsoft/hve-core ' "$fake_copilot_log")" == "$marketplace_add_count" ]] \
  || fail 'launch repair re-added an already registered marketplace'

awesome_marketplace_add_count="$(awk 'index($0, "args=plugin marketplace add github/awesome-copilot ") { count++ } END { print count + 0 }' "$fake_copilot_log")"
awesome_missing_builtin_status=0
mkdir -p "$fixture_root/awesome-decoy-home"
HOME="$fixture_root/awesome-decoy-home" FAKE_HIDE_AWESOME_MARKETPLACE=1 \
  "$launcher" setup awesome \
  >"$fixture_root/awesome-missing-built-in.out" \
  2>"$fixture_root/awesome-missing-built-in.err" \
  || awesome_missing_builtin_status=$?
[[ "$awesome_missing_builtin_status" != '0' ]] \
  || fail 'awesome setup accepted a missing built-in marketplace'
[[ "$(<"$fixture_root/awesome-missing-built-in.err")" \
  == 'cpx: required built-in marketplace is unavailable: awesome-copilot' ]] \
  || fail 'awesome setup did not report the missing built-in marketplace'
next_awesome_marketplace_add_count="$(awk 'index($0, "args=plugin marketplace add github/awesome-copilot ") { count++ } END { print count + 0 }' "$fake_copilot_log")"
[[ "$next_awesome_marketplace_add_count" == "$awesome_marketplace_add_count" ]] \
  || fail 'awesome setup registered a missing built-in marketplace'

"$launcher" setup --all
assert_contains 'args=plugin marketplace add obra/superpowers-marketplace ' "$fake_copilot_log"
assert_contains 'args=plugin install superpowers@superpowers-marketplace ' "$fake_copilot_log"
assert_contains 'args=plugin marketplace add plannotator/effective-html ' "$fake_copilot_log"
assert_contains 'args=plugin install plannotator-effective-html@effective-html ' \
  "$fake_copilot_log"
[[ -f "$expected_superpowers_home/fake-state/plugins" ]] \
  || fail 'setup --all did not provision superpowers'
[[ -f "$expected_plannotator_home/fake-state/plugins" ]] \
  || fail 'setup --all did not provision Plannotator'
assert_contains $'awesome-copilot@awesome-copilot\t1.1.0' \
  "$expected_awesome_home/fake-state/plugins"
[[ "$(awk 'index($0, "args=plugin marketplace add github/awesome-copilot ") { count++ } END { print count + 0 }' "$fake_copilot_log")" == "$awesome_marketplace_add_count" ]] \
  || fail 'setup --all registered the built-in awesome marketplace'

printf '%s\n' $'superpowers@superpowers-marketplace\t6.2.0' \
  >>"$expected_hve_home/fake-state/plugins"
if "$launcher" doctor hve >"$fixture_root/hve-superpowers-doctor.out" \
  2>"$fixture_root/hve-superpowers-doctor.err"; then
  fail 'doctor accepted Superpowers in the HVE profile'
fi
assert_contains 'cpx: forbidden Superpowers plugin is installed: hve; run: cpx repair hve' \
  "$fixture_root/hve-superpowers-doctor.err"
"$launcher" repair hve >"$fixture_root/hve-superpowers-repair.out"
assert_not_contains 'superpowers@' "$expected_hve_home/fake-state/plugins"
assert_contains $'hve-core@hve-core\t3.2.2' \
  "$expected_hve_home/fake-state/plugins"

mkdir -p "$expected_hve_home/installed-plugins/custom/renamed/.claude-plugin"
printf '%s\n' \
  '{"name":"renamed","repository":"git@github.com:obra/superpowers.git"}' \
  >"$expected_hve_home/installed-plugins/custom/renamed/.claude-plugin/plugin.json"
printf '%s\n' \
  $'superpowers\t6.2.0' \
  $'renamed@custom\t6.2.0' \
  >>"$expected_hve_home/fake-state/plugins"
launch_calls_before="$(grep -Fvc 'args=plugin list ' "$fake_copilot_log")"
"$launcher" hve --prompt contaminated \
  >"$fixture_root/hve-contaminated-launch.out" \
  2>"$fixture_root/hve-contaminated-launch.err" \
  || fail 'ordinary launch did not self-heal forbidden Superpowers plugins'
assert_not_contains $'superpowers\t' "$expected_hve_home/fake-state/plugins"
assert_not_contains $'renamed@custom\t' "$expected_hve_home/fake-state/plugins"
assert_contains $'hve-core@hve-core\t3.2.2' \
  "$expected_hve_home/fake-state/plugins"
[[ "$(grep -Fvc 'args=plugin list ' "$fake_copilot_log")" -gt "$launch_calls_before" ]] \
  || fail 'self-healed launch did not start the underlying Copilot agent'

for profile in awesome hve plannotator superpowers; do
  "$launcher" doctor "$profile" >"$fixture_root/$profile-native-auth-doctor.out"
  assert_contains "$profile: healthy" "$fixture_root/$profile-native-auth-doctor.out"
done

awesome_inventory_output="$fixture_root/awesome-provisioned-inventory.out"
(
  cd "$worktree"
  "$prototype_root/bin/cpx" awesome --fixture-capability-inventory
) >"$awesome_inventory_output"
assert_line 'plugin:awesome-copilot@awesome-copilot' "$awesome_inventory_output"
assert_line 'plugin-skill:suggest-awesome-github-copilot-agents' "$awesome_inventory_output"
assert_line 'plugin-skill:suggest-awesome-github-copilot-instructions' "$awesome_inventory_output"
assert_line 'plugin-skill:suggest-awesome-github-copilot-skills' "$awesome_inventory_output"
[[ "$(grep -c '^plugin-skill:' "$awesome_inventory_output")" == '3' ]] \
  || fail 'awesome capability inventory did not expose exactly three plugin skills'
assert_line 'repository-skill:repository-skill' "$awesome_inventory_output"
for global_capability in \
  global-plugin \
  personal-skill \
  global-mcp-one \
  global-mcp-two \
  global-mcp-three \
  global-mcp-four \
  global-mcp-five \
  global-mcp-six \
  global-mcp-seven; do
  assert_not_contains "$global_capability" "$awesome_inventory_output"
done

awesome_plugin_install_count="$(grep -Fc 'args=plugin install awesome-copilot@awesome-copilot ' "$fake_copilot_log")"
"$launcher" setup awesome
[[ "$(grep -Fc 'args=plugin install awesome-copilot@awesome-copilot ' "$fake_copilot_log")" == "$awesome_plugin_install_count" ]] \
  || fail 'repeated awesome setup reinstalled its plugin'
"$launcher" doctor awesome >"$fixture_root/awesome-doctor.out"
assert_contains 'awesome: healthy' "$fixture_root/awesome-doctor.out"
"$launcher" update --check awesome >"$fixture_root/awesome-check.out"
assert_contains 'awesome: current (1.1.0)' "$fixture_root/awesome-check.out"
"$launcher" update awesome >"$fixture_root/awesome-update.out"
assert_contains 'awesome: updated' "$fixture_root/awesome-update.out"
assert_contains 'args=plugin marketplace update awesome-copilot ' "$fake_copilot_log"
"$launcher" repair awesome >"$fixture_root/awesome-repair.out"
"$launcher" repair awesome >>"$fixture_root/awesome-repair.out"
[[ "$(grep -Fc 'awesome: repaired' "$fixture_root/awesome-repair.out")" == '2' ]] \
  || fail 'awesome repair did not complete twice'
[[ "$(grep -Fc 'args=plugin install awesome-copilot@awesome-copilot ' "$fake_copilot_log")" == "$awesome_plugin_install_count" ]] \
  || fail 'awesome repair reinstalled its plugin'
[[ "$(awk 'index($0, "args=plugin marketplace add github/awesome-copilot ") { count++ } END { print count + 0 }' "$fake_copilot_log")" == "$awesome_marketplace_add_count" ]] \
  || fail 'awesome lifecycle registered the built-in marketplace'

export FAKE_CURL_FAILURE_URL='https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json'
check_all_status=0
"$launcher" update --check --all \
  >"$fixture_root/check-all-failure.out" \
  2>"$fixture_root/check-all-failure.err" \
  || check_all_status=$?
unset FAKE_CURL_FAILURE_URL
[[ "$check_all_status" == '2' ]] \
  || fail "manifest transport failure returned status $check_all_status instead of 2"
assert_contains 'failed to fetch or parse official manifest for superpowers' \
  "$fixture_root/check-all-failure.err"
assert_contains 'hve: current (3.2.2)' "$fixture_root/check-all-failure.out"
assert_not_contains 'superpowers: update available' "$fixture_root/check-all-failure.out"

export FAKE_CURL_FAILURE_URL='https://raw.githubusercontent.com/microsoft/hve-core/main/.github/plugin/marketplace.json'
check_single_status=0
"$launcher" update --check hve \
  >"$fixture_root/check-single-manifest-failure.out" \
  2>"$fixture_root/check-single-manifest-failure.err" \
  || check_single_status=$?
unset FAKE_CURL_FAILURE_URL
[[ "$check_single_status" == '2' ]] \
  || fail "single-profile manifest failure returned status $check_single_status instead of 2"
assert_contains 'failed to fetch or parse official manifest for hve' \
  "$fixture_root/check-single-manifest-failure.err"
assert_not_contains 'hve: update available' "$fixture_root/check-single-manifest-failure.out"

export FAKE_COPILOT_LIST_FAILURE_HOME="$expected_hve_home"
check_single_status=0
"$launcher" update --check hve \
  >"$fixture_root/check-single-state-failure.out" \
  2>"$fixture_root/check-single-state-failure.err" \
  || check_single_status=$?
unset FAKE_COPILOT_LIST_FAILURE_HOME
[[ "$check_single_status" == '2' ]] \
  || fail "installed-state read failure returned status $check_single_status instead of 2"
assert_contains 'failed to read installed plugin version for hve' \
  "$fixture_root/check-single-state-failure.err"
assert_not_contains 'hve: not installed' "$fixture_root/check-single-state-failure.out"

if "$launcher" not-a-profile >"$fixture_root/unknown.out" 2>"$fixture_root/unknown.err"; then
  fail 'unknown profile was accepted'
fi
assert_contains 'unknown profile: not-a-profile' "$fixture_root/unknown.err"

runtime_root="$HOME/.local/share/trellage/cpx"
installed="$HOME/.local/bin/cpx"
mkdir -p "$(dirname "$installed")"
ln -s "$runtime_root/bin/cpx" "$installed"
if "$installer" >"$fixture_root/dangling-command-install.out" 2>"$fixture_root/dangling-command-install.err"; then
  fail 'installer claimed an unowned dangling command symlink'
fi
assert_contains 'refusing to replace unrelated command' "$fixture_root/dangling-command-install.err"
[[ -L "$installed" && "$(readlink "$installed")" == "$runtime_root/bin/cpx" ]] \
  || fail 'installer changed an unowned dangling command symlink'
rm "$installed"

mkdir -p "$runtime_root/bin"
printf 'unrelated launcher\n' >"$runtime_root/bin/cpx"
printf 'unrelated catalog\n' >"$runtime_root/catalog.json"
if "$installer" >"$fixture_root/unowned-install.out" 2>"$fixture_root/unowned-install.err"; then
  fail 'installer overwrote an unowned runtime root'
fi
assert_contains 'refusing unowned runtime root' "$fixture_root/unowned-install.err"
assert_contains 'unrelated launcher' "$runtime_root/bin/cpx"
assert_contains 'unrelated catalog' "$runtime_root/catalog.json"
if "$uninstaller" >"$fixture_root/unowned-uninstall.out" 2>"$fixture_root/unowned-uninstall.err"; then
  fail 'uninstaller deleted an unowned runtime root'
fi
assert_contains 'refusing unowned runtime root' "$fixture_root/unowned-uninstall.err"
assert_contains 'unrelated launcher' "$runtime_root/bin/cpx"
assert_contains 'unrelated catalog' "$runtime_root/catalog.json"
rm -rf "$runtime_root"

"$installer"
[[ -x "$installed" ]] || fail 'installer did not create ~/.local/bin/cpx'
assert_contains 'trellage-profiles-v1' "$runtime_root/.managed-by-trellage-profiles"
for asset in rundown.instructions.md NOTICE.md; do
  [[ -f "$runtime_root/assets/rundown/$asset" && ! -L "$runtime_root/assets/rundown/$asset" ]] \
    || fail "installer did not publish asset: $asset"
  cmp -s "$runtime_root/assets/rundown/$asset" "$prototype_root/assets/rundown/$asset" \
    || fail "installed asset differs: $asset"
done
"$installed" list >"$fixture_root/installed-list.out"
assert_contains $'hve\thve-core@hve-core' "$fixture_root/installed-list.out"
assert_contains $'plannotator\tplannotator-effective-html@effective-html' \
  "$fixture_root/installed-list.out"
"$installer"
"$uninstaller"
[[ ! -e "$installed" && ! -L "$installed" ]] || fail 'uninstaller left ~/.local/bin/cpx behind'
[[ ! -e "$runtime_root/assets" ]] || fail 'uninstaller left runtime assets behind'
[[ -d "$HOME/.local/share/trellage/profiles/copilot/hve/home" ]] \
  || fail 'uninstaller removed profile state'

original_share="$fixture_root/original-share"
redirected_share="$fixture_root/redirected-share"
mv "$HOME/.local/share" "$original_share"
mkdir -p "$redirected_share"
printf 'runtime ancestor sentinel\n' >"$redirected_share/sentinel"
ln -s "$redirected_share" "$HOME/.local/share"
runtime_ancestor_install_status=0
"$installer" \
  >"$fixture_root/runtime-ancestor-install.out" \
  2>"$fixture_root/runtime-ancestor-install.err" \
  || runtime_ancestor_install_status=$?
rm -f "$installed"
rm "$HOME/.local/share"
mv "$original_share" "$HOME/.local/share"
[[ "$runtime_ancestor_install_status" -ne 0 ]] \
  || fail 'installer accepted a symlinked runtime ancestor'
assert_contains 'runtime ancestor sentinel' "$redirected_share/sentinel"
[[ ! -e "$redirected_share/trellage/cpx" ]] \
  || fail 'installer created runtime files through a symlinked ancestor'

mv "$HOME/.local/share" "$original_share"
mkdir -p "$redirected_share/trellage/cpx/bin"
printf 'trellage-profiles-v1\n' >"$redirected_share/trellage/cpx/.managed-by-trellage-profiles"
printf 'redirected launcher sentinel\n' >"$redirected_share/trellage/cpx/bin/cpx"
printf 'redirected catalog sentinel\n' >"$redirected_share/trellage/cpx/catalog.json"
ln -s "$redirected_share" "$HOME/.local/share"
runtime_ancestor_uninstall_status=0
"$uninstaller" \
  >"$fixture_root/runtime-ancestor-uninstall.out" \
  2>"$fixture_root/runtime-ancestor-uninstall.err" \
  || runtime_ancestor_uninstall_status=$?
rm "$HOME/.local/share"
mv "$original_share" "$HOME/.local/share"
[[ "$runtime_ancestor_uninstall_status" -ne 0 ]] \
  || fail 'uninstaller accepted a symlinked runtime ancestor'
assert_contains 'redirected launcher sentinel' "$redirected_share/trellage/cpx/bin/cpx"
assert_contains 'redirected catalog sentinel' "$redirected_share/trellage/cpx/catalog.json"

original_command_dir="$fixture_root/original-command-dir"
redirected_command_dir="$fixture_root/redirected-command-dir"
mv "$HOME/.local/bin" "$original_command_dir"
mkdir -p "$redirected_command_dir"
printf 'command ancestor sentinel\n' >"$redirected_command_dir/sentinel"
ln -s "$redirected_command_dir" "$HOME/.local/bin"
command_ancestor_install_status=0
"$installer" \
  >"$fixture_root/command-ancestor-install.out" \
  2>"$fixture_root/command-ancestor-install.err" \
  || command_ancestor_install_status=$?
command_ancestor_install_created_command=false
command_ancestor_install_created_runtime=false
[[ -e "$redirected_command_dir/cpx" || -L "$redirected_command_dir/cpx" ]] \
  && command_ancestor_install_created_command=true
[[ -e "$runtime_root" || -L "$runtime_root" ]] \
  && command_ancestor_install_created_runtime=true
rm -f "$redirected_command_dir/cpx"
rm "$HOME/.local/bin"
mv "$original_command_dir" "$HOME/.local/bin"
rm -rf "$runtime_root"
[[ "$command_ancestor_install_status" -ne 0 ]] \
  || fail 'installer accepted a symlinked command ancestor'
[[ "$command_ancestor_install_created_command" == false ]] \
  || fail 'installer created a command through a symlinked ancestor'
[[ "$command_ancestor_install_created_runtime" == false ]] \
  || fail 'installer mutated runtime before rejecting a symlinked command ancestor'
assert_contains 'command ancestor sentinel' "$redirected_command_dir/sentinel"

mkdir -p "$runtime_root/bin"
printf 'trellage-profiles-v1\n' >"$runtime_root/.managed-by-trellage-profiles"
printf 'owned launcher sentinel\n' >"$runtime_root/bin/cpx"
printf 'owned catalog sentinel\n' >"$runtime_root/catalog.json"
mv "$HOME/.local/bin" "$original_command_dir"
ln -s "$runtime_root/bin/cpx" "$redirected_command_dir/cpx"
ln -s "$redirected_command_dir" "$HOME/.local/bin"
command_ancestor_uninstall_status=0
"$uninstaller" \
  >"$fixture_root/command-ancestor-uninstall.out" \
  2>"$fixture_root/command-ancestor-uninstall.err" \
  || command_ancestor_uninstall_status=$?
command_ancestor_uninstall_preserved_command=false
command_ancestor_uninstall_preserved_runtime=false
[[ -L "$redirected_command_dir/cpx" ]] \
  && command_ancestor_uninstall_preserved_command=true
[[ -f "$runtime_root/bin/cpx" && -f "$runtime_root/catalog.json" ]] \
  && command_ancestor_uninstall_preserved_runtime=true
rm -f "$redirected_command_dir/cpx"
rm "$HOME/.local/bin"
mv "$original_command_dir" "$HOME/.local/bin"
rm -rf "$runtime_root"
[[ "$command_ancestor_uninstall_status" -ne 0 ]] \
  || fail 'uninstaller accepted a symlinked command ancestor'
[[ "$command_ancestor_uninstall_preserved_command" == true ]] \
  || fail 'uninstaller removed a command through a symlinked ancestor'
[[ "$command_ancestor_uninstall_preserved_runtime" == true ]] \
  || fail 'uninstaller mutated runtime before rejecting a symlinked command ancestor'
assert_contains 'command ancestor sentinel' "$redirected_command_dir/sentinel"

symlink_runtime_target="$fixture_root/unrelated-runtime-target"
mkdir -p "$symlink_runtime_target/bin"
printf 'symlink sentinel\n' >"$symlink_runtime_target/bin/cpx"
ln -s "$symlink_runtime_target" "$runtime_root"
if "$installer" >"$fixture_root/symlink-install.out" 2>"$fixture_root/symlink-install.err"; then
  fail 'installer accepted a symlinked runtime root'
fi
assert_contains 'refusing unsafe symlinked runtime root' "$fixture_root/symlink-install.err"
if "$uninstaller" >"$fixture_root/symlink-uninstall.out" 2>"$fixture_root/symlink-uninstall.err"; then
  fail 'uninstaller accepted a symlinked runtime root'
fi
assert_contains 'refusing unsafe symlinked runtime root' "$fixture_root/symlink-uninstall.err"
assert_contains 'symlink sentinel' "$symlink_runtime_target/bin/cpx"
rm "$runtime_root"

mkdir -p "$HOME/.local/bin"
printf '%s\n' '#!/usr/bin/env bash' 'printf unrelated' >"$installed"
chmod 0755 "$installed"
if "$installer" >"$fixture_root/collision.out" 2>"$fixture_root/collision.err"; then
  fail 'installer overwrote an unrelated cpx command'
fi
assert_contains 'refusing to replace unrelated command' "$fixture_root/collision.err"
assert_contains 'printf unrelated' "$installed"

printf 'trellage profiles contract: PASS\n'
