#!/usr/bin/env bash
# Run against the established three-profile fixture before its final assertions.
migration_common="$fixture_root/home/.local/share/trellage/common"
migration_old="$migration_common/skills"
migration_old_youtube="$migration_common/codex-youtube-skills"
mv "$fixture_skills_cache" "$migration_old"
mv "$fixture_youtube_skills_cache" "$migration_old_youtube"
cp "$migration_old/managed-skills.txt" "$fixture_root/legacy-native-manifest"
cp "$migration_old_youtube/managed-skills.txt" "$fixture_root/legacy-youtube-manifest"
cp "$fixture_skills_runtime/config.toml" "$fixture_root/skills-catalog-before-migration"
chmod 0644 "$fixture_skills_runtime/config.toml"
mkdir -p "$fixture_skill_sources/astra/.omp/skills/astra-orchestrator"
printf '%s\n' '---' 'name: astra-orchestrator' 'description: Fixture skill' '---' '# Astra orchestrator' \
  >"$fixture_skill_sources/astra/.omp/skills/astra-orchestrator/SKILL.md"
git -C "$fixture_skill_sources/astra" init -q
git -C "$fixture_skill_sources/astra" add .
git -C "$fixture_skill_sources/astra" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'Seed migration skills'
cat >"$fixture_skills_runtime/config.toml" <<'TOML'
[skills]
schema = 1
[skills.sources.common]
repository = "https://github.com/trellage-fixture/migration-common.git"
select = ["fixture-personal", "show-me"]
adapter = "omp-native"
[skills.sources.astra]
repository = "https://github.com/trellage-fixture/astra.git"
select = ["astra-orchestrator"]
adapter = "omp-native"
[skills.sources.youtube]
repository = "https://github.com/trellage-fixture/migration-youtube.git"
select = ["youtube-full"]
adapter = "omp-native"
[skills.bundles]
native-common = ["common"]
codex-common = ["astra"]
youtube = ["youtube"]
TOML
refresh_fixture_source "$fixture_skills_runtime" \
  || fail 'could not prepare the synthetic skill migration runtime'
mv "$fake_bin/git" "$fake_bin/git-before-skills-migration"
cat >"$fake_bin/git" <<'SH'
#!/usr/bin/env bash
for argument in "$@"; do
  if [ "$argument" = fetch ]; then
    [ "${FAKE_MIGRATION_OFFLINE:-0}" = 0 ] || exit 99
    printf '%s\n' fetch >>"$FAKE_MIGRATION_FETCH_LOG"
  fi
done
exec "$(dirname "$0")/git-before-skills-migration" "$@"
SH
chmod 0755 "$fake_bin/git"
export FAKE_MIGRATION_FETCH_LOG="$fixture_root/migration-fetch.log"
: >"$FAKE_MIGRATION_FETCH_LOG"
for migration_profile in pstack superpowers youtube; do
  migration_home="$fixture_root/home/.local/share/trellage/profiles/codex/$migration_profile/home"
  mkdir -p "$migration_home/skills/personal-migration-skill"
  printf '%s\n' 'Preserve custom skill bytes' >"$migration_home/skills/personal-migration-skill/SKILL.md"
  HOME="$fixture_root/home" TRANSCRIPT_API_KEY=fixture-token fake_env \
    "$fixture_launcher" "$migration_profile" --version \
    >"$fixture_root/migration-$migration_profile.out" \
    || fail "launch skill migration failed: $migration_profile"
  grep -Fxq astra-orchestrator "$migration_home/skills/.trellage-managed-skills" \
    || fail "Astra missing from managed discovery: $migration_profile"
  grep -Fq 'name: astra-orchestrator' "$migration_home/skills/astra-orchestrator/SKILL.md" \
    || fail "Astra discovery content missing: $migration_profile"
  grep -Fxq 'Preserve custom skill bytes' "$migration_home/skills/personal-migration-skill/SKILL.md" \
    || fail "migration changed custom skill: $migration_profile"
done
[ "$(wc -l <"$FAKE_MIGRATION_FETCH_LOG" | tr -d ' ')" = 3 ] \
  || fail 'migration must fetch each of the three sources once across both bundles'
export FAKE_MIGRATION_OFFLINE=1
for migration_profile in pstack superpowers youtube; do
  HOME="$fixture_root/home" TRANSCRIPT_API_KEY=fixture-token fake_env \
    "$fixture_launcher" "$migration_profile" --version \
    >"$fixture_root/migration-offline-$migration_profile.out" \
    || fail "migrated launch required fetching: $migration_profile"
done
cmp -s "$migration_old/managed-skills.txt" "$fixture_root/legacy-native-manifest" \
  || fail 'migration changed legacy common cache'
cmp -s "$migration_old_youtube/managed-skills.txt" "$fixture_root/legacy-youtube-manifest" \
  || fail 'migration changed legacy YouTube cache'
unset FAKE_MIGRATION_OFFLINE FAKE_MIGRATION_FETCH_LOG
mv "$fake_bin/git-before-skills-migration" "$fake_bin/git"
cp "$fixture_root/skills-catalog-before-migration" "$fixture_skills_runtime/config.toml"
chmod 0444 "$fixture_skills_runtime/config.toml"
refresh_fixture_source "$fixture_skills_runtime" \
  || fail 'could not restore skill runtime readiness after migration'
