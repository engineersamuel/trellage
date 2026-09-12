#!/usr/bin/env bash
# Called only inside Dockerfile.comparison-source's disposable synthetic fixture.
set -euo pipefail
umask 077

fail() {
  printf 'comparison source contract: %s\n' "$1" >&2
  exit 1
}
[[ -f /.dockerenv && "$(id -u)" == 0 && "$(uname -s)" == Linux && "$(uname -m)" == aarch64 ]] \
  || fail 'this fixture must run as root inside its disposable Linux ARM64 container'
source_root=/opt/trellage-source
config="$source_root/packages/trellage-runtime/bunfig.toml"
bun=(/usr/local/bin/bun --no-install --no-env-file "--config=$config")
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
[[ "$("${bun[@]}" --version)" == 1.3.3 ]] || fail 'incorrect Bun runtime'
[[ ! -e /context && ! -e /opt/node_modules ]] || fail 'ancestor source or dependencies are exposed'

platform=linux/arm64
archive_size="$(jq -er --arg platform "$platform" '.platforms[$platform].size' \
  "$source_root/prototypes/trellage/bun-runtime.json")"
printf 'invalid archive\n' >/tmp/comparison-corrupt-archive
for failure in size SHA-256; do
  if [[ "$failure" == SHA-256 ]]; then
    truncate -s "$archive_size" /tmp/comparison-corrupt-archive
  fi
  if bash "$source_root/scripts/provision-comparison-source.sh" "$source_root" \
    "/tmp/comparison-rejected-$failure" "$platform" https://registry.example.invalid/ \
    /tmp/comparison-corrupt-archive >/tmp/archive.stdout 2>/tmp/archive.stderr; then
    fail "provisioner accepted a Bun archive with the wrong $failure"
  fi
  grep -Fq "Bun archive $failure mismatch" /tmp/archive.stderr
  [[ ! -e "/tmp/comparison-rejected-$failure/bun" && ! -s /tmp/archive.stdout ]] \
    || fail 'unverified Bun was published or executed'
done
printf 'PINNED_BUN_ARCHIVE_SIZE_AND_SHA256_FAIL_CLOSED_OK\n'

groupadd --gid 10001 comparison-agent
useradd --uid 10001 --gid 10001 --create-home --home-dir /home/comparison-agent \
  --shell /bin/bash comparison-agent
mkdir -p /workspace /opt/floating-skills/skills /opt/agent-kit/.codex/agents \
  /opt/agent-kit/.codex/skills/generated /opt/awesome-plugins/synthetic/.github/plugin
printf '%s\n' astra-orchestrator i-have-adhd ui-guidelines >/opt/floating-skills/managed-skills.txt
printf 'Synthetic comparison instructions.\n' >/opt/floating-skills/always-on.md
for name in astra-orchestrator i-have-adhd ui-guidelines; do
  mkdir "/opt/floating-skills/skills/$name"
  printf -- '---\nname: %s\ndescription: Synthetic fixture\n---\nFixture: %s\n' "$name" "$name" \
    >"/opt/floating-skills/skills/$name/SKILL.md"
done
cat >/opt/floating-skills/skills/i-have-adhd/SKILL.md <<'EOF'
---
name: i-have-adhd
description: Synthetic manual fixture
disable-model-invocation: true
---
Activate only when explicitly requested.
EOF
cat >/opt/floating-skills-catalog.json <<'EOF'
{"schema":1,"sources":{"fixture":{"repository":"https://github.com/example/fixture.git","select":["astra-orchestrator","i-have-adhd","ui-guidelines"]}},"bundles":{"comparison-common":["fixture"]}}
EOF
printf 'name = "generated__agent"\ndescription = "Synthetic generated agent"\n' \
  >/opt/agent-kit/.codex/agents/generated__agent.toml
printf 'Use generated-agent.\n' >/opt/agent-kit/.codex/skills/generated/SKILL.md
printf '%s\n' .codex/agents/generated__agent.toml .codex/skills/generated/SKILL.md \
  >/opt/agent-kit-inventory.txt
printf 'model = "synthetic-model"\n' >/opt/codex-config.toml
printf '{"name":"synthetic"}\n' >/opt/awesome-plugins/synthetic/.github/plugin/plugin.json
chmod -R a=rX /opt/floating-skills /opt/floating-skills-catalog.json /opt/agent-kit \
  /opt/agent-kit-inventory.txt /opt/codex-config.toml /opt/awesome-plugins

cat >/workspace/runtime-child.ts <<'EOF'
process.stdout.write(JSON.stringify({
  bun: process.versions.bun,
  argv: process.argv.slice(2),
  cache: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
  envFile: process.env.COMPARISON_ENV_FILE ?? null,
}))
EOF
printf 'throw new Error("comparison preload must not execute")\n' >/workspace/unwanted-preload.ts
printf 'preload = ["/workspace/unwanted-preload.ts"]\n' >/workspace/bunfig.toml
cp /workspace/bunfig.toml /home/comparison-agent/.bunfig.toml
printf 'COMPARISON_ENV_FILE=unexpected\n' >/workspace/.env
chown -R 10001:10001 /workspace /home/comparison-agent

