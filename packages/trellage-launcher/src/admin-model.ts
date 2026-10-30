/** Admin composition rows and their lazily refreshed operational state. */
import {
  loadProfileGuide,
  profileGuideIdentityKey,
  type ProfileGuideIdentity,
} from "@trellage/guide-core"
import type { CompositionCatalog, CompositionCatalogEntry } from "./composition-catalog.ts"
import { ProfileReadinessKind, type ProfileReadinessResult } from "./guide-preflight.ts"

/** Canonical Native harness identifiers. */
export type NativeHarnessId =
  | "agency"
  | "claude"
  | "codex"
  | "copilot"
  | "fx"
  | "grok"
  | "headlong"
  | "jcode"
  | "omp"
  | "pi"
  | "prime"
  | "uji"
  | "nodecode"
  | "empryo"

const allNativeHarnesses: ReadonlyArray<NativeHarnessId> = [
  "agency", "claude", "codex", "copilot", "fx", "grok", "headlong", "jcode", "omp", "pi", "prime", "uji", "nodecode", "empryo",
]

const updateCheckHarnesses: ReadonlySet<NativeHarnessId> = new Set(["copilot", "fx", "jcode", "omp", "prime"])
const versionProbeHarnesses: ReadonlySet<NativeHarnessId> = new Set(allNativeHarnesses.filter((harness) => harness !== "headlong"))

export interface NativeLauncherCapabilities {
  readonly doctorSupported: boolean
  readonly inventorySupported: boolean
  readonly updateCheckSupported: boolean
  readonly harnessVersionSupported: boolean
}

export const nativeLauncherCapabilities = (
  harness: string,
  lifecycle: CompositionCatalogEntry["lifecycle"] = isKnownNativeLauncher(harness) && !["codex", "fx", "grok", "headlong", "pi", "uji", "nodecode", "empryo"].includes(harness)
    ? { runtime: harness, profile: "default" }
    : null,
): NativeLauncherCapabilities => {
  if (!isKnownNativeLauncher(harness)) {
    return { doctorSupported: false, inventorySupported: false, updateCheckSupported: false, harnessVersionSupported: false }
  }
  return {
    doctorSupported: lifecycle !== null,
    inventorySupported: true,
    updateCheckSupported: lifecycle !== null && updateCheckHarnesses.has(harness),
    harnessVersionSupported: versionProbeHarnesses.has(harness),
  }
}

export const isKnownNativeLauncher = (launcher: string): launcher is NativeHarnessId =>
  allNativeHarnesses.includes(launcher as NativeHarnessId)

/** Distinct health/install status values. "unsupported" and "malformed-output" are never fabricated as healthy/unhealthy. */
export type AdminHealthStatus = "healthy" | "unhealthy" | "unsupported" | "malformed-output" | "unknown"
export type AdminInstallStatus = "installed" | "not-installed" | "unsupported" | "malformed-output" | "unknown"

export interface AdminProfileEntry {
  readonly ref: string
  readonly surface: "native"
  readonly launcher: string
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly lifecycle: CompositionCatalogEntry["lifecycle"]
  readonly name: string
  readonly description: string
  readonly commandPath: string
  readonly doctorSupported: boolean
  readonly inventorySupported: boolean
  readonly health: AdminHealthStatus
  readonly healthDiagnostic?: string
  readonly install: AdminInstallStatus
  readonly version?: string
  readonly updateCheckSupported: boolean
  readonly harnessVersionSupported: boolean
  readonly latestVersion?: string
  readonly updateAvailable?: boolean
  readonly updateCheckDiagnostic?: string
  readonly updateCheckStale: boolean
  readonly updateCheckedAt?: number
  readonly stale: boolean
  readonly lastCheckedAt?: number
}

/** Per-profile readiness input, keyed by the same `ref` used in `AdminProfileEntry`. */
export interface AdminReadinessInput {
  readonly ref: string
  /** `undefined` means "not yet checked" (kept `stale`); a thrown/rejected check is represented as `{ malformed: true }`. */
  readonly result?: ProfileReadinessResult | { readonly malformed: true; readonly diagnostic: string }
  readonly version?: string
  readonly checkedAt?: number
}

