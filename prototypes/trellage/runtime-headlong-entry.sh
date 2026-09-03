#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

# Persistent Headlong state is hydrated from these immutable image assets.
readonly state_home=/home/agent/.headlong
readonly seed_root=/usr/local/share/trellage/headlong-seed
readonly seed_commit_file=/usr/local/share/trellage/headlong-seed.commit
readonly skill_seed_root=/usr/local/share/trellage/headlong-skills
readonly tui_seed=/usr/local/share/trellage/headlong-tui
readonly app_home="$state_home/app"
readonly identities_home="$app_home/.identities"
readonly legacy_identities_home="$state_home/identities"
readonly metadata_home="$state_home/.trellage"
readonly seed_marker="$metadata_home/seed.sha256"
readonly baseline_marker="$metadata_home/baseline.commit"
readonly source_marker="$metadata_home/source.commit"
readonly initialized_marker="$metadata_home/initialized"
readonly managed_manifest="$metadata_home/managed-skills.tsv"
readonly managed_skills_home="$metadata_home/skills"
readonly lock_file="$metadata_home/state.lock"
readonly web_args='--host 0.0.0.0 --port 8080'
readonly proxy_api_url='http://copilot-proxy-rs:8080/v1/messages'
readonly proxy_model='claude-sonnet-5'
readonly proxy_compatibility_token='trellage-local-proxy'
# Managed checkout installer target: never the upstream network bootstrap.
readonly local_bin_home=/home/agent/.local/bin
readonly provider_env_vars=(
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
  GEMINI_API_KEY
  OPENROUTER_API_KEY
  LLM_API_URL
  SHELLM_API_URL
  SHELLM_MODEL
)

staged_path=
backup_path=
marker_backup_path=
hash_records=
app_transaction_active=false
app_had_previous=false
standalone_identity_migration=false
tui_temporary=

fail() {
  printf 'trellage-headlong-entry: %s\n' "$1" >&2
  exit "${2:-1}"
}

managed_git() {
  local directory="$1"
  local stage_id
  shift
  case "$directory" in
    "$app_home") ;;
    "$metadata_home"/app.stage.*)
      stage_id="${directory#"$metadata_home"/app.stage.}"
      [[ "$stage_id" =~ ^[1-9][0-9]*$ ]] \
        || fail "Headlong Git directory is outside managed state: $directory"
      ;;
    *) fail "Headlong Git directory is outside managed state: $directory" ;;
  esac
  git -c "safe.directory=$directory" -C "$directory" "$@"
}

# Remove ambient provider and proxy settings before controlled initialization
# and before opening an attached shell.
strip_provider_env() {
  unset "${provider_env_vars[@]}"
}

cleanup() {
  local status=$?
  local rollback_complete=true
  trap - EXIT HUP INT TERM
  [[ -z "$hash_records" ]] || rm -f -- "$hash_records"
  [[ -z "$tui_temporary" ]] || rm -f -- "$tui_temporary"
  if [[ "$app_transaction_active" == true ]]; then
    if [[ "$app_had_previous" == true ]]; then
      if [[ -n "$backup_path" && -e "$backup_path" ]]; then
        if [[ ! -e "$backup_path/.identities" && ! -L "$backup_path/.identities" ]]; then
          if [[ -d "$identities_home" && ! -L "$identities_home" ]]; then
            mv -- "$identities_home" "$backup_path/.identities" || rollback_complete=false
          elif [[ -n "$staged_path" \
            && -d "$staged_path/.identities" && ! -L "$staged_path/.identities" ]]; then
            mv -- "$staged_path/.identities" "$backup_path/.identities" \
              || rollback_complete=false
          else
            rollback_complete=false
          fi
        fi
        if [[ "$rollback_complete" == true ]]; then
          rm -rf -- "$app_home"
          mv -- "$backup_path" "$app_home" || rollback_complete=false
        fi
      fi
      if [[ "$rollback_complete" == true \
        && -n "$marker_backup_path" && -d "$marker_backup_path" ]]; then
        cp -p -- "$marker_backup_path/seed.sha256" "$seed_marker" 2>/dev/null || true
        cp -p -- "$marker_backup_path/baseline.commit" "$baseline_marker" 2>/dev/null || true
        cp -p -- "$marker_backup_path/source.commit" "$source_marker" 2>/dev/null || true
      fi
    else
      if [[ "$standalone_identity_migration" == true ]]; then
        if [[ -d "$identities_home" && ! -L "$identities_home" ]]; then
          mv -- "$identities_home" "$legacy_identities_home" \
            || rollback_complete=false
        elif [[ -n "$staged_path" \
          && -d "$staged_path/.identities" && ! -L "$staged_path/.identities" ]]; then
          mv -- "$staged_path/.identities" "$legacy_identities_home" \
            || rollback_complete=false
        else
          rollback_complete=false
        fi
      fi
      if [[ "$rollback_complete" == true ]]; then
        rm -rf -- "$app_home"
        rm -f -- "$seed_marker" "$baseline_marker" "$source_marker"
      fi
    fi
  fi
  if [[ "$rollback_complete" == true ]]; then
    [[ -z "$staged_path" ]] || rm -rf -- "$staged_path"
    [[ -z "$backup_path" ]] || rm -rf -- "$backup_path"
    [[ -z "$marker_backup_path" ]] || rm -rf -- "$marker_backup_path"
  else
    printf 'trellage-headlong-entry: rollback could not safely restore the identity directory; transaction paths were preserved\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    fail 'sha256sum or shasum is required'
  fi
}

