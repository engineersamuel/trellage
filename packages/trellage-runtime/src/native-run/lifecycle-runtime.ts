import { existsSync, lstatSync, realpathSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativePresetProfiles } from "./presets.ts"

export interface LifecycleRuntime {
  readonly harness: string
  readonly runtimeName: string
  readonly packageDirectory: string
  readonly profileName: (profile: string) => string
}

const same = (profile: string): string => profile

export const lifecycleRuntimes: ReadonlyArray<LifecycleRuntime> = [
  { harness: "agency", runtimeName: "agx", packageDirectory: "trellage-agency-profiles", profileName: (profile) => profile === "azure" ? "trellage-azure" : profile },
  { harness: "claude", runtimeName: "cldx", packageDirectory: "trellage-claude-profiles", profileName: same },
  { harness: "codex", runtimeName: "cdx", packageDirectory: "trellage-codex-profiles", profileName: same },
  { harness: "copilot", runtimeName: "cpx", packageDirectory: "trellage-copilot-profiles", profileName: same },
  { harness: "firstmate", runtimeName: "fmx", packageDirectory: "trellage-firstmate-profiles", profileName: same },
  { harness: "jcode", runtimeName: "jcx", packageDirectory: "trellage-jcode-profiles", profileName: same },
  { harness: "omp", runtimeName: "omp", packageDirectory: "trellage-omp-profiles", profileName: (profile) => profile === "default" ? "copilot" : profile },
  { harness: "pi", runtimeName: "picx", packageDirectory: "trellage-picx-profiles", profileName: same },
  { harness: "prime", runtimeName: "prx", packageDirectory: "trellage-prime-profiles", profileName: same },
]

export const lifecycleRuntime = (harness: string): LifecycleRuntime | undefined =>
  lifecycleRuntimes.find((runtime) => runtime.harness === harness)

export const lifecycleRuntimeCommand = (
  runtime: LifecycleRuntime,
  home = process.env.HOME ?? "",
  workspace = fileURLToPath(new URL("../../../..", import.meta.url)),
): string => {
  const installed = path.join(existsSync(home) ? realpathSync(home) : home, ".local/share/trellage", runtime.runtimeName, "bin", runtime.runtimeName)
  const source = path.join(workspace, "prototypes", runtime.packageDirectory, "bin", runtime.runtimeName)
  if (process.env.TRELLAGE_TRX_NATIVE_SOURCE || !existsSync(installed)) return source
  if (!lstatSync(installed).isFile() || realpathSync(installed) !== installed)
    throw new Error(`unsafe managed profile runtime: ${installed}`)
  const markerNames: Record<string, string> = { cpx: "profiles", picx: "picx-profiles", omp: "omp-profiles" }
  const markerName = markerNames[runtime.runtimeName] ?? `${runtime.harness}-profiles`
  const marker = path.join(path.dirname(path.dirname(installed)), `.managed-by-trellage-${markerName}`)
  const versions = runtime.harness === "codex" ? ["v1", "v2"] : [runtime.harness === "omp" ? "v2" : "v1"]
  if (!existsSync(marker) || !lstatSync(marker).isFile() ||
      !versions.some((version) => readFileSync(marker, "utf8").trim() === `trellage-${markerName}-${version}`))
    throw new Error(`missing or invalid managed profile runtime ownership: ${installed}`)
  return installed
}

export const profileOperationArguments = (operation: string, harness: string, args: ReadonlyArray<string>): string[] => {
  if (operation === "run") throw new Error("profile lifecycle cannot launch agents; use trx run")
  const runtime = lifecycleRuntime(harness)
  if (!runtime) throw new Error(`unknown managed profile harness: ${harness}`)
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
        if (translated.includes("--check")) throw new Error(`trx upgrade ${harness} --check is not supported; use trx harness-version ${harness}`)
        return ["harness-update", ...translated.filter((argument) => argument === "--dry-run")]
      }
      if (harness === "agency") throw new Error("Agency runtime upgrades are managed externally; use trx repair agency azure")
    }
  }
  if (operation === "upgrade" && translated.includes("--check")) {
    translated.splice(translated.indexOf("--check"), 1)
    const profileIndex = translated.findIndex((argument) => !argument.startsWith("-"))
    if (profileIndex !== -1) translated[profileIndex] = runtime.profileName(translated[profileIndex]!)
    return ["update", "--check", ...translated]
  }
  if (operation !== "instances" && operation !== "skill" && translated[0] && !translated[0].startsWith("-")) {
    const publicProfiles = nativePresetProfiles(harness)
    if (publicProfiles.includes(translated[0] as never)) translated[0] = runtime.profileName(translated[0]!)
  }
  return [operation === "upgrade" ? "update" : operation, ...translated]
}