/**
 * The outcome of a single `update --check` parse (see `admin-version-check.ts`).
 * `installed` is populated only when the launcher's own output text names the
 * currently-installed version/commit/pin (every known family does); it is
 * never fabricated when the output doesn't contain one.
 */
export type AdminUpdateCheckResult =
  | { readonly malformed: true; readonly diagnostic: string }
  | { readonly current: true; readonly installed?: string }
  | { readonly current: false; readonly installed?: string; readonly latest: string }

/** Per-profile update-check input, keyed by the same `ref` used in `AdminProfileEntry`. */
export interface AdminUpdateCheckInput {
  readonly ref: string
  /** `undefined` means "not yet checked" (kept `updateCheckStale`). */
  readonly result?: AdminUpdateCheckResult
  readonly checkedAt?: number
}

const commandPathFor = (entry: CompositionCatalogEntry): string => entry.commandPath

const readinessFor = (ref: string, inputs: ReadonlyArray<AdminReadinessInput>): AdminReadinessInput | undefined =>
  inputs.find((input) => input.ref === ref)

const updateCheckFor = (ref: string, inputs: ReadonlyArray<AdminUpdateCheckInput>): AdminUpdateCheckInput | undefined =>
  inputs.find((input) => input.ref === ref)

const deriveUpdateCheck = (
  updateCheckSupported: boolean,
  input: AdminUpdateCheckInput | undefined,
): {
  readonly latestVersion?: string
  readonly updateAvailable?: boolean
  readonly updateCheckDiagnostic?: string
  readonly updateCheckStale: boolean
  readonly updateCheckedAt?: number
} => {
  if (!updateCheckSupported) return { updateCheckStale: false }
  if (input?.result === undefined) return { updateCheckStale: true }
  const base = {
    updateCheckStale: false,
    ...(input.checkedAt === undefined ? {} : { updateCheckedAt: input.checkedAt }),
  }
  if ("malformed" in input.result) return { ...base, updateCheckDiagnostic: input.result.diagnostic }
  if (input.result.current) return { ...base, updateAvailable: false }
  return { ...base, updateAvailable: true, latestVersion: input.result.latest }
}

const deriveNativeStatus = (
  capabilities: NativeLauncherCapabilities,
  readiness: AdminReadinessInput | undefined,
): { readonly health: AdminHealthStatus; readonly install: AdminInstallStatus; readonly diagnostic?: string } => {
  if (!capabilities.inventorySupported) return { health: "unsupported", install: "unsupported" }
  if (readiness?.result === undefined) return { health: "unknown", install: "unknown" }
  if ("malformed" in readiness.result) {
    return { health: "malformed-output", install: "malformed-output", diagnostic: readiness.result.diagnostic }
  }
  if (readiness.result.kind === ProfileReadinessKind.Ready) return { health: "healthy", install: "installed" }
  return {
    health: "unhealthy",
    install: readiness.result.summary.includes("not-setup") ? "not-installed" : "installed",
    diagnostic: readiness.result.diagnostic,
  }
}

const optionalIdentityFields = (entry: CompositionCatalogEntry): Pick<AdminProfileEntry, "launcher" | "harness"> => ({
  launcher: entry.harness,
  harness: entry.harness,
})

const optionalReadinessFields = (
  readiness: AdminReadinessInput | undefined,
  derived: { readonly diagnostic?: string },
): Pick<AdminProfileEntry, "healthDiagnostic" | "version" | "lastCheckedAt"> => ({
  ...(derived.diagnostic === undefined ? {} : { healthDiagnostic: derived.diagnostic }),
  ...(readiness?.version === undefined ? {} : { version: readiness.version }),
  ...(readiness?.checkedAt === undefined ? {} : { lastCheckedAt: readiness.checkedAt }),
})

