import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, lstatSync, realpathSync, readFileSync } from "node:fs"

export interface NativeHarnessRegistration {
  readonly id: string
  readonly legacyLauncher: string
  readonly packageDirectory: string
  readonly presets: Readonly<Record<string, string>>
}

const register = (id: string, legacyLauncher: string, packageName: string, presets: Record<string, string>): NativeHarnessRegistration =>
  ({ id, legacyLauncher, packageDirectory: `trellage-${packageName}-profiles`, presets })
const same = (...names: string[]) => Object.fromEntries(names.map((name) => [name, name]))

// Presets identify backend policies and persistent homes. Skill intent lives in TOML.
export const nativeHarnessRegistry: ReadonlyArray<NativeHarnessRegistration> = [
  register("agency", "agx", "agency", { azure: "trellage-azure" }),
  register("codex", "cdx", "codex", same("pstack", "superpowers", "youtube")),
  register("claude", "cldx", "claude", same("default", "office", "office-charts")),
  register("copilot", "cpx", "copilot", same("awesome", "compound-engineering", "hve", "plannotator", "superpowers", "tufte-vdqi")),
  register("firstmate", "fmx", "firstmate", same("default", "pstack-workers")),
  register("jcode", "jcx", "jcode", same("default")),
  register("omp", "omp", "omp", { default: "copilot", local: "local" }),
  register("pi", "picx", "picx", same("default")),
  register("prime", "prx", "prime", same("default")),
]

export const nativeHarness = (id: string) => nativeHarnessRegistry.find((entry) => entry.id === id)

export const backendArguments = (operation: string, harness: string, args: ReadonlyArray<string>): string[] => {
  const entry = nativeHarness(harness)
  if (!entry) throw new Error(`unknown native harness: ${harness}`)
  const translated = [...args]
  if (operation === "harness-version" && harness !== "firstmate") return ["harness-version"]
  if (operation === "upgrade") {
    if (translated.includes("--skills-only")) {
      operation = "skills-update"
      translated.splice(translated.indexOf("--skills-only"), 1)
    } else {
      const index = translated.indexOf("--harness-only")
      if (index !== -1) translated.splice(index, 1)
      if (harness === "claude" || (index !== -1 && ["codex", "copilot"].includes(harness))) {
        if (translated.includes("--check")) throw new Error(`trx upgrade ${harness} --check is not supported by this backend; use trx harness-version ${harness} to inspect the installed version`)
        const unknown = translated.find((arg) => arg.startsWith("-") && arg !== "--dry-run")
        if (unknown) throw new Error(`unsupported upgrade option for ${harness}: ${unknown}`)
        return ["harness-update", ...translated.filter((arg) => arg === "--dry-run")]
      }
      if (harness === "agency") throw new Error("Agency runtime upgrades are managed externally; use trx repair agency azure for profile repair")
    }
  }
  if (operation === "upgrade" && translated.includes("--check")) {
    translated.splice(translated.indexOf("--check"), 1)
    const profileIndex = translated.findIndex((arg) => !arg.startsWith("-"))
    if (profileIndex !== -1) translated[profileIndex] = entry.presets[translated[profileIndex]!] ?? translated[profileIndex]!
    return ["update", "--check", ...translated]
  }
  if (operation !== "instances" && operation !== "skill" && translated[0] && !translated[0].startsWith("-")) {
    const preset = entry.presets[translated[0]]
    if (!preset && operation === "run") throw new Error(`unknown preset for ${harness}: ${translated[0]}`)
    if (preset) translated[0] = preset
  }
  if (operation === "run") {
    if (translated.length === 0) throw new Error(`trx run ${harness} requires a preset`)
    const boundary = translated.indexOf("--")
    const interactive = harness === "copilot" && translated[1] === "--interactive" ? 0 : -1
    const nativeAuth = harness === "codex" && translated[1] === "--native-auth"
    if (boundary !== -1) translated.splice(boundary, 1)
    if (nativeAuth) {
      translated.splice(1, 1)
      return ["--native-auth", ...translated]
    }
    if (interactive !== -1) {
      translated.splice(interactive + 1, 1)
      return ["interactive", ...translated]
    }
    return translated
  }
  return [operation === "upgrade" ? "update" : operation, ...translated]
}

export const nativeBackendPath = (entry: NativeHarnessRegistration, home = process.env.HOME ?? "", workspace = fileURLToPath(new URL("../../../..", import.meta.url))): string => {
  const installed = path.join(existsSync(home) ? realpathSync(home) : home, ".local/share/trellage", entry.legacyLauncher, "bin", entry.legacyLauncher)
  const source = path.join(workspace, "prototypes", entry.packageDirectory, "bin", entry.legacyLauncher)
  if (process.env.TRELLAGE_TRX_NATIVE_SOURCE || !existsSync(installed)) return source
  if (!lstatSync(installed).isFile() || realpathSync(installed) !== installed)
    throw new Error(`unsafe native backend: ${installed}`)
  const markerNames: Record<string, string> = { cpx: "profiles", picx: "picx-profiles", omp: "omp-profiles" }
  const markerName = markerNames[entry.legacyLauncher] ?? `${entry.id}-profiles`
  const marker = path.join(path.dirname(path.dirname(installed)), `.managed-by-trellage-${markerName}`)
  const versions = entry.id === "codex" ? ["v1", "v2"] : [entry.id === "omp" ? "v2" : "v1"]
  if (!existsSync(marker) || !lstatSync(marker).isFile() ||
      !versions.some((version) => readFileSync(marker, "utf8").trim() === `trellage-${markerName}-${version}`))
    throw new Error(`missing or invalid native backend ownership: ${installed}`)
  return installed
}
