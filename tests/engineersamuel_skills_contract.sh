#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'engineersamuel skills contract: FAIL: %s\n' "$1" >&2
  exit 1
}

repository='https://github.com/engineersamuel/skills.git'
ref="$(< vendor/engineersamuel-skills/REF)"
[[ "$ref" =~ ^[0-9a-f]{40}$ ]] || fail 'vendored REF is not a commit'

skill_count=0
skill_names=()
for skill in vendor/engineersamuel-skills/*; do
  [[ -d "$skill" ]] || continue
  [[ ! -L "$skill" && -f "$skill/SKILL.md" ]] \
    || fail "invalid vendored skill: $skill"
  skill_count=$((skill_count + 1))
  skill_names+=("$(basename "$skill")")
done
(( skill_count > 0 )) || fail 'vendored snapshot contains no skills'
if find vendor/engineersamuel-skills -type l -print -quit | grep -q .; then
  fail 'vendored snapshot contains a symlink'
fi

for profile in profiles/*/profile.toml; do
  grep -Fq "repository = \"$repository\"" "$profile" \
    || fail "personal skill source missing: $profile"
  grep -Fq "ref = \"$ref\"" "$profile" \
    || fail "personal skill ref differs: $profile"
  printf -v expected_select '"%s", ' "${skill_names[@]}"
  expected_select="select = [${expected_select%, }]"
  grep -Fq "$expected_select" "$profile" \
    || fail "complete personal skill selection differs: $profile"
done

native_count=0
for package in prototypes/trellage-*-profiles; do
  [[ -d "$package" ]] || continue
  installer="$package/install.sh"
  [[ -x "$installer" ]] || continue
  native_count=$((native_count + 1))
  grep -Fq 'install-engineersamuel-skills-runtime.sh' "$installer" \
    || fail "runtime snapshot publication missing: $installer"
  launcher_count=0
  for launcher in "$package"/bin/*; do
    [[ -f "$launcher" ]] || continue
    launcher_count=$((launcher_count + 1))
    grep -Fq "readonly engineersamuel_skills_ref='$ref'" "$launcher" \
      || fail "personal skill ref missing: $launcher"
    grep -Fq 'sync_engineersamuel_skills' "$launcher" \
      || fail "personal skill materialization missing: $launcher"
  done
  (( launcher_count > 0 )) || fail "native package has no launcher: $package"
done
(( native_count > 0 )) || fail 'no native profile packages found'

container_count=0
for dockerfile in Dockerfile*agent*; do
  [[ -f "$dockerfile" ]] || continue
  container_count=$((container_count + 1))
  grep -Fq 'COPY vendor/engineersamuel-skills /opt/engineersamuel-skills' "$dockerfile" \
    || fail "personal skill snapshot missing: $dockerfile"
  grep -Fq 'scripts/sync-engineersamuel-skills.sh' "$dockerfile" \
    || fail "personal skill helper missing: $dockerfile"
done
(( container_count > 0 )) || fail 'no comparison agent Dockerfiles found'
for entrypoint in scripts/agent-entrypoint.sh scripts/copilot-agent-entrypoint.sh; do
  grep -Fq '/usr/local/bin/sync-engineersamuel-skills.sh' "$entrypoint" \
    || fail "volume-backed skill materialization missing: $entrypoint"
done

grep -Fq 'update-engineersamuel-skills.mjs' scripts/rebuild-profile-images.sh \
  || fail 'profile rebuild does not refresh personal skills'
grep -Fq 'update-engineersamuel-skills.mjs' scripts/harness \
  || fail 'comparison build does not refresh personal skills'
grep -Fq 'Every new native launcher, Trellage Sandbox profile, and comparison-harness container MUST install every skill from `engineersamuel/skills`.' AGENTS.md \
  || fail 'future harness personal-skill rule is missing'

temporary="$(mktemp -d "${TMPDIR:-/tmp}/trellage-personal-skills.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT
mkdir "$temporary/target"
mkdir "$temporary/target/unmanaged"
printf 'keep\n' >"$temporary/target/unmanaged/SKILL.md"
scripts/sync-engineersamuel-skills.sh \
  --source vendor/engineersamuel-skills \
  --target "$temporary/target" \
  --ref "$ref"
[[ -f "$temporary/target/unmanaged/SKILL.md" ]] \
  || fail 'materializer removed an unmanaged skill'
for skill in vendor/engineersamuel-skills/*; do
  [[ -d "$skill" ]] || continue
  cmp "$skill/SKILL.md" "$temporary/target/$(basename "$skill")/SKILL.md" \
    || fail "materialized skill differs: $(basename "$skill")"
done

printf 'engineersamuel skills contract: PASS\n'