mkdir /tmp/comparison-forbidden-installers
for command in npm npx curl; do
  printf '#!/bin/sh\nprintf "unexpected runtime installer: %s\\n" >&2\nexit 97\n' "$command" \
    >"/tmp/comparison-forbidden-installers/$command"
  chmod 0755 "/tmp/comparison-forbidden-installers/$command"
done
chmod 0755 /tmp/comparison-forbidden-installers

as_agent() {
  runuser -u comparison-agent -- env HOME=/home/comparison-agent \
    PATH="/tmp/comparison-forbidden-installers:$PATH" \
    TRELLAGE_BUN_EXECUTABLE=/usr/local/bin/bun BUN_RUNTIME_TRANSPILER_CACHE_PATH=/workspace/unwanted-cache \
    CODEX_HOME=/workspace/codex-home COPILOT_HOME=/workspace/copilot-home "$@"
}

(
  cd "$source_root"
  "${bun[@]}" --eval '
    import assert from "node:assert/strict"
    import { spawnSync } from "node:child_process"
    import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs"
    import path from "node:path"
    import { bunArguments, bunExecutable, sourceWorkspaceRoot } from "@trellage/runtime"
    import { sourceFingerprint } from "@trellage/runtime/workspace"
    assert.equal(path.resolve(sourceWorkspaceRoot()), process.cwd())
    assert.match(sourceFingerprint(process.cwd()), /^[0-9a-f]{64}$/)
    const inspect = (directory) => {
      for (const name of readdirSync(directory)) {
        const file = path.join(directory, name)
        const status = lstatSync(file)
        if (status.isSymbolicLink()) {
          assert.ok(realpathSync(file).startsWith(`${process.cwd()}/`), file)
        } else if (status.isDirectory()) {
          if (!file.split("/").includes("node_modules")) assert.notEqual(name, "dist", file)
          inspect(file)
        }
      }
    }
    inspect(process.cwd())
    assert.ok(existsSync("node_modules/@trellage/runtime"))
    const child = spawnSync(bunExecutable(), bunArguments("/workspace/runtime-child.ts", ["--", "child argument", ""]), {
      cwd: "/workspace",
      encoding: "utf8",
    })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(child.stdout), {
      bun: "1.3.3", argv: ["--", "child argument", ""], cache: "0", envFile: null,
    })
    console.log("PUBLIC_EXPORTS_AND_CHILD_BUN_1_3_3_OK")
  '
)

# Node stands in only for the external agent. First-party helpers must use real Bun.
agent_probe='process.stdout.write(JSON.stringify({argv:process.argv.slice(1),bun:process.versions.bun??null,cache:process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,envFile:process.env.COMPARISON_ENV_FILE??null}))'
for family in codex copilot; do
  if [[ "$family" == codex ]]; then
    entrypoint="$source_root/scripts/agent-entrypoint.sh"
  else
    entrypoint="$source_root/scripts/copilot-agent-entrypoint.sh"
    as_agent mkdir -p /workspace/copilot-home/skills/astra-orchestrator
    as_agent bash -c 'printf "previous managed skill\n" >"$COPILOT_HOME/skills/astra-orchestrator/SKILL.md"; printf "astra-orchestrator\n" >"$COPILOT_HOME/skills/.trellage-managed-skills"'
  fi
  output="$(as_agent bash "$entrypoint" /usr/local/bin/node --eval "$agent_probe" -- 'argument with spaces' '' -- last)"
  jq -e '. == {argv:["argument with spaces","","--","last"],bun:null,cache:"0",envFile:null}' <<<"$output" >/dev/null \
    || fail "$family changed caller arguments or source runtime isolation"
done

cmp /opt/floating-skills/managed-skills.txt /workspace/codex-home/skills/.trellage-managed-skills
printf '%s\n' i-have-adhd ui-guidelines >/tmp/copilot-expected-skills
cmp /tmp/copilot-expected-skills /workspace/copilot-home/skills/.trellage-managed-skills
[[ ! -e /workspace/copilot-home/skills/astra-orchestrator ]] || fail 'Copilot installed excluded skill'
for home in codex-home copilot-home; do
  for name in i-have-adhd ui-guidelines; do
    cmp "/opt/floating-skills/skills/$name/SKILL.md" "/workspace/$home/skills/$name/SKILL.md"
  done
done
for role in explorer worker tester researcher reviewer; do
  [[ "$(stat -c %a "/workspace/codex-home/agents/$role.toml")" == 600 ]] || fail "unsafe $role mode"
  grep -Fq '# trellage-managed-codex-role-v1' "/workspace/codex-home/agents/$role.toml"
