import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { adapters, type LaunchCommand, type RunDependencies } from "@trellage/runtime/native-run"

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export const createCleanRunWorld = async () => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-clean-run-matrix-"))
  const home = path.join(root, "home")
  const work = path.join(root, "work")
  const bin = path.join(root, "bin")
  const callsFile = path.join(root, "discovery.jsonl")
  const mock = path.join(root, "discovery.ts")
  const executable = path.join(bin, "discovery")
  for (const directory of [home, work, bin]) await mkdir(directory, { recursive: true })
  await writeFile(mock, `import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"
const args = process.argv.slice(2)
const record = (value: unknown) => appendFileSync(process.env.FIXTURE_DISCOVERY_CALLS!, JSON.stringify(value) + "\\n")
const fail = () => { process.stderr.write("Unexpected discovery command\\n"); process.exit(97) }
record({ args })
if (args.at(-1) === "app-server") {
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const message = JSON.parse(line)
    record({ method: message.method })
    if (message.method === "initialize" && message.id === 1)
      process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n")
    else if (message.method === "initialized" && message.id === undefined) continue
    else if (message.method === "skills/list" && message.id === 2)
      process.stdout.write(JSON.stringify({ id: 2, result: { data: [{ skills: [{ path: "/fixture/unselected/SKILL.md", enabled: true }] }] } }) + "\\n")
    else fail()
  }
} else if (JSON.stringify(args) === JSON.stringify(["--no-auto-update", "skill", "list", "--json"]))
  console.log(JSON.stringify([{ name: "unselected-fixture" }]))
else if (JSON.stringify(args) === JSON.stringify(["--no-auto-update", "mcp", "list", "--json"]))
  console.log(JSON.stringify({ mcpServers: { "fixture-server": {} } }))
else fail()
`)
  await writeFile(executable, `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(mock)} "$@"\n`, { mode: 0o700 })
  const forbiddenConfig = path.join(home, "config.toml")
  await writeFile(forbiddenConfig, "This is deliberately invalid TOML: clean must never load it.\n", { mode: 0o600 })
  const environment: NodeJS.ProcessEnv = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, TRELLAGE_CONFIG: forbiddenConfig,
    TRELLAGE_TEST_OFFLINE: "1", FIXTURE_DISCOVERY_CALLS: callsFile,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
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
    environment, paths, cwd: work, configHome: home,
    transport: { resolveRef: () => forbidden("source resolution"), fetchCommit: () => forbidden("source fetch") },
    refreshHarness: () => forbidden("harness refresh"),
    syncRepository: () => forbidden("repository synchronization"),
    prerequisiteIo: { confirm: () => forbidden("prerequisite confirmation"), install: () => forbidden("prerequisite installation"), write: line => lines.push(line) },
    write: line => lines.push(line),
    spawner: async (launch, _environment, cwd, onSpawn) => {
      launches.push({ launch, cwd })
      onSpawn()
      return 23
    },
  }
  return { root, home, work, paths, dependencies, launches, unexpected, lines,
    discoveries: async (): Promise<unknown[]> => {
      try { return (await readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
    },
    close: async (): Promise<void> => { await rm(root, { recursive: true, force: true }) },
  }
}
