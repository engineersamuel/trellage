#!/usr/bin/env bash
set -euo pipefail

refuse() {
  printf 'cdx install: %s\n' "$1" >&2
  exit 1
}

home="${HOME-}"
[ -n "$home" ] || refuse 'refusing unsafe HOME: HOME is empty'
case "$home" in /*) ;; *) refuse "refusing unsafe HOME: HOME is not absolute: $home" ;; esac
[ -d "$home" ] && [ ! -L "$home" ] || refuse "refusing unsafe HOME: HOME is not a real directory: $home"
home="$(cd -L "$home" >/dev/null 2>&1 && pwd -L)" || refuse "refusing unsafe HOME: HOME is not a real directory: $home"
[ "$home" != / ] || refuse 'refusing unsafe HOME: HOME resolves to /'

source_dir="$(cd "$(dirname "$0")" && pwd)"
local_dir="$home/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/cdx"
installed_launcher="$install_root/bin/cdx"
ownership_marker="$install_root/.managed-by-trellage-codex-profiles"
ownership_value='trellage-codex-profiles-v1'
command_dir="$local_dir/bin"
command_path="$command_dir/cdx"
config_dir="$home/.config"
fish_dir="$home/.config/fish"
fish_config="$fish_dir/config.fish"
legacy_alias='alias cdx="codex --dangerously-bypass-approvals-and-sandbox"'

file_mode() {
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

IFS= read -r -d '' fish_definition_program <<'FISH_DEFINITION_AWK' || :
# Parse fish_indent --html output and count explicit literal cdx definitions.
# The input is generated HTML, not user-authored HTML; fish_indent escapes source text.

function fail_parse() {
  parse_failed = 1
}

function decode_html(value, output, position, tail, end_at, entity) {
  output = ""
  position = 1
  while (position <= length(value)) {
    if (substr(value, position, 1) != "&") {
      output = output substr(value, position, 1)
      position += 1
      continue
    }
    tail = substr(value, position)
    end_at = index(tail, ";")
    if (end_at == 0) {
      fail_parse()
      return ""
    }
    entity = substr(tail, 1, end_at)
    if (entity == "&amp;") output = output "&"
    else if (entity == "&lt;") output = output "<"
    else if (entity == "&gt;") output = output ">"
    else if (entity == "&quot;") output = output "\""
    else if (entity == "&apos;") output = output "'"
    else {
      fail_parse()
      return ""
    }
    position += end_at
  }
  return output
}

function reset_token() {
  token_literal = ""
  token_dynamic = 0
  token_command = 0
  token_other = 0
  token_active = 0
}

function append_literal(value) {
  token_literal = token_literal value
  token_active = 1
}

function append_segment(class_name, value, quote, inner) {
  if (value == "") return
  if (class_name == "fish_color_command") token_command = 1
  if (class_name == "fish_color_other") token_other = 1
  if (class_name == "fish_color_operator") {
    token_dynamic = 1
    append_literal(value)
    return
  }
  if (class_name == "fish_color_escape") {
    if (value == "\\\n") return
    if (length(value) == 2 && substr(value, 1, 1) == "\\") {
      append_literal(substr(value, 2, 1))
    } else {
      token_dynamic = 1
      append_literal(value)
    }
    return
  }
  if (class_name == "fish_color_quote") {
    quote = substr(value, 1, 1)
    if (length(value) >= 2 && (quote == "\"" || quote == "'") \
        && substr(value, length(value), 1) == quote) {
      inner = substr(value, 2, length(value) - 2)
      append_literal(inner)
    } else {
      token_dynamic = 1
      append_literal(value)
    }
    return
  }
  append_literal(value)
}

function reset_definition_state(position) {
  alias_active = 0
  alias_count = 0
  function_active = 0
  function_count = 0
  for (position in definition_token) delete definition_token[position]
  for (position in definition_dynamic) delete definition_dynamic[position]
}

function short_option_has_help(value) {
  return value ~ /^-[^-]*h[^-]*$/
}

function analyze_alias(position, value, parsing_options, definition_name) {
  parsing_options = 1
  definition_name = ""
  for (position = 1; position <= alias_count; position += 1) {
    value = definition_token[position]
    if (parsing_options && value == "--") {
      parsing_options = 0
      continue
    }
    if (parsing_options && (value == "--help" || short_option_has_help(value))) return
    if (parsing_options && (value == "-s" || value == "--save" \
        || value ~ /^--save=/)) continue
    if (parsing_options && (value == "-w" || value == "--wraps" \
        || value ~ /^-[^-]*w[^-]*$/)) {
      position += 1
      continue
    }
    if (parsing_options && value ~ /^--wraps=/) continue
    if (parsing_options && value ~ /^-/) continue
    if (definition_name == "") {
      if (definition_dynamic[position]) {
        ambiguous = 1
        return
      }
      definition_name = value
      sub(/=.*/, "", definition_name)
      if (definition_name ~ /\\/) {
        ambiguous = 1
        return
      }
    }
  }
  if (definition_name == "cdx") definitions += 1
}

