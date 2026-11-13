import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { nativePresetProfiles } from "@trellage/runtime/native-run"

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export type AdmissionRules = {
  payloads: Record<string, unknown>
  executable: string
  profiles: { claude: readonly string[]; copilot: readonly string[] }
}
export type AdmissionResult = { status: number; stdout: string; stderr: string }

/** The mock's whole decision: metadata for declared admission requests, exit 97 for anything else (a model command).
 *  Self-contained (no imports or outer names): the generated program embeds its source. */
export function admit(
  rules: AdmissionRules,
  role: string,
  args: string[],
  env: Record<string, string | undefined>,
): AdmissionResult {
  const fail = { status: 97, stdout: "", stderr: "Unexpected lifecycle metadata request\n" }
  const ok = (value: unknown) => ({
    status: 0,
    stdout: (typeof value === "string" ? value : JSON.stringify(value)) + "\n",
    stderr: "",
  })
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b)
  if (role === "claude" || role === "copilot") {
    const guarded = env["TRELLAGE_TRX_" + role.toUpperCase() + "_ADAPTER"] === "1"
    return guarded && args.length === 2 && args[0] === "_trx-admit" && rules.profiles[role].includes(args[1]!)
      ? ok(rules.payloads[role])
      : fail
  }
  if (role === "agency") return same(args, ["inventory", "trellage-azure", "--json"]) ? ok(rules.payloads.agency) : fail
  if (role === "jcode")
    return env.TRELLAGE_TRX_JCODE_ADAPTER === "1" && same(args, ["_trx-executable"]) ? ok(rules.executable) : fail
  return fail
}

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
  const rules: AdmissionRules = {
    payloads,
    executable,
    profiles: { claude: ["default", "office", "office-charts"], copilot: nativePresetProfiles("copilot") },
  }
  // The program embeds admit() itself, so the in-process tests check the code the binaries run.
  await writeFile(
    program,
    `import { appendFileSync } from "node:fs"
const role = process.argv[2]
const args = process.argv.slice(3)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ role, args }) + "\\n")
const admit = ${admit.toString()}
const r = admit(${JSON.stringify(rules)}, role, args, process.env)
process.stdout.write(r.stdout)
process.stderr.write(r.stderr)
process.exit(r.status)
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
    rules,
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
