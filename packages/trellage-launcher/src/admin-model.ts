/**
 * Admin data model: aggregates the combined native + sandbox guide catalog
 * (`guide-catalog.ts`) with per-profile health/install readiness
 * (`guide-preflight.ts`, `profile-readiness.ts`-equivalent shapes) into one
 * `AdminProfileEntry` per profile for the Admin mode. Pure data-shaping only
 * — no subprocess execution happens here (see `admin-run-manager.ts`).
 *
 * Doctor/inventory support is a static, per-launcher fact derived from the
 * concrete native launcher contracts (`prototypes/trellage-*-profiles/bin/*`
 * and the shared implementations they source, e.g.
 * `prototypes/trellage-codex-common/native-codex`). Every native launcher,
 * including `cdx` (Codex, which delegates its `doctor`/`inventory --json`/
 * `repair` dispatch to `native-codex`), implements `doctor PROFILE` and
 * `inventory PROFILE --json`. Capabilities fail closed for aliases not
 * listed below.
 */
import {
  loadProfileGuide,
  profileGuideIdentityKey,
  type ProfileGuideIdentity,
} from "../../trellage-guide-core/dist/index.js"
import type { CombinedGuideCatalog, GuideCatalogEntryRef } from "./guide-catalog.js"
import { guideCatalogEntries } from "./guide-catalog.js"
import { ProfileReadinessKind, type ProfileReadinessResult } from "./guide-preflight.js"

/** Native launcher command aliases, matching `guide-catalog.ts` `launcher` values. */
export type NativeLauncherAlias = "agx" | "cpx" | "cdx" | "cldx" | "fmx" | "grx" | "jcx" | "omp" | "picx" | "prx"

const allNativeLaunchers: ReadonlyArray<NativeLauncherAlias> = [
  "agx",
  "cpx",
  "cdx",
  "cldx",
  "fmx",
  "grx",
  "jcx",
  "omp",
  "picx",
  "prx",
]

/**
 * Static capability table. Every current native launcher supports both
 * `doctor PROFILE` and `inventory PROFILE --json` (confirmed present in each
 * launcher's `bin/*` usage text and command dispatch, including `cdx`'s
 * shared `native-codex` implementation's `doctor)`/`inventory)`/`repair)`
 * cases). Kept as an explicit set — rather than assuming universal support
 * — so a future native launcher that genuinely lacks doctor support can be
 * added here without fabricating a healthy/unhealthy status for it.
 */
const launchersWithoutDoctorSupport: ReadonlySet<NativeLauncherAlias> = new Set<NativeLauncherAlias>([])

/**
 * `cldx` (Claude native) is the one current native launcher whose `bin/cldx`
 * usage text never lists an `update`/`update --check` subcommand (verified
 * directly against `prototypes/trellage-claude-profiles/bin/cldx`) — every
 * other native launcher, including `cdx` via the shared `native-codex`
 * dispatch, implements `update --check PROFILE`. Kept as an explicit
 * exclusion set, matching `launchersWithoutDoctorSupport`, so a future
 * launcher without update-check support can be added here without
 * fabricating version data for it.
 */
const launchersWithoutUpdateCheckSupport: ReadonlySet<NativeLauncherAlias> = new Set<NativeLauncherAlias>([
  "agx",
  "cldx",
])

/**
 * Every listed native launcher except Agency exposes `harness-version`.
 * Firstmate's command is profile-scoped because installed receipts differ;
 * the others report one host harness binary shared by their profiles.
 */
const launchersWithoutHarnessVersionSupport: ReadonlySet<NativeLauncherAlias> = new Set<NativeLauncherAlias>(["agx"])

export interface NativeLauncherCapabilities {
  readonly doctorSupported: boolean
  readonly inventorySupported: boolean
  /** Whether this launcher's `update --check PROFILE` (a read-only, non-mutating command) is safe to run in the background. */
  readonly updateCheckSupported: boolean
  /** Whether this launcher's `harness-version` (a read-only, launcher-scoped, non-mutating command reporting the harness CLI's own version) is safe to run in the background. */
  readonly harnessVersionSupported: boolean
}

export const nativeLauncherCapabilities = (launcher: string): NativeLauncherCapabilities => {
  if (!isKnownNativeLauncher(launcher)) {
    return {
      doctorSupported: false,
      inventorySupported: false,
      updateCheckSupported: false,
      harnessVersionSupported: false,
    }
  }
  const supported = !launchersWithoutDoctorSupport.has(launcher)
  return {
    doctorSupported: supported,
    inventorySupported: supported,
    updateCheckSupported: supported && !launchersWithoutUpdateCheckSupport.has(launcher),
    harnessVersionSupported: supported && !launchersWithoutHarnessVersionSupport.has(launcher),
  }
}