function function_option_takes_value(value) {
  return value == "-d" || value == "--description" \
    || value == "-w" || value == "--wraps" \
    || value == "-V" || value == "--inherit-variable"
}

function analyze_function(position, value) {
  if (function_count == 0) return
  value = definition_token[1]
  if (definition_dynamic[1] || value ~ /\\/) {
    ambiguous = 1
    return
  }
  if (value == "--help" || short_option_has_help(value)) return
  if (value != "cdx") return
  for (position = 2; position <= function_count; position += 1) {
    value = definition_token[position]
    if (value == "--") break
    if (function_option_takes_value(value)) {
      position += 1
      continue
    }
    if (value == "--help" || short_option_has_help(value)) return
  }
  definitions += 1
}

function finish_definition() {
  if (alias_active) analyze_alias()
  if (function_active) analyze_function()
  reset_definition_state()
}

function handle_token(value, dynamic, is_command, is_other) {
  if (is_command || is_other) finish_definition()
  if (is_command && !dynamic && value == "alias") {
    alias_active = 1
    return
  }
  if (is_other && !dynamic && value == "function") {
    function_active = 1
    return
  }
  if (alias_active) {
    alias_count += 1
    definition_token[alias_count] = value
    definition_dynamic[alias_count] = dynamic
  } else if (function_active) {
    function_count += 1
    definition_token[function_count] = value
    definition_dynamic[function_count] = dynamic
  }
}

function flush_token() {
  if (!token_active) return
  handle_token(token_literal, token_dynamic, token_command, token_other)
  reset_token()
}

function process_normal(value, position, character) {
  for (position = 1; position <= length(value); position += 1) {
    character = substr(value, position, 1)
    if (character ~ /[[:space:]]/) {
      flush_token()
      continue
    }
    if (character == "\\" && substr(value, position + 1, 1) == "\n") {
      flush_token()
      position += 1
      continue
    }
    fail_parse()
    return
  }
}

function process_span(class_name, value, position, character, fragment) {
  if (class_name == "fish_color_statement_terminator") {
    flush_token()
    finish_definition()
    return
  }
  if (class_name == "fish_color_comment") {
    flush_token()
    finish_definition()
    return
  }
  if (class_name == "fish_color_normal") {
    process_normal(value)
    return
  }
  if (class_name == "fish_color_quote" || class_name == "fish_color_escape") {
    append_segment(class_name, value)
    return
  }
  fragment = ""
  for (position = 1; position <= length(value); position += 1) {
    character = substr(value, position, 1)
    if (character == "\\" && substr(value, position + 1, 1) == "\n") {
      if (fragment != "") append_segment(class_name, fragment)
      fragment = ""
      flush_token()
      position += 1
    } else if (character ~ /[[:space:]]/) {
      if (fragment != "") append_segment(class_name, fragment)
      fragment = ""
      flush_token()
    } else {
      fragment = fragment character
    }
  }
  if (fragment != "") append_segment(class_name, fragment)
}

