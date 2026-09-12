/**
 * Harness-version command identity, parsing, and row reconciliation.
 * Operation keys scope subprocesses and cached installed state. Release
 * keys scope only a validated latest value, so equivalent native and
 * sandbox rows can share latest without copying another row's installed
 * revision.
 */
import { isKnownNativeLauncher, type AdminProfileEntry, type NativeLauncherAlias } from "./admin-model.ts"
import type { AdminVersionColumns } from "./admin-version-check.ts"
import type { CommandSpec } from "./guide-launch.ts"

export type HarnessReleaseKey =
  | "claude-code"
  | "codex"
  | "copilot-cli"
  | "firstmate"
  | "grok"
  | "headlong-main"
  | "jcode"
  | "oh-my-pi"
  | "pi-coding-agent"
  | "prime"

const nativeReleaseKeys: Readonly<Partial<Record<NativeLauncherAlias, HarnessReleaseKey>>> = {
  cpx: "copilot-cli",
  cdx: "codex",
  cldx: "claude-code",
  fmx: "firstmate",
  grx: "grok",
  jcx: "jcode",
  omp: "oh-my-pi",
  picx: "pi-coding-agent",
  prx: "prime",
}

const sandboxReleaseKeys: Readonly<Record<string, HarnessReleaseKey>> = {
  claude: "claude-code",
  codex: "codex",
  copilot: "copilot-cli",
  headlong: "headlong-main",
  pi: "oh-my-pi",
  prime: "prime",
}

const nativeLatestLookupLaunchers: ReadonlySet<NativeLauncherAlias> = new Set([
  "cdx",
  "fmx",
  "grx",
  "jcx",
  "omp",
  "picx",
  "prx",
])

export const harnessVersionReleaseKeyFor = (entry: AdminProfileEntry): HarnessReleaseKey | undefined => {
  if (entry.surface === "sandbox") return entry.harness === undefined ? undefined : sandboxReleaseKeys[entry.harness]
  if (entry.launcher === undefined || !isKnownNativeLauncher(entry.launcher)) return undefined
  return nativeReleaseKeys[entry.launcher]
}

export const harnessVersionLatestLookupSupported = (entry: AdminProfileEntry): boolean => {
  if (!entry.harnessVersionSupported) return false
  if (entry.surface === "sandbox") return harnessVersionReleaseKeyFor(entry) !== undefined
  return (
    entry.launcher !== undefined &&
    isKnownNativeLauncher(entry.launcher) &&
    nativeLatestLookupLaunchers.has(entry.launcher)
  )
}

/**
 * Cache/run identity. Firstmate owns one installed receipt per profile;
 * ordinary native launchers own one host binary; sandbox operations own a
 * shared latest lookup per explicit release identity.
 */
export const harnessVersionOperationKeyFor = (entry: AdminProfileEntry): string | undefined => {
  if (!entry.harnessVersionSupported) return undefined
  if (entry.surface === "sandbox") {
    const releaseKey = harnessVersionReleaseKeyFor(entry)
    return releaseKey === undefined ? undefined : `sandbox:${releaseKey}`
  }
  if (entry.launcher === undefined || !isKnownNativeLauncher(entry.launcher)) return undefined
  return entry.launcher === "fmx" ? `native:fmx:${entry.name}` : `native:${entry.launcher}`
}

export interface BuildHarnessVersionCommandOptions {
  readonly refreshLatest?: boolean
}

export const buildHarnessVersionCommand = (
  entry: AdminProfileEntry,
  options: BuildHarnessVersionCommandOptions = {},
): CommandSpec => {
  if (entry.surface === "sandbox") {
    return {
      executable: entry.commandPath,
      args: ["harness-version", entry.name, ...(options.refreshLatest === true ? ["--refresh-latest"] : [])],
    }
  }
  return {
    executable: entry.commandPath,
    args: entry.launcher === "fmx" ? ["harness-version", entry.name] : ["harness-version"],
  }
}

export type AdminInstalledVersionState =
  | { readonly kind: "known"; readonly version: string }
  | { readonly kind: "unavailable"; readonly diagnostic: string }

export type AdminLatestVersionState =
  | { readonly kind: "known"; readonly version: string }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly diagnostic: string }

export interface AdminHarnessVersionResult {
  readonly installed: AdminInstalledVersionState
  readonly latest: AdminLatestVersionState
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validVersion = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000\r\n]/u.test(value)
    ? value
    : undefined

const validDiagnostic = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000\r\n]/u.test(value)
    ? value
    : undefined

export const failedHarnessVersionResult = (diagnostic: string): AdminHarnessVersionResult => ({
  installed: { kind: "unavailable", diagnostic },
  latest: { kind: "failed", diagnostic },
})

export const refreshedSandboxInstalledState = (
  result: AdminHarnessVersionResult,
): AdminInstalledVersionState | undefined =>
  result.installed.kind === "known" || result.latest.kind !== "failed" ? result.installed : undefined

const parseInstalledState = (value: unknown): AdminInstalledVersionState => {
  const version = validVersion(value)
  return version === undefined
    ? { kind: "unavailable", diagnostic: "harness-version could not determine the installed harness version" }
    : { kind: "known", version }
}