tree_digest() {
  local root="$1"
  local file mode relative
  hash_records="$metadata_home/.seed-records.$$"
  [[ ! -e "$hash_records" && ! -L "$hash_records" ]] \
    || fail 'seed digest temporary path already exists'
  : >"$hash_records"
  while IFS= read -r file; do
    relative="${file#"$root"/}"
    [[ "$relative" != "$file" && -n "$relative" ]] || fail 'seed contains an unsafe path'
    mode="$(stat -c '%a' -- "$file")"
    printf '%s  %s  %s\n' "$(sha256_file "$file")" "$mode" "$relative" >>"$hash_records"
  done < <(find "$root" -type f -print | LC_ALL=C sort)
  sha256_file "$hash_records"
  rm -f -- "$hash_records"
  hash_records=
}

validate_layout() {
  [[ -d "$seed_root" && ! -L "$seed_root" ]] \
    || fail "Headlong image seed is unavailable: $seed_root"
  [[ -f "$seed_root/tools/headlong-init" && -x "$seed_root/tools/headlong-init" ]] \
    || fail 'Headlong image seed does not contain an executable tools/headlong-init'
  [[ -f "$seed_root/install.sh" && -x "$seed_root/install.sh" ]] \
    || fail 'Headlong image seed does not contain an executable install.sh'
  [[ -f "$seed_commit_file" && ! -L "$seed_commit_file" ]] \
    || fail "Headlong image seed commit is unavailable: $seed_commit_file"
  [[ "$(cat "$seed_commit_file")" =~ ^[0-9a-f]{7,40}$ ]] \
    || fail 'Headlong image seed commit is not a valid commit hash'
  [[ -f "$tui_seed" && ! -L "$tui_seed" && -x "$tui_seed" ]] \
    || fail 'Headlong image does not contain the immutable TUI executable'
  [[ -d "$skill_seed_root/skills" && ! -L "$skill_seed_root/skills" ]] \
    || fail "Headlong managed skill seed is unavailable: $skill_seed_root/skills"
  [[ -f "$skill_seed_root/managed-skills.tsv" \
    && ! -L "$skill_seed_root/managed-skills.tsv" ]] \
    || fail 'Headlong managed skill manifest is unavailable'
  validate_managed_skill_manifest
  [[ -z "$(find "$seed_root" "$skill_seed_root" -type l -print -quit)" ]] \
    || fail 'Headlong image seeds must not contain symlinks'

  mkdir -p -- "$state_home" "$metadata_home"
  [[ -d "$state_home" && ! -L "$state_home" ]] \
    || fail 'Headlong state home must be a non-symlink directory'
  [[ -d "$metadata_home" && ! -L "$metadata_home" ]] \
    || fail 'Headlong metadata home must be a non-symlink directory'
  [[ ! -e "$lock_file" || ( -f "$lock_file" && ! -L "$lock_file" ) ]] \
    || fail 'Headlong state lock must be a regular file'
}