function parse_document(position, prefix, class_end, close_at, class_name, content, tail) {
  prefix = "<pre><code>"
  if (substr(document, 1, length(prefix)) != prefix) {
    fail_parse()
    return
  }
  position = length(prefix) + 1
  while (1) {
    if (substr(document, position, 13) == "</code></pre>") {
      tail = substr(document, position + 13)
      if (tail !~ /^[[:space:]]*$/) fail_parse()
      return
    }
    if (substr(document, position, 13) != "<span class=\"") {
      fail_parse()
      return
    }
    position += 13
    class_end = index(substr(document, position), "\">")
    if (class_end == 0) {
      fail_parse()
      return
    }
    class_name = substr(document, position, class_end - 1)
    if (class_name !~ /^fish_color_[a-z_]+$/) {
      fail_parse()
      return
    }
    position += class_end + 1
    close_at = index(substr(document, position), "</span>")
    if (close_at == 0) {
      fail_parse()
      return
    }
    content = substr(document, position, close_at - 1)
    process_span(class_name, decode_html(content))
    if (parse_failed) return
    position += close_at + 6
  }
}

BEGIN {
  document = ""
  definitions = 0
  ambiguous = 0
  parse_failed = 0
  reset_token()
  reset_definition_state()
}

{
  document = document $0 "\n"
}

END {
  parse_document()
  flush_token()
  finish_definition()
  if (parse_failed || ambiguous) exit 2
  print definitions + 0
}
FISH_DEFINITION_AWK

count_fish_definitions() {
  awk "$fish_definition_program"
}

fish_indent_html() (
  local analysis_home=''
  cleanup_fish_analysis() {
    case "$analysis_home" in
      "${TMPDIR:-/tmp}"/trellage-cdx-fish-analysis.*) rm -rf -- "$analysis_home" ;;
    esac
  }
  trap cleanup_fish_analysis EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  analysis_home="$(mktemp -d "${TMPDIR:-/tmp}/trellage-cdx-fish-analysis.XXXXXX")" \
    || return 1
  case "$analysis_home" in
    "${TMPDIR:-/tmp}"/trellage-cdx-fish-analysis.*) ;;
    *) analysis_home=''; return 1 ;;
  esac
  chmod 0700 "$analysis_home" || return 1
  HOME="$analysis_home" XDG_DATA_HOME="$analysis_home/data" fish_indent --html "$@"
)

validate_directory() {
  [ ! -L "$1" ] && { [ ! -e "$1" ] || [ -d "$1" ]; } \
    || refuse "refusing unsafe managed path: $1"
}

for path in "$local_dir" "$share_dir" "$runtime_parent" "$command_dir" "$config_dir" "$fish_dir"; do
  validate_directory "$path"
done

for path in \
  "$source_dir" "$source_dir/bin" "$source_dir/marketplaces" \
  "$source_dir/marketplaces/hve-core" \
  "$source_dir/marketplaces/hve-core/.agents" \
  "$source_dir/marketplaces/hve-core/.agents/plugins"; do
  [ -d "$path" ] && [ ! -L "$path" ] || refuse "unsafe source adapter directory: $path"
done
for path in \
  "$source_dir/bin/cdx" "$source_dir/catalog.json" \
  "$source_dir/marketplaces/hve-core/.agents/plugins/marketplace.json"; do
  [ -f "$path" ] && [ ! -L "$path" ] && [ -r "$path" ] \
    || refuse "unsafe source runtime file: $path"
done

for command_name in fish fish_indent awk; do
  command -v "$command_name" >/dev/null 2>&1 \
    || refuse "required Fish analysis command is unavailable: $command_name"
done

[ -f "$fish_config" ] && [ ! -L "$fish_config" ] && [ -r "$fish_config" ] && [ -w "$fish_config" ] \
  || refuse "Fish config must be a readable, writable regular non-symlink file: $fish_config"
[ -w "$fish_dir" ] && [ -x "$fish_dir" ] || refuse "Fish config directory is not writable: $fish_dir"

runtime_owned=false
if [ -L "$install_root" ] || { [ -e "$install_root" ] && [ ! -d "$install_root" ]; }; then
  refuse "refusing unowned runtime root: $install_root"
