/**
 * Builds the `update --check PROFILE` command for a native profile and
 * tolerantly parses its stdout into a structured current/latest-version
 * result. `update --check` is documented as read-only for every launcher
 * that implements it (e.g. `fmx`'s own usage text: "always offline: it
 * compares the installed receipt to the catalog pin and never fetches";
 * `prx`/`jcx`/`omp`/`picx` resolve the latest eligible release via `mise`
 * without mutating any installed state) — safe to run in the background
 * alongside doctor checks. Callers must check `entry.updateCheckSupported`
 * first (see `admin-model.ts`'s `launchersWithoutUpdateCheckSupport`;
 * currently only `cldx` lacks this command).
 *
 * Each native launcher implements `update --check` independently and their
 * exact human-readable message text differs (verified directly against
 * `prototypes/trellage-*-profiles/bin/*` and `native-codex`), so parsing
 * uses a small set of tolerant patterns covering every known family rather
 * than one launcher-specific format. Output that matches none of them is
 * never guessed at — it is reported as `{ malformed: true }`, the same
 * fail-closed posture `admin-model.ts` already uses for malformed doctor
 * output.
 */
import type { AdminProfileEntry, AdminUpdateCheckResult } from "./admin-model.js"
import type { CommandSpec } from "./guide-launch.js"

/** Builds `update --check PROFILE` for a profile. Callers must check `entry.updateCheckSupported` first. */
export const buildUpdateCheckCommand = (entry: AdminProfileEntry): CommandSpec => ({
  executable: entry.commandPath,
  args: ["update", "--check", entry.name],
})

/** Each pattern's capture group 1, when present, is the installed version/commit/pin named in that family's own output text. */
const currentPatterns: ReadonlyArray<RegExp> = [
  // fmx: "fmx update: default is current (abc123def456)"
  // cpx/grx: "default: current (1.2.3)"
  /\bcurrent\s*\(([^)]+)\)/i,
  // prx/jcx/omp/picx: "prx update: 0.8.1 is current"
  /\b(\S+)\s+is current\b/i,
]

/** Each pattern's capture group 1 is the installed version/commit/pin and group 2 is the latest available one. */
const updateAvailablePatterns: ReadonlyArray<RegExp> = [
  // prx/jcx/omp/picx: "prx update: 0.8.1 -> 0.9.0 available"
  /([^\s:][^\s]*)\s*->\s*([^\s]+?)\s+available/i,
  // cpx/grx: "default: update available (1.2.3 -> 1.3.0)"
  /update available\s*\(\s*([^\s]+?)\s*->\s*([^\s)]+?)\s*\)/i,
  // fmx: "fmx update: default is stale (installed abc123def456, catalog pin 789abc012def)"
  /is stale\s*\(installed\s+([^\s,]+),\s*catalog pin\s+([^\s)]+)\)/i,
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
export const parseUpdateCheckOutput = (stdout: string, installedVersion: string | undefined): AdminUpdateCheckResult => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return { malformed: true, diagnostic: "update --check produced no output" }

  for (const pattern of notInstalledPatterns) {
    if (pattern.test(trimmed)) return { malformed: true, diagnostic: trimmed.split("\n")[0] ?? trimmed }
  }
  for (const pattern of updateAvailablePatterns) {
    const match = pattern.exec(trimmed)
    if (match?.[2] !== undefined) {
      const installed = match[1] ?? installedVersion
      return { current: false, latest: match[2], ...(installed === undefined ? {} : { installed }) }
    }
  }
  for (const pattern of currentPatterns) {
    const match = pattern.exec(trimmed)
    if (match !== null) {
      const installed = match[1] ?? installedVersion
      return { current: true, ...(installed === undefined ? {} : { installed }) }
    }
  }
  return {

    malformed: true,
    diagnostic: `unrecognized update --check output${installedVersion === undefined ? "" : ` (installed ${installedVersion})`}: ${trimmed.split("\n")[0] ?? trimmed}`,
  }
}