ensure_state_layout() {
  if [[ -e "$legacy_identities_home" || -L "$legacy_identities_home" ]]; then
    [[ ( -d "$legacy_identities_home" && ! -L "$legacy_identities_home" ) \
      || ( -L "$legacy_identities_home" \
        && "$(readlink "$legacy_identities_home")" == app/.identities ) ]] \
      || fail 'Headlong compatibility identity path is unsafe'
  fi
  if [[ -e "$state_home/.env" || -L "$state_home/.env" ]]; then
    [[ -f "$state_home/.env" && ! -L "$state_home/.env" ]] \
      || fail 'Headlong .env must be a regular file'
    # A pre-existing .env must already be exactly mode 600; fail closed
    # instead of silently repairing a looser mode a caller left behind.
    [[ "$(stat -c '%a' -- "$state_home/.env")" == 600 ]] \
      || fail 'Headlong .env must already be exactly mode 600'
  else
    : >"$state_home/.env"
    chmod 0600 -- "$state_home/.env"
  fi
}

ensure_application_identity_layout() {
  if [[ -L "$identities_home" ]]; then
    [[ "$(readlink "$identities_home")" == ../identities \
      && -d "$legacy_identities_home" && ! -L "$legacy_identities_home" ]] \
      || fail 'Headlong application identity link is unsafe'
    rm -f -- "$identities_home"
  fi

  if [[ ! -e "$identities_home" && ! -L "$identities_home" ]]; then
    if [[ -d "$legacy_identities_home" && ! -L "$legacy_identities_home" ]]; then
      mv -- "$legacy_identities_home" "$identities_home"
    else
      mkdir -- "$identities_home"
    fi
  fi
  [[ -d "$identities_home" && ! -L "$identities_home" ]] \
    || fail 'Headlong application identities must be a non-symlink directory'

  if [[ -e "$legacy_identities_home" || -L "$legacy_identities_home" ]]; then
    [[ -L "$legacy_identities_home" \
      && "$(readlink "$legacy_identities_home")" == app/.identities ]] \
      || fail 'Headlong compatibility identity path is unsafe'
  else
    ln -s app/.identities "$legacy_identities_home"
  fi
}

write_marker() {
  local destination="$1"
  local value="$2"
  local temporary="$metadata_home/.$(basename "$destination").$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] \
    || fail "marker temporary path already exists: $temporary"
  printf '%s\n' "$value" >"$temporary"
  mv -f -- "$temporary" "$destination"
}

initialize_baseline_repository() {
  local directory="$1"
  rm -rf -- "$directory/.git"
  managed_git "$directory" init -q
  managed_git "$directory" add -A
  managed_git "$directory" \
    -c user.name='Trellage Headlong' \
    -c user.email='trellage@localhost' \
    -c commit.gpgsign=false \
    commit -q -m 'Trellage Headlong image baseline'
  [[ -z "$(managed_git "$directory" remote)" ]] \
    || fail 'local Headlong baseline unexpectedly has an upstream remote'
}

# The per-identity persona launcher lives beside the installed entry point
# in local_bin_home (see run_initializer), never inside the tracked
# application tree. There is no exemption here: any untracked or tracked
# entry in the app tree — including anything that merely looks like a
# persona link — leaves the tree dirty and blocks an automatic seed
# replacement below.
application_tree_is_dirty() {
  local status_line status_output
  status_output="$(managed_git "$app_home" status --porcelain=v1 --untracked-files=all)"
  while IFS= read -r status_line; do
    [[ -z "$status_line" ]] && continue
    # Upstream's npm fallback creates this beside the committed bun.lock.
    [[ "$status_line" == '?? web/viewer/package-lock.json' ]] && continue
    return 0
  done <<<"$status_output"
  return 1
}