done
for private_file in \
  /workspace/codex-home/config.toml \
  /workspace/codex-home/agents/generated__agent.toml \
  /workspace/.harness/agent-package-inventory.txt \
  /workspace/.harness/copilot-plugin-inventory.txt \
  /workspace/copilot-home/instructions/rundown.instructions.md; do
  [[ "$(stat -c %a "$private_file")" == 600 ]] || fail "unsafe private file mode: $private_file"
done
[[ "$(stat -c %a /workspace)" == 700 ]] || fail 'unsafe workspace mode'
grep -Fq generated__agent /workspace/.codex/skills/generated/SKILL.md
grep -Fq 'synthetic/.github/plugin/plugin.json' /workspace/.harness/copilot-plugin-inventory.txt
[[ ! -e /workspace/unwanted-cache ]] || fail 'runtime transpiler cache was enabled'
printf 'NONROOT_ENTRYPOINTS_SKILLS_EXCLUSION_ARGV_AND_MODES_OK\n'

as_agent mkdir -p /workspace/codex-collision/agents
as_agent bash -c 'printf "unmanaged user role\n" >/workspace/codex-collision/agents/explorer.toml'
if as_agent env CODEX_HOME=/workspace/codex-collision bash "$source_root/scripts/agent-entrypoint.sh" \
  /bin/echo AGENT_MUST_NOT_RUN >/tmp/collision.stdout 2>/tmp/collision.stderr; then
  fail 'Codex overwrote an unmanaged role'
fi
grep -Fq 'unmanaged role name collision' /tmp/collision.stderr
[[ "$(cat /workspace/codex-collision/agents/explorer.toml)" == 'unmanaged user role' ]] \
  || fail 'Codex changed the colliding role'
for role in worker tester researcher reviewer; do
  [[ ! -e "/workspace/codex-collision/agents/$role.toml" ]] || fail 'Codex partly published managed roles'
done
[[ ! -s /tmp/collision.stdout ]] || fail 'agent ran after collision'

cat >/tmp/failed-bun-version <<'EOF'
#!/bin/sh
printf '1.3.3\n'
exit 7
EOF
chmod 0755 /tmp/failed-bun-version
for entrypoint in "$source_root/scripts/agent-entrypoint.sh" "$source_root/scripts/copilot-agent-entrypoint.sh"; do
  for executable in /missing-bun /tmp/failed-bun-version; do
    if as_agent env TRELLAGE_BUN_EXECUTABLE="$executable" CODEX_HOME=/workspace/rejected-codex \
      COPILOT_HOME=/workspace/rejected-copilot bash "$entrypoint" /bin/echo AGENT_MUST_NOT_RUN \
      >/tmp/rejected.stdout 2>/tmp/rejected.stderr; then
      fail 'entrypoint accepted missing Bun or a failed version command'
    fi
    [[ ! -s /tmp/rejected.stdout && ! -e /workspace/rejected-codex && ! -e /workspace/rejected-copilot ]] \
      || fail 'entrypoint mutated agent state after Bun failure'
    [[ -s /tmp/rejected.stderr ]] || fail 'entrypoint failed without a runtime diagnostic'
  done
done

mv "$config" "$config.contract-original"
ln -s "$config.contract-original" "$config"
for entrypoint in "$source_root/scripts/agent-entrypoint.sh" "$source_root/scripts/copilot-agent-entrypoint.sh"; do
  if as_agent bash "$entrypoint" /bin/echo AGENT_MUST_NOT_RUN >/tmp/unsafe.stdout 2>/tmp/unsafe.stderr; then
    fail 'entrypoint accepted a symlinked Bun configuration'
  fi
  grep -Fq 'missing or unsafe Bun config' /tmp/unsafe.stderr
  [[ ! -s /tmp/unsafe.stdout ]] || fail 'agent ran with unsafe runtime configuration'
done
rm "$config"
mv "$config.contract-original" "$config"

runtime_link="$source_root/node_modules/@trellage/runtime"
mv "$runtime_link" "$runtime_link.contract-original"
for entrypoint in "$source_root/scripts/agent-entrypoint.sh" "$source_root/scripts/copilot-agent-entrypoint.sh"; do
  if as_agent bash "$entrypoint" /bin/echo AGENT_MUST_NOT_RUN >/tmp/dependency.stdout 2>/tmp/dependency.stderr; then
    fail 'entrypoint accepted an incomplete source dependency closure'
  fi
  grep -Fq "Cannot find module '@trellage/runtime'" /tmp/dependency.stderr
  [[ ! -s /tmp/dependency.stdout ]] || fail 'agent ran without source dependencies'
done
mv "$runtime_link.contract-original" "$runtime_link"
printf 'COLLISION_AND_UNSAFE_RUNTIME_FAIL_CLOSED_OK\n'
printf 'comparison source contract: PASS\n'
