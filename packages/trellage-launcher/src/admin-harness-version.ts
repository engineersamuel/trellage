/**
 * Builds the `harness-version` command for a profile entry and tolerantly
 * parses its stdout. Unlike `admin-version-check.ts`'s `update --check
 * PROFILE` (which for `cpx`/`cdx`/`grx` genuinely compares a named
 * profile's plugin/skill bundle version against a marketplace manifest,
 * not the harness CLI's own version), `harness-version` reports the
 * installed **harness binary's own version** — e.g. `copilot --version`,
 * not the "awesome" plugin bundle's version.
 *
 * For native, this is scoped to the launcher, not the profile: every
 * profile sharing one launcher (e.g. `omp`'s "local"/"copilot" profiles)
 * shares the exact same one harness binary, so the command never takes a
 * profile name argument and its result is fanned out to every profile
 * sharing that launcher (see `admin-harness-version-scheduler.ts`). For
 * sandbox, this is scoped to the individual profile: each locked image can
 * resolve `harness.version = "latest"` to a different exact version
 * independently (via `trellage-cli`'s local lock/resolution-receipt), so
 * the sandbox `commandPath` (`prototypes/trellage/trellage`) is invoked as
 * `harness-version PROFILE_NAME` and its result applies only to that one
 * profile — never fanned out.
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
 *
 * The sandbox harness-version subcommand emits the same JSON shape
 * (without a `launcher` field, which `parseHarnessVersionOutput` never
 * requires) via `packages/trellage-cli/src/harness-version-report.ts`,
 * for every sandbox harness kind: `installed` comes from the profile's
 * local lock/resolution receipt (never fabricated when not yet resolved),
 * regardless of harness kind. `latest` is currently only resolved for the
 * `claude` harness kind, via a GitHub Releases lookup against
 * `anthropics/claude-code` (`latestKnown: false` on lookup failure or
 * for any non-claude harness kind, exactly like `cpx`/`cdx`/`grx`/`cldx`
 * natively — `installed` is still preserved either way).
 */
import type { AdminProfileEntry } from "./admin-model.js"
import type { AdminVersionColumns } from "./admin-version-check.js"
import type { CommandSpec } from "./guide-launch.js"

/** Builds the `harness-version` command for one profile entry: no-arg `LAUNCHER harness-version` for native (shared per launcher), `trellage harness-version PROFILE_NAME` for a sandbox profile (harness version is genuinely per-profile, since each locked image can float independently). Callers must check `entry.harnessVersionSupported` first. */
export const buildHarnessVersionCommand = (entry: AdminProfileEntry): CommandSpec =>
  entry.surface === "sandbox"
    ? { executable: entry.commandPath, args: ["harness-version", entry.name] }
    : { executable: entry.commandPath, args: ["harness-version"] }

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

/**
 * The distinct cache/scheduler key for a profile entry's harness-version
 * check: for native, the shared launcher alias (every profile sharing one
 * launcher shares the exact same one harness binary); for a sandbox entry
 * (via the CLI's `harness-version PROFILE` subcommand backed by the
 * profile's local lock/resolution-receipt, with a GitHub Releases lookup
 * for `latest` currently limited to the `claude` harness kind — see
 * `packages/trellage-cli/src/harness-version-report.ts`), a per-profile
 * `sandbox:PROFILE_NAME` key, since each locked sandbox image can float to
 * a different resolved harness version independently of any other. Any
 * entry with `harnessVersionSupported === false` (or a native entry
 * lacking a `launcher`) yields `undefined` — callers must check
 * `entry.harnessVersionSupported` first.
 */
export const harnessVersionLauncherFor = (entry: AdminProfileEntry): string | undefined => {
  if (entry.surface === "native") return entry.launcher
  return entry.harnessVersionSupported ? `sandbox:${entry.name}` : undefined
}