export const isKnownNativeLauncher = (launcher: string): launcher is NativeLauncherAlias =>
  allNativeLaunchers.includes(launcher as NativeLauncherAlias)

/** Distinct health/install status values. "unsupported" and "malformed-output" are never fabricated as healthy/unhealthy. */
export type AdminHealthStatus = "healthy" | "unhealthy" | "unsupported" | "malformed-output" | "unknown"
export type AdminInstallStatus = "installed" | "not-installed" | "unsupported" | "malformed-output" | "unknown"

export interface AdminProfileEntry {
  readonly ref: string
  readonly surface: "native" | "sandbox"
  readonly launcher?: string
  readonly harness?: string
  readonly name: string
  readonly description: string
  readonly commandPath: string
  readonly doctorSupported: boolean
  readonly inventorySupported: boolean
  readonly health: AdminHealthStatus
  readonly healthDiagnostic?: string
  readonly install: AdminInstallStatus
  readonly version?: string
  /** Configured Container selector, separate from the installed version and latest release. */
  readonly harnessVersionSelector?: string
  /** Whether this profile's launcher supports a read-only `update --check` (see `launchersWithoutUpdateCheckSupport`). Always `false` for sandbox profiles: `trellage upgrade` rebuilds the locked image and has no safe read-only equivalent. */
  readonly updateCheckSupported: boolean
  /** Whether this profile supports the read-only `harness-version` report. Sandbox reports use receipt-backed installed revisions and authoritative latest sources where defined. */
  readonly harnessVersionSupported: boolean
  /** The latest version reported by the most recent successful `update --check`, when it differs from `version`. `undefined` while unchecked, unsupported, or when already current. */
  readonly latestVersion?: string
  /** `true` only when a successful check found a newer version than `version`. `undefined` while unchecked/unsupported/malformed. */
  readonly updateAvailable?: boolean
  readonly updateCheckDiagnostic?: string
  /** True until this entry's own update-check has completed after the most recent refresh trigger (startup or forced resync). */
  readonly updateCheckStale: boolean
  readonly updateCheckedAt?: number
  /** True until this entry's own health/install check has completed after the most recent refresh trigger. */
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

const commandPathFor = (entry: GuideCatalogEntryRef, catalog: CombinedGuideCatalog): string =>
  entry.surface === "sandbox"
    ? catalog.sandboxCommandPath
    : (catalog.native.find((native) => native.launcher === entry.launcher && native.name === entry.name)?.commandPath ??
      "")

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
  if (!capabilities.doctorSupported) return { health: "unsupported", install: "unsupported" }
  if (readiness?.result === undefined) return { health: "unknown", install: "unknown" }
  if ("malformed" in readiness.result) {
    return { health: "malformed-output", install: "malformed-output", diagnostic: readiness.result.diagnostic }
  }
  if (readiness.result.kind === ProfileReadinessKind.Ready) {
    return { health: "healthy", install: "installed" }
  }
  return {
    health: "unhealthy",
    install: readiness.result.summary.includes("not-setup") ? "not-installed" : "installed",
    diagnostic: readiness.result.diagnostic,
  }
}

const deriveSandboxStatus = (
  readiness: AdminReadinessInput | undefined,
): { readonly health: AdminHealthStatus; readonly install: AdminInstallStatus; readonly diagnostic?: string } => {
  if (readiness?.result === undefined) return { health: "unknown", install: "unknown" }
  if ("malformed" in readiness.result) {
    return { health: "malformed-output", install: "malformed-output", diagnostic: readiness.result.diagnostic }
  }
  return readiness.result.kind === ProfileReadinessKind.Ready
    ? { health: "healthy", install: "installed" }
    : { health: "unhealthy", install: "not-installed", diagnostic: readiness.result.diagnostic }
}

const sandboxCapabilities: NativeLauncherCapabilities = {
  doctorSupported: true,
  inventorySupported: false,
  updateCheckSupported: false,
  harnessVersionSupported: true,
}

const optionalIdentityFields = (entry: GuideCatalogEntryRef): Pick<AdminProfileEntry, "launcher" | "harness"> => ({
  ...(entry.launcher === undefined ? {} : { launcher: entry.launcher }),
  ...(entry.harness === undefined ? {} : { harness: entry.harness }),
})

