import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, lstatSync, realpathSync, readFileSync } from "node:fs"

export interface NativeHarnessRegistration {
  readonly id: string
  readonly packageDirectory: string
  readonly presets: Readonly<Record<string, string>>
}

const register = (id: string, packageName: string, presets: Record<string, string>): NativeHarnessRegistration =>
  ({ id, packageDirectory: `trellage-${packageName}-profiles`, presets })
const same = (...names: string[]) => Object.fromEntries(names.map((name) => [name, name]))

// Presets identify backend policies and persistent homes. Skill intent lives in TOML.
export const nativeHarnessRegistry: ReadonlyArray<NativeHarnessRegistration> = [
  register("agency", "agency", { azure: "trellage-azure" }),
  register("codex", "codex", same("pstack", "superpowers", "youtube")),
  register("claude", "claude", same("default", "office", "office-charts")),
  register("copilot", "copilot", same("awesome", "compound-engineering", "hve", "plannotator", "superpowers", "tufte-vdqi")),
  register("firstmate", "firstmate", same("default", "pstack-workers")),
  register("jcode", "jcode", same("default")),
  register("omp", "omp", { default: "copilot", local: "local" }),
  register("pi", "pi", same("default")),
  register("prime", "prime", same("default")),
]

export const nativeHarness = (id: string) => nativeHarnessRegistry.find((entry) => entry.id === id)

const translateProfile = (
  entry: NativeHarnessRegistration,
  operation: string,
  harness: string,
  args: string[],
): string[] => {
  if (operation === "instances" || operation === "skill" || !args[0] || args[0].startsWith("-")) return args
  const preset = entry.presets[args[0]]
  if (!preset && operation === "run") throw new Error(`unknown preset for ${harness}: ${args[0]}`)
  if (preset) args[0] = preset
  return args
}

const upgradeArguments = (entry: NativeHarnessRegistration, harness: string, args: string[]): string[] | undefined => {
  const skillsOnly = args.indexOf("--skills-only")
  if (skillsOnly !== -1) {
    args.splice(skillsOnly, 1)
    return ["skills-update", ...translateProfile(entry, "skills-update", harness, args)]
  }

  const harnessOnly = args.indexOf("--harness-only")
  if (harnessOnly !== -1) args.splice(harnessOnly, 1)
  const updatesHarness = harness === "claude" || (harnessOnly !== -1 && (harness === "codex" || harness === "copilot"))
  if (updatesHarness) {
    if (args.includes("--check"))
      throw new Error(`trx upgrade ${harness} --check is not supported by this backend; use trx harness-version ${harness} to inspect the installed version`)
    const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--dry-run")
    if (unknown) throw new Error(`unsupported upgrade option for ${harness}: ${unknown}`)
    return ["harness-update", ...args.filter((arg) => arg === "--dry-run")]
  }
  if (harness === "agency")
    throw new Error("Agency runtime upgrades are managed externally; use trx repair agency azure for profile repair")

  const check = args.indexOf("--check")
  if (check === -1) return undefined
  args.splice(check, 1)
  const profile = args.findIndex((arg) => !arg.startsWith("-"))
  if (profile !== -1) args[profile] = entry.presets[args[profile]!] ?? args[profile]!
  return ["update", "--check", ...args]
}

const runArguments = (harness: string, args: string[]): string[] => {
  if (args.length === 0) throw new Error(`trx run ${harness} requires a preset`)
  const boundary = args.indexOf("--")
  const nativeAuth = harness === "codex" && args[1] === "--native-auth"
  const interactive = harness === "copilot" && args[1] === "--interactive"
  if (boundary !== -1) args.splice(boundary, 1)
  if (nativeAuth) {
    args.splice(1, 1)
    return ["--native-auth", ...args]
  }
  if (interactive) {
    args.splice(1, 1)
    return ["interactive", ...args]
  }
  return args
}

export const backendArguments = (operation: string, harness: string, args: ReadonlyArray<string>): string[] => {
  const entry = nativeHarness(harness)
  if (!entry) throw new Error(`unknown native harness: ${harness}`)
  if (operation === "harness-version" && harness !== "firstmate") return ["harness-version"]

  const translated = [...args]
  if (operation === "upgrade") {
    const upgrade = upgradeArguments(entry, harness, translated)
    if (upgrade) return upgrade
  }
  translateProfile(entry, operation, harness, translated)
  if (operation === "run") return runArguments(harness, translated)
  return [operation === "upgrade" ? "update" : operation, ...translated]
}

export const nativeBackendPath = (entry: NativeHarnessRegistration, home = process.env.HOME ?? "", workspace = fileURLToPath(new URL("../../../..", import.meta.url))): string => {
  const installed = path.join(existsSync(home) ? realpathSync(home) : home, ".local/share/trellage", entry.id, "bin", entry.id)
  const source = path.join(workspace, "prototypes", entry.packageDirectory, "bin", entry.id)
  if (process.env.TRELLAGE_TRX_NATIVE_SOURCE || !existsSync(installed)) return source
  if (!lstatSync(installed).isFile() || realpathSync(installed) !== installed)
    throw new Error(`unsafe native backend: ${installed}`)
  const markerName = `${entry.id}-profiles`
  const marker = path.join(path.dirname(path.dirname(installed)), `.managed-by-trellage-${markerName}`)
  const versions = entry.id === "codex" ? ["v1", "v2"] : [entry.id === "omp" ? "v2" : "v1"]
  if (!existsSync(marker) || !lstatSync(marker).isFile() ||
      !versions.some((version) => readFileSync(marker, "utf8").trim() === `trellage-${markerName}-${version}`))
    throw new Error(`missing or invalid native backend ownership: ${installed}`)
  return installed
}
