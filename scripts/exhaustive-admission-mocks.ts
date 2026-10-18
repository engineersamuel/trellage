import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { nativePresetProfiles } from "@trellage/runtime/native-run"

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Metadata-only lifecycle executables; callers must still inject the final harness spawner. */
export const createAdmissionMocks = async (root: string, executable: string) => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  assert(path.isAbsolute(root) && path.isAbsolute(executable))
  const directory = path.join(root, "admission-mocks")
  const plugin = path.join(directory, "plugins", "fixture-plugin")
  await mkdir(plugin, { recursive: true })
  await writeFile(path.join(plugin, "plugin.json"), JSON.stringify({ name: "fixture-plugin", version: "1.0.0" }))
  const calls = path.join(directory, "calls.jsonl")
  const program = path.join(directory, "metadata.ts")
  const registrations = [{ name: "fixture-plugin", marketplace: "fixture", enabled: true, cache_path: plugin }]
  const settings = {
    enabledPlugins: { "fixture-plugin@fixture": true },
    hooks: { sessionStart: [] },
    subagents: { reviewer: { description: "fixture reviewer" } },
  }
  const payloads = {
    claude: { pluginDir: plugin },
    copilot: { installedPlugins: path.dirname(plugin), pluginRegistrations: registrations, settings },
    agency: { readiness: "healthy", authenticationMethod: "AzureCliCredential" },
  }
  await writeFile(
    program,
    `import { appendFileSync } from "node:fs"
const role = process.argv[2]
const args = process.argv.slice(3)
const fail = () => { process.stderr.write("Unexpected lifecycle metadata request\\n"); process.exit(97) }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ role, args }) + "\\n")
const payloads = ${JSON.stringify(payloads)}
if (role === "claude" || role === "copilot") {
  const allowed = role === "claude" ? ["default", "office", "office-charts"] : ${JSON.stringify(nativePresetProfiles("copilot"))}
  if (process.env["TRELLAGE_TRX_" + role.toUpperCase() + "_ADAPTER"] !== "1" || args.length !== 2 || args[0] !== "_trx-admit" || !allowed.includes(args[1])) fail()
  console.log(JSON.stringify(payloads[role]))
} else if (role === "agency") {
  if (JSON.stringify(args) !== JSON.stringify(["inventory", "trellage-azure", "--json"])) fail()
  console.log(JSON.stringify(payloads.agency))
} else if (role === "jcode") {
  if (process.env.TRELLAGE_TRX_JCODE_ADAPTER !== "1" || JSON.stringify(args) !== JSON.stringify(["_trx-executable"])) fail()
  console.log(${JSON.stringify(executable)})
} else fail()
`,
  )
  const environment: NodeJS.ProcessEnv = {}
  const binaries: Record<string, string> = {}
  for (const role of ["claude", "copilot", "agency", "jcode"]) {
    const binary = path.join(directory, role)
    await writeFile(
      binary,
      `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(program)} ${shellWord(role)} "$@"\n`,
      { mode: 0o700 },
    )
    binaries[role] = binary
    environment[`TRELLAGE_${role.toUpperCase()}_LIFECYCLE_BIN`] = binary
  }
  return {
    environment,
    binaries,
    plugin,
    payloads,
    executable,
    calls: async (): Promise<{ role: string; args: string[] }[]> => {
      const text = await readFile(calls, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
  }
}