const optionalReadinessFields = (
  entry: GuideCatalogEntryRef,
  readiness: AdminReadinessInput | undefined,
  derived: { readonly diagnostic?: string },
): Pick<AdminProfileEntry, "healthDiagnostic" | "version" | "lastCheckedAt"> => {
  const version = readiness?.version ?? entry.resolvedVersion
  return {
    ...(derived.diagnostic === undefined ? {} : { healthDiagnostic: derived.diagnostic }),
    ...(version === undefined ? {} : { version }),
    ...(readiness?.checkedAt === undefined ? {} : { lastCheckedAt: readiness.checkedAt }),
  }
}

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

const optionalHarnessTargetFields = (
  entry: GuideCatalogEntryRef,
  catalog: CombinedGuideCatalog,
): Pick<AdminProfileEntry, "harnessVersionSelector"> => {
  if (entry.surface !== "sandbox") return {}
  const selector = catalog.sandbox.find((profile) => profile.name === entry.name)?.harness.version
  return selector === undefined ? {} : { harnessVersionSelector: selector }
}

const aggregateAdminProfile = (
  entry: GuideCatalogEntryRef,
  catalog: CombinedGuideCatalog,
  readinessInputs: ReadonlyArray<AdminReadinessInput>,
  updateCheckInputs: ReadonlyArray<AdminUpdateCheckInput>,
): AdminProfileEntry => {
  const readiness = readinessFor(entry.ref, readinessInputs)
  const capabilities =
    entry.surface === "native" ? nativeLauncherCapabilities(entry.launcher ?? "") : sandboxCapabilities
  const derived =
    entry.surface === "native" ? deriveNativeStatus(capabilities, readiness) : deriveSandboxStatus(readiness)
  const updateCheck = deriveUpdateCheck(capabilities.updateCheckSupported, updateCheckFor(entry.ref, updateCheckInputs))
  return {
    ref: entry.ref,
    surface: entry.surface,
    ...optionalIdentityFields(entry),
    name: entry.name,
    description: entry.description,
    commandPath: commandPathFor(entry, catalog),
    doctorSupported: capabilities.doctorSupported,
    inventorySupported: capabilities.inventorySupported,
    health: derived.health,
    install: derived.install,
    ...optionalReadinessFields(entry, readiness, derived),
    ...optionalHarnessTargetFields(entry, catalog),
    updateCheckSupported: capabilities.updateCheckSupported,
    harnessVersionSupported: capabilities.harnessVersionSupported,
    ...optionalUpdateFields(updateCheck),
    updateCheckStale: updateCheck.updateCheckStale,
    stale: readiness?.result === undefined,
  }
}

/**
 * Pure aggregation: merges catalog entries with already-produced readiness
 * results by stable `ref` identity. A malformed/missing readiness result for
 * one profile never affects any other profile's entry (fail-closed,
 * isolated per entry).
 */
export const aggregateAdminProfiles = (
  catalog: CombinedGuideCatalog,
  readinessInputs: ReadonlyArray<AdminReadinessInput> = [],
  updateCheckInputs: ReadonlyArray<AdminUpdateCheckInput> = [],
): ReadonlyArray<AdminProfileEntry> =>
  guideCatalogEntries(catalog).map((entry) => aggregateAdminProfile(entry, catalog, readinessInputs, updateCheckInputs))

/** Maps an admin entry back to the identity `loadProfileGuide` expects. Native entries always carry a `launcher`. */
export const toProfileGuideIdentity = (entry: AdminProfileEntry): ProfileGuideIdentity =>
  entry.surface === "native"
    ? { surface: "native", launcher: entry.launcher ?? "", profile: entry.name }
    : { surface: "sandbox", profile: entry.name }

export interface GuideBodyResult {
  readonly available: true
  readonly body: string
}
export interface GuideBodyUnavailable {
  readonly available: false
  readonly reason: string
}

/**
 * Loads the raw Markdown guide body on demand (never eagerly for every row).
 * Catalog entries only carry the parsed structured `ProfileGuideV1`
 * projection, never the Markdown body (see `guide-catalog.ts` doc comment),
 * so the body must be read from the `profile-guides/` root via the same
 * `loadProfileGuide` function `packages/trellage-cli/src/profile-guides.ts`
 * already uses for sandbox guides.
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