fi
if [ -d "$install_root" ]; then
  [ -f "$ownership_marker" ] && [ ! -L "$ownership_marker" ] \
    || refuse "refusing unowned runtime root: $install_root"
  cmp -s "$ownership_marker" <(printf '%s\n' "$ownership_value") \
    || refuse "refusing unowned runtime root: $install_root"
  actual_entries="$(CDPATH= cd -- "$install_root" && find . -print | LC_ALL=C sort)"
  expected_entries="$(printf '%s\n' \
    '.' \
    './.fish-recovery' \
    './.fish-recovery/config-before' \
    './.fish-recovery/original-mode' \
    './.fish-recovery/removed-line' \
    './.fish-recovery/sha256-after' \
    './.fish-recovery/sha256-before' \
    './.managed-by-trellage-codex-profiles' \
    './bin' \
    './bin/cdx' \
    './catalog.json' \
    './marketplaces' \
    './marketplaces/hve-core' \
    './marketplaces/hve-core/.agents' \
    './marketplaces/hve-core/.agents/plugins' \
    './marketplaces/hve-core/.agents/plugins/marketplace.json')"
  [ "$actual_entries" = "$expected_entries" ] \
    || refuse "refusing unexpected content in owned runtime: $install_root"
  [ -z "$(find "$install_root" -type l -print -quit)" ] \
    || refuse "refusing symlinked content in owned runtime: $install_root"
  for path in \
    "$install_root/bin/cdx" "$install_root/catalog.json" \
    "$install_root/marketplaces/hve-core/.agents/plugins/marketplace.json" \
    "$install_root/.fish-recovery/config-before" \
    "$install_root/.fish-recovery/original-mode" \
    "$install_root/.fish-recovery/removed-line" \
    "$install_root/.fish-recovery/sha256-after" \
    "$install_root/.fish-recovery/sha256-before"; do
    [ -f "$path" ] && [ ! -L "$path" ] || refuse "refusing unsafe managed runtime file: $path"
  done
  runtime_owned=true
fi
if [ -e "$command_path" ] || [ -L "$command_path" ]; then
  [ "$runtime_owned" = true ] && [ -L "$command_path" ] \
    && [ "$(readlink "$command_path")" = "$installed_launcher" ] \
    || refuse "refusing to replace unrelated command: $command_path"
fi

if [ "$runtime_owned" = true ]; then
  recovery="$install_root/.fish-recovery"
  recovery_mode="$(sed -n '1p' "$recovery/original-mode")"
  case "$recovery_mode" in [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;; *) refuse 'invalid Fish recovery mode' ;; esac
  [ "$(wc -l <"$recovery/original-mode" | tr -d ' ')" -eq 1 ] \
    || refuse 'invalid Fish recovery mode'
  for name in sha256-before sha256-after; do
    value="$(sed -n '1p' "$recovery/$name")"
    [ "$(wc -l <"$recovery/$name" | tr -d ' ')" -eq 1 ] \
      || refuse "invalid Fish recovery hash: $name"
    case "$value" in *[!0-9a-f]*|'') refuse "invalid Fish recovery hash: $name" ;; esac
    [ "${#value}" -eq 64 ] || refuse "invalid Fish recovery hash: $name"
  done
  if [ -s "$recovery/removed-line" ]; then
    cmp -s "$recovery/removed-line" <(printf '%s\n' "$legacy_alias") \
      || refuse 'invalid Fish recovery alias'
  fi
  [ "$(sha256_file "$recovery/config-before")" = "$(sed -n '1p' "$recovery/sha256-before")" ] \
    || refuse 'Fish recovery backup hash differs'
fi

fish --no-config --no-execute "$fish_config" >/dev/null 2>&1 \
  || refuse 'Fish config has invalid syntax'

fish_probe='echo "<& alias function cdx>"
true && time not alias --save cdx="probe & value"
false || function cdx --wraps codex
end
echo alias function cdx'
printf '%s\n' "$fish_probe" | fish --no-config --no-execute >/dev/null 2>&1 \
  || refuse 'installed Fish parser rejected the compatibility probe'
probe_count="$(printf '%s\n' "$fish_probe" \
  | fish_indent_html \
  | count_fish_definitions)" \
  || refuse 'fish_indent semantic output is incompatible'