const optionalUpdateFields = (
  updateCheck: ReturnType<typeof deriveUpdateCheck>,
): Pick<AdminProfileEntry, "latestVersion" | "updateAvailable" | "updateCheckDiagnostic" | "updateCheckedAt"> => ({
  ...(updateCheck.latestVersion === undefined ? {} : { latestVersion: updateCheck.latestVersion }),
  ...(updateCheck.updateAvailable === undefined ? {} : { updateAvailable: updateCheck.updateAvailable }),
  ...(updateCheck.updateCheckDiagnostic === undefined
    ? {}
    : { updateCheckDiagnostic: updateCheck.updateCheckDiagnostic }),
  ...(updateCheck.updateCheckedAt === undefined ? {} : { updateCheckedAt: updateCheck.updateCheckedAt }),
})

const aggregateAdminProfile = (
  entry: CompositionCatalogEntry,
  readinessInputs: ReadonlyArray<AdminReadinessInput>,
  updateCheckInputs: ReadonlyArray<AdminUpdateCheckInput>,
): AdminProfileEntry => {
  const readiness = readinessFor(entry.ref, readinessInputs)
  const capabilities = nativeLauncherCapabilities(entry.harness, entry.lifecycle)
  const derived = deriveNativeStatus(capabilities, readiness)
  const updateCheck = deriveUpdateCheck(capabilities.updateCheckSupported, updateCheckFor(entry.ref, updateCheckInputs))
  return {
    ref: entry.ref,
    surface: "native",
    ...optionalIdentityFields(entry),
    profiles: entry.profiles,
    lifecycle: entry.lifecycle,
    name: entry.profiles.join("+"),
    description: entry.description,
    commandPath: commandPathFor(entry),
    doctorSupported: capabilities.doctorSupported,
    inventorySupported: capabilities.inventorySupported,
    health: derived.health,
    install: derived.install,
    ...optionalReadinessFields(readiness, derived),
    updateCheckSupported: capabilities.updateCheckSupported,
    harnessVersionSupported: capabilities.harnessVersionSupported,
    ...optionalUpdateFields(updateCheck),
    updateCheckStale: updateCheck.updateCheckStale,
    stale: readiness?.result === undefined,
  }
}

/** Pure aggregation over the authoritative composition catalog. */
export const aggregateAdminProfiles = (
  catalog: CompositionCatalog,
  readinessInputs: ReadonlyArray<AdminReadinessInput> = [],
  updateCheckInputs: ReadonlyArray<AdminUpdateCheckInput> = [],
): ReadonlyArray<AdminProfileEntry> =>
  catalog.entries.map((entry) => aggregateAdminProfile(entry, readinessInputs, updateCheckInputs))

export const mergeAdminReadiness = (
  catalog: CompositionCatalog,
  entries: ReadonlyArray<AdminProfileEntry>,
  readinessInputs: ReadonlyArray<AdminReadinessInput>,
): ReadonlyArray<AdminProfileEntry> => {
  const templates = new Map(catalog.entries.map((entry) => [entry.ref, entry]))
  return entries.map((entry) => {
    const template = templates.get(entry.ref)
    if (template === undefined) throw new Error(`Admin entry has no catalog template: ${entry.ref}`)
    const { healthDiagnostic: _diagnostic, ...identity } = entry
    return { ...identity, ...aggregateAdminProfile(template, readinessInputs, []) }
  })
}

/** Maps a single-profile Admin row to the authored guide identity. */
export const toProfileGuideIdentity = (entry: AdminProfileEntry): ProfileGuideIdentity => ({
  surface: "native",
  harness: entry.harness,
  profile: entry.profiles[0] ?? "",
})

export interface GuideBodyResult {
  readonly available: true
  readonly body: string
}
export interface GuideBodyUnavailable {
  readonly available: false
  readonly reason: string
}

/**
 * Loads an authored guide body on demand. Composition catalog rows carry only
 * the parsed guide projection, so the Markdown body remains at the guide root.
 */
export const loadAdminProfileGuideBody = async (
  profileGuidesRoot: string,
  identity: ProfileGuideIdentity,
): Promise<GuideBodyResult | GuideBodyUnavailable> => {
  try {
    const loaded = await loadProfileGuide(profileGuidesRoot, identity)
    return { available: true, body: loaded.body }
  } catch (cause) {
    return {
      available: false,
      reason: `guide unavailable for ${profileGuideIdentityKey(identity)}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    }
  }
}