install_seed() {
  local digest="$1"
  local source_commit="$2"
  local baseline
  staged_path="$metadata_home/app.stage.$$"
  backup_path="$metadata_home/app.backup.$$"
  marker_backup_path="$metadata_home/markers.backup.$$"
  [[ ! -e "$staged_path" && ! -L "$staged_path" \
    && ! -e "$backup_path" && ! -L "$backup_path" \
    && ! -e "$marker_backup_path" && ! -L "$marker_backup_path" ]] \
    || fail 'Headlong application transaction path already exists'
  mkdir -- "$staged_path"
  cp -R --preserve=mode --no-preserve=ownership,timestamps -- "$seed_root"/. "$staged_path"/
  mkdir -- "$staged_path/.identities"
  initialize_baseline_repository "$staged_path"
  baseline="$(managed_git "$staged_path" rev-parse HEAD)"

  if [[ -e "$app_home" || -L "$app_home" ]]; then
    app_had_previous=true
    app_transaction_active=true
    mv -- "$app_home" "$backup_path"
    mkdir -- "$marker_backup_path"
    cp -p -- "$seed_marker" "$marker_backup_path/seed.sha256"
    cp -p -- "$baseline_marker" "$marker_backup_path/baseline.commit"
    cp -p -- "$source_marker" "$marker_backup_path/source.commit"
    rmdir -- "$staged_path/.identities"
    mv -- "$backup_path/.identities" "$staged_path/.identities"
  else
    app_had_previous=false
    app_transaction_active=true
    backup_path=
    marker_backup_path=
    if [[ -d "$legacy_identities_home" && ! -L "$legacy_identities_home" ]]; then
      rmdir -- "$staged_path/.identities"
      mv -- "$legacy_identities_home" "$staged_path/.identities"
      standalone_identity_migration=true
    fi
  fi
  mv -- "$staged_path" "$app_home"
  staged_path=

  # Run the checkout's own installer against the verified, already-hydrated
  # application directory. This never takes the upstream network bootstrap
  # path (that path only runs when no local checkout is next to install.sh).
  ( cd -- "$app_home" && ./install.sh --symlinks --prefix "$local_bin_home" --no-init ) \
    || fail 'Headlong managed checkout installer failed'
  # The installer must place the real entry point the initializer phases
  # invoke, plus the persona binary it links identities to, directly in
  # local_bin_home — never leave either to be assumed.
  [[ -e "$local_bin_home/headlong-init" && ! -d "$local_bin_home/headlong-init" ]] \
    || fail 'Headlong managed checkout installer did not install headlong-init'
  [[ -x "$local_bin_home/headlong-init" ]] \
    || fail 'Headlong managed checkout installer installed a non-executable headlong-init'
  [[ -e "$local_bin_home/persona" && ! -d "$local_bin_home/persona" ]] \
    || fail 'Headlong managed checkout installer did not install persona'
  [[ -x "$local_bin_home/persona" ]] \
    || fail 'Headlong managed checkout installer installed a non-executable persona'
  tui_temporary="$local_bin_home/.headlong-tui.$$"
  [[ ! -e "$tui_temporary" && ! -L "$tui_temporary" ]] \
    || fail 'Headlong TUI temporary install path already exists'
  cp -- "$tui_seed" "$tui_temporary"
  chmod 0755 "$tui_temporary"
  mv -f -- "$tui_temporary" "$local_bin_home/headlong-tui"
  tui_temporary=

  write_marker "$seed_marker" "$digest"
  write_marker "$baseline_marker" "$baseline"
  write_marker "$source_marker" "$source_commit"
  [[ -z "$backup_path" ]] || rm -rf -- "$backup_path"
  backup_path=
  [[ -z "$marker_backup_path" ]] || rm -rf -- "$marker_backup_path"
  marker_backup_path=
  app_transaction_active=false
  app_had_previous=false
  standalone_identity_migration=false
  ensure_application_identity_layout
}

