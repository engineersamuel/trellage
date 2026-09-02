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

const currentPatterns: ReadonlyArray<RegExp> = [
  // prx/jcx/omp/picx: "prx update: 0.8.1 is current"
  /\bis current\b/i,
  // fmx: "fmx update: default is current (abc123def456)"
  // cpx/grx: "default: current (1.2.3)"
  /\bcurrent\b\s*\(/i,
]

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
 * Formats the compact table-cell label for a profile's version column:
 * `"—"` when unsupported/not yet checked, the installed version alone when
 * current or unchecked-but-known, or `"installed → latest"` once a check
 * finds a newer release. Never fabricates a value beyond what
 * `installedVersion`/the parsed check result actually contain.
 */
export const formatVersionCell = (
  installedVersion: string | undefined,
  supported: boolean,
  result: AdminUpdateCheckResult | undefined,
): string => {
  if (!supported) return installedVersion ?? "—"
  if (result !== undefined && !("malformed" in result) && !result.current) {
    return `${installedVersion ?? "?"} → ${result.latest}`
  }
  return installedVersion ?? "—"
}

/**
 * Parses `update --check` stdout into a structured result. `installedVersion`
 * (the already-known `entry.version` from doctor/inventory) is preferred
 * over any "current" token re-parsed from this output, since it is already
 * validated elsewhere — this parser only needs to determine whether an
 * update is available and, if so, the latest version string.
 */
export const parseUpdateCheckOutput = (stdout: string, installedVersion: string | undefined): AdminUpdateCheckResult => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return { malformed: true, diagnostic: "update --check produced no output" }

  for (const pattern of notInstalledPatterns) {
    if (pattern.test(trimmed)) return { malformed: true, diagnostic: trimmed.split("\n")[0] ?? trimmed }
  }
  for (const pattern of updateAvailablePatterns) {
    const match = pattern.exec(trimmed)
    if (match?.[2] !== undefined) return { current: false, latest: match[2] }
  }
  for (const pattern of currentPatterns) {
    if (pattern.test(trimmed)) return { current: true }
  }
  return {
    malformed: true,
    diagnostic: `unrecognized update --check output${installedVersion === undefined ? "" : ` (installed ${installedVersion})`}: ${trimmed.split("\n")[0] ?? trimmed}`,
  }
}