[ "$probe_count" -eq 2 ] \
  || refuse 'fish_indent semantic output failed the compatibility probe'

exact_count="$(grep -Fxc -- "$legacy_alias" "$fish_config" || :)"
definition_count="$(fish_indent_html "$fish_config" \
  | count_fish_definitions)" \
  || refuse 'Fish config contains an ambiguous literal alias or function definition'
fish_cutover=''
if [ "$runtime_owned" = false ] && [ "$exact_count" -eq 1 ] \
  && [ "$definition_count" -eq 1 ]; then
  fish_cutover=fresh-alias
elif [ "$runtime_owned" = true ] && [ "$exact_count" -eq 0 ] \
  && [ "$definition_count" -eq 0 ]; then
  fish_cutover=reinstall
elif [ "$runtime_owned" = false ] && [ "$exact_count" -eq 0 ] \
  && [ "$definition_count" -eq 0 ]; then
  fish_cutover=fresh-absent
else
  refuse 'Fish config must contain no cdx definition or exactly the known legacy cdx alias'
fi

staging_root=''
command_staging=''
fish_new=''
fish_old=''
fish_staged_hash=''
publication_active=false
fish_original_intent=false
fish_publish_intent=false
runtime_old_intent=false
runtime_publish_intent=false
command_old_intent=false
command_publish_intent=false
created_local_dir=false
created_share_dir=false
created_runtime_parent=false
created_command_dir=false

cleanup_staging() {
  if [ -n "$fish_new" ] && [ -f "$fish_new" ]; then rm -f -- "$fish_new"; fi
  if [ -n "$fish_old" ] && [ -f "$fish_old" ]; then rm -f -- "$fish_old"; fi
  if [ -n "$command_staging" ] && [ -d "$command_staging" ]; then
    rm -f -- "$command_staging/new-command" "$command_staging/old-command"
    rmdir "$command_staging" 2>/dev/null || :
  fi
  if [ -n "$staging_root" ] && [ -d "$staging_root" ]; then
    case "$staging_root" in "$runtime_parent"/.cdx-install.*) rm -rf -- "$staging_root" ;; esac
  fi
}

cleanup_created_parents() {
  if [ "$created_command_dir" = true ] && [ -d "$command_dir" ] && [ ! -L "$command_dir" ]; then
    rmdir "$command_dir" 2>/dev/null || :
  fi
  if [ "$created_runtime_parent" = true ] && [ -d "$runtime_parent" ] \
    && [ ! -L "$runtime_parent" ]; then
    rmdir "$runtime_parent" 2>/dev/null || :
  fi
  if [ "$created_share_dir" = true ] && [ -d "$share_dir" ] && [ ! -L "$share_dir" ]; then
    rmdir "$share_dir" 2>/dev/null || :
  fi
  if [ "$created_local_dir" = true ] && [ -d "$local_dir" ] && [ ! -L "$local_dir" ]; then
    rmdir "$local_dir" 2>/dev/null || :
  fi
}

