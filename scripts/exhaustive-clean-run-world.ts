import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { adapters, type LaunchCommand, type RunDependencies } from "@trellage/runtime/native-run"

import { prelude, shellWord } from "./sh-mock.ts"

export const createCleanRunWorld = async () => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-clean-run-matrix-"))
  const home = path.join(root, "home")
  const work = path.join(root, "work")
  const bin = path.join(root, "bin")
  const callsFile = path.join(root, "discovery.jsonl")
  const executable = path.join(bin, "discovery")
  for (const directory of [home, work, bin]) await mkdir(directory, { recursive: true })
  // Discovery mock in /bin/sh: the client sends compact JSON lines (JSON.stringify), so fields match as text.
  await writeFile(
    executable,
    `${prelude("Unexpected discovery command")}record() { printf '%s\\n' "$1" >> "$FIXTURE_DISCOVERY_CALLS"; }
record "{\\"args\\":$(args_json "$@")}"
last=; for last; do :; done
if [ "$last" = app-server ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    method=$(printf '%s' "$line" | sed -n 's/.*"method":"\\([^"]*\\)".*/\\1/p')
    if [ -n "$method" ]; then record "{\\"method\\":\\"$method\\"}"; else record '{}'; fi
    case "$line" in *'"id":'*) id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p') ;; *) id= ;; esac
    if [ "$method" = initialize ] && [ "$id" = 1 ]; then printf '%s\\n' '{"id":1,"result":{}}'
    elif [ "$method" = initialized ] && [ -z "$id" ]; then continue
    elif [ "$method" = skills/list ] && [ "$id" = 2 ]; then
      printf '%s\\n' '{"id":2,"result":{"data":[{"skills":[{"path":"/fixture/unselected/SKILL.md","enabled":true}]}]}}'
    else fail
    fi
  done
  exit 0
fi
join_args "$@"
case "$joined" in
  ${shellWord(["--no-auto-update", "skill", "list", "--json"].join("\x1f"))}) echo '[{"name":"unselected-fixture"}]' ;;
  ${shellWord(["--no-auto-update", "mcp", "list", "--json"].join("\x1f"))}) echo '{"mcpServers":{"fixture-server":{}}}' ;;
  *) fail ;;
esac
`,
    { mode: 0o700 },
  )
  const forbiddenConfig = path.join(home, "config.toml")
  await writeFile(forbiddenConfig, "This is deliberately invalid TOML: clean must never load it.\n", { mode: 0o600 })
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    TRELLAGE_CONFIG: forbiddenConfig,
    TRELLAGE_TEST_OFFLINE: "1",
    FIXTURE_DISCOVERY_CALLS: callsFile,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  }
  for (const harness of Object.keys(adapters)) environment[`TRELLAGE_${harness.toUpperCase()}_BIN`] = executable
  const launches: { launch: LaunchCommand; cwd: string }[] = []
  const unexpected: string[] = []
  const lines: string[] = []
  const forbidden = async (boundary: string): Promise<never> => {
    unexpected.push(boundary)
    throw new Error(`Clean run reached forbidden boundary: ${boundary}`)
  }
  const paths = { cache: path.join(root, "cache"), data: path.join(root, "data"), state: path.join(root, "state") }
  const dependencies: RunDependencies = {
    environment,
    paths,
    cwd: work,
    configHome: home,
    transport: { resolveRef: () => forbidden("source resolution"), fetchCommit: () => forbidden("source fetch") },
    refreshHarness: () => forbidden("harness refresh"),
    syncRepository: () => forbidden("repository synchronization"),
    prerequisiteIo: {
      confirm: () => forbidden("prerequisite confirmation"),
      install: () => forbidden("prerequisite installation"),
      write: (line) => lines.push(line),
    },
    write: (line) => lines.push(line),
    spawner: async (launch, _environment, cwd, onSpawn) => {
      launches.push({ launch, cwd })
      onSpawn()
      return 23
    },
  }
  return {
    root,
    home,
    work,
    paths,
    dependencies,
    launches,
    unexpected,
    lines,
    discoveries: async (): Promise<unknown[]> => {
      try {
        return (await readFile(callsFile, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
      }
    },
    close: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true })
    },
  }
}
