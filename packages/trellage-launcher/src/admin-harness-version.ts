/**
 * Builds the launcher-scoped `harness-version` command and tolerantly
 * parses its stdout. Unlike `admin-version-check.ts`'s `update --check
 * PROFILE` (which for `cpx`/`cdx`/`grx` genuinely compares a named
 * profile's plugin/skill bundle version against a marketplace manifest,
 * not the harness CLI's own version), `harness-version` reports the
 * installed **harness binary's own version** — e.g. `copilot --version`,
 * not the "awesome" plugin bundle's version. It is scoped to the launcher,
 * not the profile: every profile sharing one launcher (e.g. `omp`'s
 * "local"/"copilot" profiles) shares the exact same one harness binary, so
 * this command never takes a profile name argument and its result is fanned
 * out to every profile sharing that launcher (see
 * `admin-harness-version-scheduler.ts`).
 *
 * Each native launcher emits one line of JSON:
 * `{schemaVersion: 1, launcher, harness, installed, latest, latestKnown}`
 * (verified directly against `prototypes/trellage-*-profiles/bin/*` and
 * `prototypes/trellage-codex-common/native-codex`). `latestKnown` is
 * `false` for launchers that wrap a host-installed CLI with no known
 * latest-version mechanism (`cpx`/`cdx`/`grx`/`cldx` — no npm-registry or
 * GitHub-release lookup exists anywhere in this codebase for these tools,
 * confirmed by research), and `true` for `mise`-managed single-binary
 * launchers (`jcx`/`omp`/`picx`/`prx`) whose `latest` is resolved via
 * `mise_env latest`. `latest` is never fabricated when it isn't knowable.
 */
import type { AdminProfileEntry } from "./admin-model.js"
import type { AdminVersionColumns } from "./admin-version-check.js"
import type { CommandSpec } from "./guide-launch.js"

/** Builds `LAUNCHER harness-version` for any profile of that launcher. Callers must check `entry.harnessVersionSupported` first. */
export const buildHarnessVersionCommand = (commandPath: string): CommandSpec => ({
  executable: commandPath,
  args: ["harness-version"],
})

/**
 * A launcher's harness-version outcome. `"unavailable"` covers a genuine
 * failure (malformed JSON, an unrecognized shape, or a `null` installed
 * value the launcher itself could not determine) and never carries a
 * version. `"unknown-latest"` is the honest "installed is known, latest is
 * architecturally unknowable" state (`cpx`/`cdx`/`grx`/`cldx`) — distinct
 * from `"unavailable"` so the table can still show the real installed
 * version rather than blanking it. `"known-latest"` is the fully-resolved
 * comparison state (`jcx`/`omp`/`picx`/`prx`).
 */
export type AdminHarnessVersionResult =
  | { readonly kind: "unavailable"; readonly diagnostic: string }
  | { readonly kind: "unknown-latest"; readonly installed: string }
  | { readonly kind: "known-latest"; readonly installed: string; readonly latest: string }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Parses one launcher's `harness-version` stdout. Fails closed to
 * `{ kind: "unavailable" }` on empty output, invalid JSON, an unexpected
 * shape, an unsupported `schemaVersion`, or a `null`/non-string `installed`
 * (the launcher itself could not determine its own harness's installed
 * version — never guessed at).
 */
export const parseHarnessVersionOutput = (stdout: string): AdminHarnessVersionResult => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return { kind: "unavailable", diagnostic: "harness-version produced no output" }
  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return { kind: "unavailable", diagnostic: `harness-version produced non-JSON output: ${trimmed.split("\n")[0] ?? trimmed}` }
  }
  if (!isPlainObject(payload) || payload.schemaVersion !== 1) {
    return { kind: "unavailable", diagnostic: "harness-version produced an unrecognized schema" }
  }
  const installed = typeof payload.installed === "string" ? payload.installed : undefined
  if (installed === undefined) {
    return { kind: "unavailable", diagnostic: "harness-version could not determine the installed harness version" }
  }
  const latestKnown = payload.latestKnown === true
  const latest = typeof payload.latest === "string" ? payload.latest : undefined
  if (!latestKnown || latest === undefined) return { kind: "unknown-latest", installed }
  return { kind: "known-latest", installed, latest }
}

/**
 * Derives the `VERSION` and `LATEST VERSION` table cells for a harness's
 * version-check result: `"match"` (both green) when installed equals
 * latest, `"mismatch"` (both yellow/orange) when they differ, or
 * `"unknown"` when the launcher doesn't support harness-version, no check
 * has run yet, the check failed, or latest is architecturally unknowable
 * for this launcher family — in the latter case the real installed value
 * is still shown (never blanked), only `latest` renders as `"—"`.
 */
export const harnessVersionColumnsFor = (
  supported: boolean,
  result: AdminHarnessVersionResult | undefined,
): AdminVersionColumns => {
  if (!supported || result === undefined || result.kind === "unavailable") {
    return { installed: "—", latest: "—", status: "unknown" }
  }
  if (result.kind === "unknown-latest") return { installed: result.installed, latest: "—", status: "unknown" }
  return result.installed === result.latest
    ? { installed: result.installed, latest: result.latest, status: "match" }
    : { installed: result.installed, latest: result.latest, status: "mismatch" }
}

/** The distinct launcher for a native profile entry, or `undefined` for a sandbox entry (harness-version is native-only). */
export const harnessVersionLauncherFor = (entry: AdminProfileEntry): string | undefined =>
  entry.surface === "native" ? entry.launcher : undefined