const parseLatestState = (payload: Record<string, unknown>): AdminLatestVersionState => {
  if (payload.latestKnown === true) {
    const version = validVersion(payload.latest)
    return version === undefined
      ? { kind: "failed", diagnostic: "harness-version claimed a known latest version without a valid value" }
      : { kind: "known", version }
  }
  if (payload.latestKnown !== false || (payload.latest !== null && payload.latest !== undefined)) {
    return { kind: "failed", diagnostic: "harness-version produced an inconsistent latest-version result" }
  }
  if (payload.latestDiagnostic === undefined) return { kind: "unsupported" }
  const diagnostic = validDiagnostic(payload.latestDiagnostic)
  return diagnostic === undefined
    ? { kind: "failed", diagnostic: "harness-version produced an invalid latest-version diagnostic" }
    : { kind: "failed", diagnostic }
}

export const parseHarnessVersionOutput = (stdout: string): AdminHarnessVersionResult => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return failedHarnessVersionResult("harness-version produced no output")
  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return failedHarnessVersionResult(
      `harness-version produced non-JSON output: ${trimmed.split("\n")[0]?.slice(0, 400) ?? ""}`,
    )
  }
  if (!isPlainObject(payload) || payload.schemaVersion !== 1) {
    return failedHarnessVersionResult("harness-version produced an unrecognized schema")
  }

  return { installed: parseInstalledState(payload.installed), latest: parseLatestState(payload) }
}

export const harnessVersionColumnsFor = (
  supported: boolean,
  result: AdminHarnessVersionResult | undefined,
): AdminVersionColumns => {
  if (!supported || result === undefined) return { installed: "—", latest: "—", status: "unknown" }
  const installed = result.installed.kind === "known" ? result.installed.version : "—"
  const latest = result.latest.kind === "known" ? result.latest.version : "—"
  if (result.installed.kind !== "known" || result.latest.kind !== "known") {
    return { installed, latest, status: "unknown" }
  }
  return {
    installed,
    latest,
    status: result.installed.version === result.latest.version ? "match" : "mismatch",
  }
}

const resultForEntry = (
  entry: AdminProfileEntry,
  resultForOperation: (operationKey: string) => AdminHarnessVersionResult | undefined,
  sandboxInstalledForRef: (ref: string) => AdminInstalledVersionState | undefined,
): AdminHarnessVersionResult | undefined => {
  const operationKey = harnessVersionOperationKeyFor(entry)
  const raw = operationKey === undefined ? undefined : resultForOperation(operationKey)
  if (entry.surface === "native") return raw
  const installed: AdminInstalledVersionState =
    sandboxInstalledForRef(entry.ref) ??
    (validVersion(entry.version) === undefined
      ? { kind: "unavailable", diagnostic: "sandbox profile has no ready installed harness resolution" }
      : { kind: "known", version: entry.version! })
  return { installed, latest: raw?.latest ?? { kind: "unsupported" } }
}

// Firstmate reports a profile's catalog pin, not a shared upstream release.
const shareableReleaseKeyFor = (entry: AdminProfileEntry): HarnessReleaseKey | undefined =>
  entry.surface === "native" && entry.launcher === "fmx" ? undefined : harnessVersionReleaseKeyFor(entry)

/**
 * Produces one effective result per row. Conflicting latest values disable
 * cross-row promotion for that release identity rather than selecting an
 * arbitrary winner.
 */
export const reconcileHarnessVersionObservations = (
  entries: ReadonlyArray<AdminProfileEntry>,
  observationFor: (entry: AdminProfileEntry) => AdminHarnessVersionResult | undefined,
): ReadonlyMap<string, AdminHarnessVersionResult> => {
  const results = new Map<string, AdminHarnessVersionResult>()
  const latestByRelease = new Map<HarnessReleaseKey, Set<string>>()
  for (const entry of entries) {
    const result = observationFor(entry)
    if (result === undefined) continue
    results.set(entry.ref, result)
    const releaseKey = shareableReleaseKeyFor(entry)
    if (releaseKey === undefined || result.latest.kind !== "known") continue
    const versions = latestByRelease.get(releaseKey) ?? new Set<string>()
    versions.add(result.latest.version)
    latestByRelease.set(releaseKey, versions)
  }

  for (const entry of entries) {
    const result = results.get(entry.ref)
    const releaseKey = shareableReleaseKeyFor(entry)
    if (result === undefined || releaseKey === undefined || result.latest.kind === "known") continue
    const versions = latestByRelease.get(releaseKey)
    if (versions?.size !== 1) continue
    results.set(entry.ref, { installed: result.installed, latest: { kind: "known", version: [...versions][0]! } })
  }
  return results
}

export const reconcileHarnessVersionResults = (
  entries: ReadonlyArray<AdminProfileEntry>,
  resultForOperation: (operationKey: string) => AdminHarnessVersionResult | undefined,
  sandboxInstalledForRef: (ref: string) => AdminInstalledVersionState | undefined = () => undefined,
): ReadonlyMap<string, AdminHarnessVersionResult> =>
  reconcileHarnessVersionObservations(entries, (entry) => resultForEntry(entry, resultForOperation, sandboxInstalledForRef))

export const harnessVersionEntriesForForceResync = (
  selected: AdminProfileEntry,
  entries: ReadonlyArray<AdminProfileEntry>,
): ReadonlyArray<AdminProfileEntry> => {
  const operationKey = harnessVersionOperationKeyFor(selected)
  if (operationKey === undefined) return []
  if (selected.launcher === "fmx") {
    return entries.filter((entry) => harnessVersionOperationKeyFor(entry) === operationKey)
  }
  const releaseKey = harnessVersionReleaseKeyFor(selected)
  return releaseKey === undefined
    ? entries.filter((entry) => harnessVersionOperationKeyFor(entry) === operationKey)
    : entries.filter((entry) => harnessVersionReleaseKeyFor(entry) === releaseKey)
}