hydrate_application() {
  local desired_digest installed_digest installed_baseline installed_source current_source
  desired_digest="$(tree_digest "$seed_root")"
  current_source="$(cat "$seed_commit_file")"
  if [[ ! -e "$app_home" && ! -L "$app_home" ]]; then
    [[ ! -e "$seed_marker" && ! -e "$baseline_marker" && ! -e "$source_marker" ]] \
      || fail 'Headlong application is missing while seed metadata exists'
    install_seed "$desired_digest" "$current_source"
    return
  fi

  [[ -d "$app_home" && ! -L "$app_home" ]] \
    || fail 'Headlong application must be a non-symlink directory'
  ensure_application_identity_layout
  [[ -f "$seed_marker" && ! -L "$seed_marker" \
    && -f "$baseline_marker" && ! -L "$baseline_marker" \
    && -f "$source_marker" && ! -L "$source_marker" ]] \
    || fail 'Headlong application seed metadata is missing or unsafe'
  [[ -d "$app_home/.git" && ! -L "$app_home/.git" ]] \
    || fail 'Headlong application baseline repository is missing or unsafe'
  [[ -z "$(managed_git "$app_home" remote)" ]] \
    || fail 'Headlong application baseline must not have an upstream remote'

  installed_digest="$(cat "$seed_marker")"
  [[ "$installed_digest" =~ ^[0-9a-f]{64}$ ]] \
    || fail 'Headlong installed seed digest is invalid'
  installed_source="$(cat "$source_marker")"
  [[ "$installed_source" =~ ^[0-9a-f]{7,40}$ ]] \
    || fail 'Headlong installed source commit is invalid'
  [[ "$installed_digest" != "$desired_digest" || "$installed_source" != "$current_source" ]] \
    || return 0
  ! application_tree_is_dirty \
    || fail "Headlong source changed locally; refusing to upgrade from $installed_source to $current_source. Inspect and back up your changes first with: trellage shell headlong"
  installed_baseline="$(cat "$baseline_marker")"
  [[ "$installed_baseline" =~ ^[0-9a-f]{40,64}$ \
    && "$(managed_git "$app_home" rev-parse HEAD)" == "$installed_baseline" ]] \
    || fail "Headlong source history diverged; refusing to upgrade from $installed_source to $current_source. Inspect and back up your changes first with: trellage shell headlong"
  install_seed "$desired_digest" "$current_source"
}

validate_manifest_line() {
  local name="$1"
  local always_on="$2"
  local extra="$3"
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || fail "managed Headlong skill name is unsafe: $name"
  [[ "$always_on" == 0 || "$always_on" == 1 ]] \
    || fail "managed Headlong skill mode is invalid: $name"
  [[ -z "$extra" ]] || fail "managed Headlong skill manifest has extra fields: $name"
}

validate_managed_skill_manifest() {
  local manifest="$skill_seed_root/managed-skills.tsv"
  local line name always_on extra previous=
  local LC_ALL=C
  [[ -f "$manifest" && ! -L "$manifest" ]] \
    || fail 'Headlong managed skill manifest is unavailable'
  while IFS= read -r line || [[ -n "$line" ]]; do
    IFS=$'\t' read -r name always_on extra <<<"$line"
    validate_manifest_line "$name" "$always_on" "$extra"
    [[ "$line" == "$name"$'\t'"$always_on" ]] \
      || fail "managed Headlong skill manifest line is malformed: $name"
    if [[ -n "$previous" ]]; then
      [[ "$name" > "$previous" ]] \
        || fail "managed Headlong skill manifest is not sorted or contains a duplicate: $name"
    fi
    previous="$name"
  done <"$manifest"
}

check_managed_target() {
  local target="$1"
  local expected="$2"
  local label="$3"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -L "$target" && "$(readlink "$target")" == "$expected" ]] \
      || fail "managed Headlong skill collides with unmanaged state: $label"
  fi
}

