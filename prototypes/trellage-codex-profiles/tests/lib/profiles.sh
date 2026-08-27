# Machinery for the two blocks that drive the real `pstack` and `superpowers`
# profile homes. Sourced after lib/fixture.sh.

write_isolation_snapshot() {
  local label="$1" profile home

  for profile in pstack superpowers; do
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

# Reproduces the durable main-profile state that the auth/config/launch block
# leaves behind, so the lifecycle block can build its own fixture instead of
# waiting on that block. Anything here that drifts from what the launcher really
# produces would let the lifecycle block pass for the wrong reason, so this runs
# the launcher for real rather than fabricating profile contents.
establish_main_profiles() {
  build_fixture_profiles
  write_fake_bin

  mkdir -p "$fixture_root/home/.codex" "$fixture_root/original-cwd"
  original_cwd="$(CDPATH= cd -- "$fixture_root/original-cwd" && pwd)"
  real_cp="$(command -v cp)"
  printf '%s\n' \
    'host-only-secret = "must-not-copy"' \
    '[mcp_servers.host-only]' \
    'command = "must-not-copy"' >"$fixture_root/home/.codex/config.toml"

  HOME="$fixture_root/home" fake_env "$fixture_launcher" setup pstack \
    >"$fixture_root/prelude-setup-pstack.out" || fail 'setup pstack failed'
  pstack_home="$fixture_root/home/.local/share/trellage/profiles/codex/pstack/home"
  [ -d "$pstack_home" ] || fail 'setup did not create pstack home'

  : >"$fixture_root/fake-codex.log"
  HOME="$fixture_root/home" PATH="$fake_bin:$PATH" \
    FAKE_CODEX_LOG="$fixture_root/fake-codex.log" "$fixture_launcher" setup --all \
    >"$fixture_root/prelude-setup-all.out" || fail 'setup --all failed'
  superpowers_home="$fixture_root/home/.local/share/trellage/profiles/codex/superpowers/home"
  [ -d "$superpowers_home" ] || fail 'setup --all did not create superpowers home'

  write_main_plugin_cache
  cp "$pstack_home/config.toml" "$fixture_root/prelude-managed-config.toml"
  write_custom_main_config "$fixture_root/prelude-managed-config.toml"
  cp "$custom_config" "$pstack_home/config.toml"
  chmod 0600 "$pstack_home/config.toml"

  mkdir -p "$superpowers_home/plugins/cache/superpowers-marketplace/unrelated/1.0.0"
  printf '%s\n' 'unrelated cache bytes must stay exact' \
    >"$superpowers_home/plugins/cache/superpowers-marketplace/unrelated/1.0.0/.fake-materialized-cache"
}

# The selected and unrelated pstack plugin caches the launcher inspects. `setup`
# already materializes the selected cache through the fake Codex stub, so this
# only records its path and adds an unrelated cache to prove it is never counted.
# Shared so the config block and the lifecycle block's prelude build identical
# trees.
write_main_plugin_cache() {
pstack_cache="$pstack_home/plugins/cache/pstack-for-codex-local/pstack-for-codex/0.1.0"
[ -d "$pstack_cache" ] || fail 'setup did not materialize the pstack plugin cache'
mkdir -p "$pstack_home/plugins/cache/pstack-for-codex-local/unrelated/9.9.9/skills/not-selected"
printf '%s\n' '# Unrelated package' \
  >"$pstack_home/plugins/cache/pstack-for-codex-local/unrelated/9.9.9/skills/not-selected/SKILL.md"
}

# Layers the profile-local and user-owned sections onto a pristine managed
# config, producing `$custom_config`. Shared for the same reason: the lifecycle
# block asserts against these user-owned tables, so its prelude must build them
# exactly as the config block does.
write_custom_main_config() {
  local base_config="$1"

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
  sed -n '1,7p' "$base_config"
  cat "$profile_local"
  sed -n '9,$p' "$base_config"
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
}
