/**
 * Builds the read-only `update --check PROFILE` command and parses the managed
 * backends' human-readable output. Unknown output fails closed as malformed.
 */
import type { AdminProfileEntry, AdminUpdateCheckResult } from "./admin-model.ts"
import type { CommandSpec } from "./guide-launch.ts"

/** Builds `update --check PROFILE` for a profile. Callers must check `entry.updateCheckSupported` first. */
export const buildUpdateCheckCommand = (entry: AdminProfileEntry): CommandSpec => ({
  executable: entry.commandPath,
  args: ["upgrade", entry.launcher!, entry.name, "--check"],
})

/** Each pattern's capture group 1, when present, is the installed version/commit/pin named in that family's own output text. */
const currentPatterns: ReadonlyArray<RegExp> = [
  // cpx: "default: current (1.2.3)"
  /\bcurrent\s*\(([^)]+)\)/i,
  // prx/jcx/omp: "prx update: 0.8.1 is current"
  /\b(\S+)\s+is current\b/i,
]

/** Each pattern's capture group 1 is the installed version/commit/pin and group 2 is the latest available one. */
const updateAvailablePatterns: ReadonlyArray<RegExp> = [
  /([^\s:][^\s]*)\s*->\s*([^\s]+?)\s+available/i,
  // cpx: "default: update available (1.2.3 -> 1.3.0)"
  /update available\s*\(\s*([^\s]+?)\s*->\s*([^\s)]+?)\s*\)/i,
]


const notInstalledPatterns: ReadonlyArray<RegExp> = [
  /:\s*not installed\b/i,
  /\bis not set up\b/i,
]

/**
 * A profile's `VERSION` (installed) and `LATEST VERSION` (catalog/upstream)
 * table cells, plus a comparison status the UI uses purely for color: `"match"`
 * when a completed check confirms the installed release is current (both
 * columns render the same value in green), `"mismatch"` when a completed
 * check names a newer release (installed in yellow/orange, latest in
 * yellow/orange), or `"unknown"` when the launcher doesn't support
 * `update --check`, no check has run yet, or the check's output was
 * malformed — in every `"unknown"` case `latest` is always `"—"` since no
 * value is actually known, never fabricated.
 */
export type AdminVersionComparisonStatus = "match" | "mismatch" | "unknown"

export interface AdminVersionColumns {
  readonly installed: string
  readonly latest: string
  readonly status: AdminVersionComparisonStatus
}

/**
 * Derives the `VERSION` and `LATEST VERSION` table cells and their
 * match/mismatch/unknown comparison status for a profile. Prefers the
 * version the check's own output named (`result.installed`) over the
 * caller-supplied `installedVersion` fallback, since the former reflects the
 * most recent live check. Never fabricates a value beyond what either source
 * actually contains.
 */
export const versionColumnsFor = (
  installedVersion: string | undefined,
  supported: boolean,
  result: AdminUpdateCheckResult | undefined,
): AdminVersionColumns => {
  const installedFallback = installedVersion ?? "—"
  if (!supported || result === undefined || "malformed" in result) {
    return { installed: installedFallback, latest: "—", status: "unknown" }
  }
  const installed = result.installed ?? installedVersion ?? "—"
  if (result.current) return { installed, latest: installed, status: "match" }
  return { installed, latest: result.latest, status: "mismatch" }
}

/**
 * Parses `update --check` stdout into a structured result. `installedVersion`
 * (the already-known `entry.version` from doctor/inventory, when available)
 * is used only as a fallback: every known output family names its own
 * installed version/commit/pin directly (see `currentPatterns` and
 * `updateAvailablePatterns`), and that freshly-parsed value is always
 * preferred so the version column reflects the live check result.
 */
const availableVersion = (trimmed: string, installedVersion: string | undefined): AdminUpdateCheckResult | undefined => {
  for (const pattern of updateAvailablePatterns) {
    const match = pattern.exec(trimmed)
    if (match?.[2] !== undefined) {
      const installed = match[1] ?? installedVersion
      return { current: false, latest: match[2], ...(installed === undefined ? {} : { installed }) }
    }
  }
  return undefined
}

const currentVersion = (trimmed: string, installedVersion: string | undefined): AdminUpdateCheckResult | undefined => {
  for (const pattern of currentPatterns) {
    const match = pattern.exec(trimmed)
    if (match !== null) {
      const installed = match[1] ?? installedVersion
      return { current: true, ...(installed === undefined ? {} : { installed }) }
    }
  }
  return undefined
}

export const parseUpdateCheckOutput = (stdout: string, installedVersion: string | undefined): AdminUpdateCheckResult => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return { malformed: true, diagnostic: "update --check produced no output" }
  if (notInstalledPatterns.some((pattern) => pattern.test(trimmed))) {
    return { malformed: true, diagnostic: trimmed.split("\n")[0] ?? trimmed }
  }
  const parsed = availableVersion(trimmed, installedVersion) ?? currentVersion(trimmed, installedVersion)
  if (parsed !== undefined) return parsed
  return {
    malformed: true,
    diagnostic: `unrecognized update --check output${installedVersion === undefined ? "" : ` (installed ${installedVersion})`}: ${trimmed.split("\n")[0] ?? trimmed}`,
  }
}