sync_managed_skills() {
  local manifest="$skill_seed_root/managed-skills.tsv"
  local identity name always_on extra source target old_target expected
  local staged_skills="$metadata_home/skills.stage.$$"
  local backup_skills="$metadata_home/skills.backup.$$"
  validate_managed_skill_manifest
  [[ ! -e "$staged_skills" && ! -L "$staged_skills" \
    && ! -e "$backup_skills" && ! -L "$backup_skills" ]] \
    || fail 'managed Headlong skill transaction path already exists'
  [[ ! -e "$managed_manifest" \
    || ( -f "$managed_manifest" && ! -L "$managed_manifest" ) ]] \
    || fail 'managed Headlong skill state manifest is unsafe'
  if [[ ( -e "$managed_skills_home" || -L "$managed_skills_home" ) \
    && ! -f "$managed_manifest" ]]; then
    fail 'managed Headlong skill store collides with unmanaged state'
  fi
  mkdir -- "$staged_skills"
  staged_path="$staged_skills"

  while IFS=$'\t' read -r name always_on extra; do
    [[ -n "$name$always_on$extra" ]] || continue
    validate_manifest_line "$name" "$always_on" "$extra"
    source="$skill_seed_root/skills/$name"
    [[ -d "$source" && ! -L "$source" && -f "$source/SKILL.md" ]] \
      || fail "managed Headlong skill is missing or unsafe: $name"
    [[ -z "$(find "$source" -type l -print -quit)" ]] \
      || fail "managed Headlong skill contains a symlink: $name"
    [[ ! -e "$staged_skills/$name" ]] \
      || fail "managed Headlong skill is duplicated: $name"
    cp -R -- "$source" "$staged_skills/$name"
  done <"$manifest"

  for identity in "$identities_home"/*; do
    [[ -d "$identity" && ! -L "$identity" ]] || continue
    while IFS=$'\t' read -r name always_on extra; do
      [[ -n "$name$always_on$extra" ]] || continue
      validate_manifest_line "$name" "$always_on" "$extra"
      expected="$managed_skills_home/$name"
      if [[ "$always_on" == 1 ]]; then
        target="$identity/kernel/$name"
      else
        target="$identity/skills/$name"
      fi
      check_managed_target "$target" "$expected" "$name"
    done <"$manifest"
    if [[ -f "$managed_manifest" ]]; then
      while IFS=$'\t' read -r name always_on extra; do
        [[ -n "$name$always_on$extra" ]] || continue
        validate_manifest_line "$name" "$always_on" "$extra"
        expected="$managed_skills_home/$name"
        if [[ "$always_on" == 1 ]]; then
          old_target="$identity/kernel/$name"
        else
          old_target="$identity/skills/$name"
        fi
        check_managed_target "$old_target" "$expected" "$name"
      done <"$managed_manifest"
    fi
  done

  if [[ -e "$managed_skills_home" || -L "$managed_skills_home" ]]; then
    [[ -d "$managed_skills_home" && ! -L "$managed_skills_home" ]] \
      || fail 'managed Headlong skill store is unsafe'
    mv -- "$managed_skills_home" "$backup_skills"
  else
    backup_skills=
  fi
  mv -- "$staged_skills" "$managed_skills_home"
  staged_path=

  for identity in "$identities_home"/*; do
    [[ -d "$identity" && ! -L "$identity" ]] || continue
    mkdir -p -- "$identity/skills" "$identity/kernel"
    if [[ -f "$managed_manifest" ]]; then
      while IFS=$'\t' read -r name always_on extra; do
        [[ -n "$name$always_on$extra" ]] || continue
        if [[ "$always_on" == 1 ]]; then
          old_target="$identity/kernel/$name"
        else
          old_target="$identity/skills/$name"
        fi
        [[ ! -L "$old_target" ]] || rm -f -- "$old_target"
      done <"$managed_manifest"
    fi
    while IFS=$'\t' read -r name always_on extra; do
      [[ -n "$name$always_on$extra" ]] || continue
      if [[ "$always_on" == 1 ]]; then
        target="$identity/kernel/$name"
      else
        target="$identity/skills/$name"
      fi
      rm -f -- "$target"
      ln -s "$managed_skills_home/$name" "$target"
    done <"$manifest"
  done

  local manifest_temporary="$metadata_home/.managed-skills.tsv.$$"
  [[ ! -e "$manifest_temporary" && ! -L "$manifest_temporary" ]] \
    || fail 'managed Headlong skill manifest temporary path already exists'
  cp -- "$manifest" "$manifest_temporary"
  mv -f -- "$manifest_temporary" "$managed_manifest"
  [[ -z "$backup_skills" ]] || rm -rf -- "$backup_skills"
}

run_initializer() {
  local phase="$1"
  local -a strip=()
  local -a environment=(
    "HOME=/home/agent"
    "HEADLONG_HOME=$state_home"
    "HEADLONG_APP_DIR=$app_home"
    "HEADLONG_UNSANDBOXED=1"
    "ANTHROPIC_API_KEY=$proxy_compatibility_token"
    "LLM_API_URL=$proxy_api_url"
    "SHELLM_API_URL=$proxy_api_url"
    "SHELLM_MODEL=$proxy_model"
    "PATH=$app_home/bin:$app_home/tools:$local_bin_home:$PATH"
  )
  local var
  for var in "${provider_env_vars[@]}"; do
    strip+=(-u "$var")
  done
  if [[ "$phase" == bootstrap ]]; then
    environment+=("HEADLONG_NO_THINKERS=1" "HEADLONG_NO_DASH=1")
  else
    environment+=("HEADLONG_NO_TTY=1" "HEADLONG_WEB_ARGS=$web_args")
  fi
  # Invoke the installed entry point (never the app-tree source path) so the
  # pinned headlong-init creates its identity persona link beside $0 in
  # local_bin_home, matching install.sh --symlinks placement there.
  env "${strip[@]}" "${environment[@]}" "$local_bin_home/headlong-init"
  [[ -f "$state_home/.env" && ! -L "$state_home/.env" ]] \
    || fail 'Headlong initializer did not preserve a regular .env file'
  # Upstream _env_set chmods 600 itself; require it held, do not repair it.
  [[ "$(stat -c '%a' -- "$state_home/.env")" == 600 ]] \
    || fail 'Headlong initializer did not preserve .env at exactly mode 600'
}

lock_state() {
  [[ ! -e "$lock_file" || ( -f "$lock_file" && ! -L "$lock_file" ) ]] \
    || fail 'Headlong state lock must be a regular file'
  exec 9>>"$lock_file"
  flock -x 9
  [[ -f "$lock_file" && ! -L "$lock_file" ]] \
    || fail 'Headlong state lock changed while acquiring it'
}

unlock_state() {
  flock -u 9
}

dashboard_running() {
  local pid_file="$state_home/run/web.pid"
  local pid
  [[ -f "$pid_file" && ! -L "$pid_file" ]] || return 1
  IFS= read -r pid <"$pid_file"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

ensure_dashboard() {
  local pid_file="$state_home/run/web.pid"
  dashboard_running && return 0
  [[ ! -e "$pid_file" || ( -f "$pid_file" && ! -L "$pid_file" ) ]] \
    || fail 'Headlong dashboard PID path is unsafe'
  rm -f -- "$pid_file"
  if ! HEADLONG_HOME="$state_home" SHELLM_WEB_ARGS="$web_args" "$local_bin_home/persona" dash; then
    return 1
  fi
  dashboard_running
}

supervise_dashboard() {
  while :; do
    lock_state
    if ! ensure_dashboard; then
      printf 'trellage-headlong-entry: dashboard is unavailable; retrying without reinitializing\n' >&2
    fi
    unlock_state
    sleep 1
  done
}

service_mode() {
  strip_provider_env
  while :; do
    lock_state
    ensure_state_layout
    hydrate_application
    if [[ -f "$initialized_marker" && ! -L "$initialized_marker" \
      && "$(cat "$initialized_marker")" == initialized ]]; then
      sync_managed_skills
      unlock_state
      run_initializer restore
      supervise_dashboard
    fi
    [[ ! -e "$initialized_marker" && ! -L "$initialized_marker" ]] \
      || fail 'Headlong initialization marker is unsafe'
    unlock_state
    sleep 1
  done
}

attach_mode() {
  local shell="${SHELL:-/bin/bash}"
  [[ "$shell" == /* && -x "$shell" ]] || fail 'SHELL must select an executable absolute path'
  lock_state
  ensure_state_layout
  hydrate_application
  if [[ ! -e "$initialized_marker" && ! -L "$initialized_marker" ]]; then
    run_initializer bootstrap
    strip_provider_env
    sync_managed_skills
    run_initializer full
    write_marker "$initialized_marker" initialized
    strip_provider_env
    ensure_dashboard || fail 'Headlong dashboard did not start'
  elif [[ -f "$initialized_marker" && ! -L "$initialized_marker" \
    && "$(cat "$initialized_marker")" == initialized ]]; then
    sync_managed_skills
  else
    fail 'Headlong initialization marker is unsafe'
  fi
  unlock_state
  strip_provider_env
  cd "$app_home"
  export PATH="$local_bin_home:$PATH"
  exec "$shell" -l
}

[[ "$#" -eq 1 ]] || fail 'usage: runtime-headlong-entry service|attach'
validate_layout
case "$1" in
  service) service_mode ;;
  attach) attach_mode ;;
  *) fail "unsupported mode: $1" ;;
esac
