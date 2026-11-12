import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { nativePresetProfiles } from "@trellage/runtime/native-run"

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/**
 * Metadata-only lifecycle executables; callers must still inject the final harness spawner.
 * Each mock is plain /bin/sh with its replies baked in: no interpreter start per call, so a loaded host
 * (the pre-push hook runs these beside the whole suite) cannot push a call past its timeout.
 */
export const createAdmissionMocks = async (root: string, executable: string) => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  assert(path.isAbsolute(root) && path.isAbsolute(executable))
  const directory = path.join(root, "admission-mocks")
  const plugin = path.join(directory, "plugins", "fixture-plugin")
  await mkdir(plugin, { recursive: true })
  await writeFile(path.join(plugin, "plugin.json"), JSON.stringify({ name: "fixture-plugin", version: "1.0.0" }))
  const calls = path.join(directory, "calls.jsonl")
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
  // What each role accepts: the exact argument lists, whether the adapter guard must be set, and the reply.
  const roles: Record<string, { allowed: string[][]; guarded: boolean; reply: string }> = {
    claude: {
      allowed: ["default", "office", "office-charts"].map((profile) => ["_trx-admit", profile]),
      guarded: true,
      reply: JSON.stringify(payloads.claude),
    },
    copilot: {
      allowed: nativePresetProfiles("copilot").map((profile) => ["_trx-admit", profile]),
      guarded: true,
      reply: JSON.stringify(payloads.copilot),
    },
    agency: {
      allowed: [["inventory", "trellage-azure", "--json"]],
      guarded: false,
      reply: JSON.stringify(payloads.agency),
    },
    jcode: { allowed: [["_trx-executable"]], guarded: true, reply: executable },
  }
  const environment: NodeJS.ProcessEnv = {}
  const binaries: Record<string, string> = {}
  for (const [role, spec] of Object.entries(roles)) {
    const binary = path.join(directory, role)
    const guard = `TRELLAGE_TRX_${role.toUpperCase()}_ADAPTER`
    // Arguments are joined with a unit separator, so "a b" and ["a", "b"] differ; fixtures never contain \037.
    const cases = spec.allowed.map((args) => `  ${shellWord(args.join("\x1f"))}) ok=1 ;;`).join("\n")
    await writeFile(
      binary,
      `#!/bin/sh
# Log the call as JSON: {"role": ..., "args": [...]}; arguments are plain fixture tokens, escaped for " and \\.
esc() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
line='{"role":"${role}","args":['
sep=''
for a in "$@"; do line="$line$sep\\"$(esc "$a")\\""; sep=','; done
printf '%s]}\\n' "$line" >> ${shellWord(calls)}
fail() { printf 'Unexpected lifecycle metadata request\\n' >&2; exit 97; }
${spec.guarded ? `[ "\${${guard}:-}" = 1 ] || fail` : ""}
joined=$(printf '%s\\037' "$@"); joined=\${joined%?}
ok=0
case "$joined" in
${cases}
esac
[ "$ok" = 1 ] || fail
printf '%s\\n' ${shellWord(spec.reply)}
`,
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
