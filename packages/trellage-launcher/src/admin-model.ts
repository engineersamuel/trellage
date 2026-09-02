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
 * `inventory PROFILE --json`. If a future native launcher genuinely lacks
 * doctor support, add it to `launchersWithoutDoctorSupport` below so it is
 * never shown with a fabricated healthy/unhealthy status.
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
export type NativeLauncherAlias = "cpx" | "cdx" | "cldx" | "grx" | "jcx" | "omp" | "picx" | "prx"

const allNativeLaunchers: ReadonlyArray<NativeLauncherAlias> = [
  "cpx",
  "cdx",
  "cldx",
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

export interface NativeLauncherCapabilities {
  readonly doctorSupported: boolean
  readonly inventorySupported: boolean
}

export const nativeLauncherCapabilities = (launcher: string): NativeLauncherCapabilities => {
  const supported = !launchersWithoutDoctorSupport.has(launcher as NativeLauncherAlias)
  return { doctorSupported: supported, inventorySupported: supported }
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

const commandPathFor = (entry: GuideCatalogEntryRef, catalog: CombinedGuideCatalog): string =>
  entry.surface === "sandbox"
    ? catalog.sandboxCommandPath
    : (catalog.native.find((native) => native.launcher === entry.launcher && native.name === entry.name)
        ?.commandPath ?? "")

const readinessFor = (ref: string, inputs: ReadonlyArray<AdminReadinessInput>): AdminReadinessInput | undefined =>
  inputs.find((input) => input.ref === ref)

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

/**
 * Pure aggregation: merges catalog entries with already-produced readiness
 * results by stable `ref` identity. A malformed/missing readiness result for
 * one profile never affects any other profile's entry (fail-closed,
 * isolated per entry).
 */
export const aggregateAdminProfiles = (
  catalog: CombinedGuideCatalog,
  readinessInputs: ReadonlyArray<AdminReadinessInput> = [],
): ReadonlyArray<AdminProfileEntry> =>
  guideCatalogEntries(catalog).map((entry): AdminProfileEntry => {
    const readiness = readinessFor(entry.ref, readinessInputs)
    const capabilities =
      entry.surface === "native" ? nativeLauncherCapabilities(entry.launcher ?? "") : { doctorSupported: true, inventorySupported: true }
    const derived =
      entry.surface === "native" ? deriveNativeStatus(capabilities, readiness) : deriveSandboxStatus(readiness)
    return {
      ref: entry.ref,
      surface: entry.surface,
      ...(entry.launcher === undefined ? {} : { launcher: entry.launcher }),
      ...(entry.harness === undefined ? {} : { harness: entry.harness }),
      name: entry.name,
      description: entry.description,
      commandPath: commandPathFor(entry, catalog),
      doctorSupported: capabilities.doctorSupported,
      inventorySupported: capabilities.inventorySupported,
      health: derived.health,
      ...(derived.diagnostic === undefined ? {} : { healthDiagnostic: derived.diagnostic }),
      install: derived.install,
      ...(readiness?.version === undefined ? {} : { version: readiness.version }),
      stale: readiness?.result === undefined,
      ...(readiness?.checkedAt === undefined ? {} : { lastCheckedAt: readiness.checkedAt }),
    }
  })

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