rollback() {
  local ok=true
  if [ "$command_publish_intent" = true ] \
    && [ ! -e "$command_staging/new-command" ] \
    && { [ "$command_old_intent" = false ] || [ -L "$command_staging/old-command" ]; }; then
    if [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$installed_launcher" ]; then
      rm -f -- "$command_path" || ok=false
    else
      ok=false
    fi
  fi
  if [ -L "$command_staging/old-command" ]; then
    [ ! -e "$command_path" ] && [ ! -L "$command_path" ] \
      && mv "$command_staging/old-command" "$command_path" || ok=false
  fi
  if [ "$runtime_publish_intent" = true ] \
    && [ ! -d "$staging_root/new-runtime" ] \
    && { [ "$runtime_old_intent" = false ] || [ -d "$staging_root/old-runtime" ]; }; then
    if [ -d "$install_root" ] && [ ! -L "$install_root" ] \
      && [ -f "$ownership_marker" ] && [ ! -L "$ownership_marker" ] \
      && cmp -s "$ownership_marker" <(printf '%s\n' "$ownership_value"); then
      rm -rf -- "$install_root" || ok=false
    else
      ok=false
    fi
  fi
  if [ -d "$staging_root/old-runtime" ]; then
    [ ! -e "$install_root" ] && [ ! -L "$install_root" ] \
      && mv "$staging_root/old-runtime" "$install_root" || ok=false
  fi
  if [ "$fish_original_intent" = true ] && [ -n "$fish_old" ] && [ -f "$fish_old" ]; then
    if [ -e "$fish_config" ] || [ -L "$fish_config" ]; then
      if [ "$fish_publish_intent" = true ] \
        && [ -f "$fish_config" ] && [ ! -L "$fish_config" ] \
        && [ "$(sha256_file "$fish_config")" = "$fish_staged_hash" ]; then
        rm -f -- "$fish_config" || ok=false
      else
        ok=false
      fi
    fi
    if [ ! -e "$fish_config" ] && [ ! -L "$fish_config" ]; then
      mv "$fish_old" "$fish_config" || ok=false
      [ -e "$fish_old" ] || fish_old=''
    else
      ok=false
    fi
  fi
  [ "$ok" = true ]
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$publication_active" = true ]; then
    if rollback; then
      cleanup_staging
    else
      printf 'cdx install: rollback failed; recovery may be required\n' >&2
    fi
  else
    cleanup_staging
  fi
  if [ "$status" -ne 0 ]; then cleanup_created_parents; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -d "$local_dir" ]; then
  mkdir -m 0755 "$local_dir"
  created_local_dir=true
fi
if [ ! -d "$share_dir" ]; then
  mkdir -m 0755 "$share_dir"
  created_share_dir=true
fi
if [ ! -d "$runtime_parent" ]; then
  mkdir -m 0755 "$runtime_parent"
  created_runtime_parent=true
fi
if [ ! -d "$command_dir" ]; then
  mkdir -m 0755 "$command_dir"
  created_command_dir=true
fi

staging_root="$(mktemp -d "$runtime_parent/.cdx-install.XXXXXX")" \
  || refuse "could not create runtime staging in: $runtime_parent"
chmod 0700 "$staging_root"
mkdir -p "$staging_root/new-runtime/bin" \
  "$staging_root/new-runtime/marketplaces/hve-core/.agents/plugins" \
  "$staging_root/new-runtime/.fish-recovery"
chmod 0755 \
  "$staging_root/new-runtime" \
  "$staging_root/new-runtime/bin" \
  "$staging_root/new-runtime/marketplaces" \
  "$staging_root/new-runtime/marketplaces/hve-core" \
  "$staging_root/new-runtime/marketplaces/hve-core/.agents" \
  "$staging_root/new-runtime/marketplaces/hve-core/.agents/plugins"
chmod 0700 "$staging_root/new-runtime/.fish-recovery"
install -m 0755 "$source_dir/bin/cdx" "$staging_root/new-runtime/bin/cdx"
install -m 0644 "$source_dir/catalog.json" "$staging_root/new-runtime/catalog.json"
install -m 0644 "$source_dir/marketplaces/hve-core/.agents/plugins/marketplace.json" \
  "$staging_root/new-runtime/marketplaces/hve-core/.agents/plugins/marketplace.json"
printf '%s\n' "$ownership_value" >"$staging_root/new-runtime/.managed-by-trellage-codex-profiles"
chmod 0644 "$staging_root/new-runtime/.managed-by-trellage-codex-profiles"
[ "${CDX_INSTALL_TEST_FAIL_AT-}" != after-runtime-staging ] \
  || refuse 'injected failure at after-runtime-staging'

fish_mode="$(file_mode "$fish_config")"
fish_new="$(mktemp "$fish_dir/.cdx-fish.XXXXXX")" || refuse 'could not stage Fish config'
if [ "$fish_cutover" = fresh-alias ] || [ "$fish_cutover" = fresh-absent ]; then
  fish_before_hash="$(sha256_file "$fish_config")"
  if [ "$fish_cutover" = fresh-alias ]; then
    sed '\|^alias cdx="codex --dangerously-bypass-approvals-and-sandbox"$|d' \
      "$fish_config" >"$fish_new"
  else
    cp "$fish_config" "$fish_new"
  fi
  chmod "$fish_mode" "$fish_new"
  fish_after_hash="$(sha256_file "$fish_new")"
  install -m 0600 "$fish_config" "$staging_root/new-runtime/.fish-recovery/config-before"
  printf '%s\n' "$fish_mode" >"$staging_root/new-runtime/.fish-recovery/original-mode"
  printf '%s\n' "$fish_before_hash" >"$staging_root/new-runtime/.fish-recovery/sha256-before"
  printf '%s\n' "$fish_after_hash" >"$staging_root/new-runtime/.fish-recovery/sha256-after"
  if [ "$fish_cutover" = fresh-alias ]; then
    printf '%s\n' "$legacy_alias" >"$staging_root/new-runtime/.fish-recovery/removed-line"
  else
    : >"$staging_root/new-runtime/.fish-recovery/removed-line"
  fi
else
  cp "$fish_config" "$fish_new"
  chmod "$fish_mode" "$fish_new"
  for name in config-before original-mode sha256-before sha256-after removed-line; do
    cp "$install_root/.fish-recovery/$name" \
      "$staging_root/new-runtime/.fish-recovery/$name"
  done
fi
fish --no-config --no-execute "$fish_new" >/dev/null 2>&1 \
  || refuse 'staged Fish config has invalid syntax after legacy alias removal'
chmod 0600 "$staging_root/new-runtime/.fish-recovery/"*
fish_staged_hash="$(sha256_file "$fish_new")"
[ "${CDX_INSTALL_TEST_FAIL_AT-}" != after-fish-staging ] \
  || refuse 'injected failure at after-fish-staging'

command_staging="$(mktemp -d "$command_dir/.cdx-command.XXXXXX")" \
  || refuse "could not create command staging in: $command_dir"
chmod 0700 "$command_staging"
ln -s "$installed_launcher" "$command_staging/new-command"

publication_active=true
fish_old="$(mktemp "$fish_dir/.cdx-fish.XXXXXX")" || refuse 'could not stage original Fish config'
rm -f -- "$fish_old"
fish_original_intent=true
mv "$fish_config" "$fish_old"
[ "${CDX_INSTALL_TEST_FAIL_AT-}" != during-fish-publication ] \
  || refuse 'injected failure at during-fish-publication'
fish_publish_intent=true
mv "$fish_new" "$fish_config"
fish_new=''
[ "${CDX_INSTALL_TEST_FAIL_AT-}" != after-fish-publication ] \
  || refuse 'injected failure at after-fish-publication'

if [ -d "$install_root" ]; then
  runtime_old_intent=true
  mv "$install_root" "$staging_root/old-runtime"
fi
runtime_publish_intent=true
mv "$staging_root/new-runtime" "$install_root"
[ "${CDX_INSTALL_TEST_FAIL_AT-}" != after-runtime-publication ] \
  || refuse 'injected failure at after-runtime-publication'

if [ -L "$command_path" ]; then
  command_old_intent=true
  mv "$command_path" "$command_staging/old-command"
fi
command_publish_intent=true
mv "$command_staging/new-command" "$command_path"
[ "${CDX_INSTALL_TEST_FAIL_AT-}" != after-command-publication ] \
  || refuse 'injected failure at after-command-publication'

publication_active=false
cleanup_staging
memory_installer="$source_dir/../trellage-memory/install-deja.sh"
if [ "${TRELLAGE_MEMORY:-deja}" != off ]; then
  [ -f "$memory_installer" ] && [ ! -L "$memory_installer" ] && [ -x "$memory_installer" ] \
    || refuse "missing common Deja installer: $memory_installer"
  memory_home="$(CDPATH= cd -P -- "$home" && pwd -P)" \
    || refuse "cannot resolve common Deja home: $home"
  HOME="$memory_home" "$memory_installer" >/dev/null \
    || refuse 'could not install the common Deja runtime'
fi
printf 'Installed cdx at %s. Reload Fish to clear the legacy alias from existing shells.\n' "$command_path"
