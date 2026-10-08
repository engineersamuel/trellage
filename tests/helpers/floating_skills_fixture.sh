#!/usr/bin/env bash

seal_floating_skills_cache() {
  local cache="$1" catalog="$2"
  shift 2
  local repo_root="$(CDPATH= cd -P -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
  bun --no-env-file -e '
    const [managerPath, sourcePath, cache, catalogPath, ...bundles] = process.argv.slice(1);
    const { readCatalog, resolvePlan } = await import(managerPath);
    const { digestDirectory } = await import(sourcePath);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${cache}/policy.json`, JSON.stringify(resolvePlan(await readCatalog(catalogPath), bundles)));
    await writeFile(`${cache}/.trellage-receipt`, await digestDirectory(cache));
  ' "$repo_root/scripts/floating-skills.ts" "$repo_root/packages/trellage-runtime/src/native-run/source.ts" "$cache" "$catalog" "$@"
}

seed_floating_skills_cache() {
  local home="$1"
  local cache="$home/.local/share/trellage/common/skills"
  local guide_cache="$home/.local/share/trellage/common/guide-prompt-master-skills"

  mkdir -p "$cache/skills/fixture-personal" "$cache/skills/show-me"
  printf '%s\n' '# Fixture personal skill' >"$cache/skills/fixture-personal/SKILL.md"
  printf '%s\n' '# Fixture show-me skill' >"$cache/skills/show-me/SKILL.md"
  printf '%s\n' fixture-personal show-me >"$cache/managed-skills.txt"
  : >"$cache/always-on.md"

  mkdir -p "$guide_cache/skills/prompt-master"
  printf '%s\n' '---' 'name: prompt-master' '---' '' '# Fixture Prompt Master skill' \
    >"$guide_cache/skills/prompt-master/SKILL.md"
  printf '%s\n' prompt-master >"$guide_cache/managed-skills.txt"
  : >"$guide_cache/always-on.md"
  local repo_root="$(CDPATH= cd -P -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
  seal_floating_skills_cache "$cache" "$repo_root/config.toml" native-common
  seal_floating_skills_cache "$guide_cache" "$repo_root/config.toml" guide-prompt-master
}

install_fixture_node() {
  local destination="$1"
  local node_path

  node_path="$(command -v node)" || {
    printf 'floating skill fixture: node is required\n' >&2
    return 1
  }
  ln -s "$node_path" "$destination/node"
  install_fixture_bun "$destination"
}

install_fixture_bun() {
  local destination="$1"
  local bun_path

  bun_path="$(command -v bun)" || {
    printf 'floating skill fixture: Bun is required\n' >&2
    return 1
  }
  ln -s "$bun_path" "$destination/bun"
}
