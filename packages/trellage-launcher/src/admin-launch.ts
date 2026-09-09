/**
 * Confirmed terminal-launch action for the Admin panel. Delegates entirely
 * to the existing launch-building (`buildGuideLaunchCommand`) and terminal
 * handoff (`runInteractiveCommand`, `spawn(...,{stdio:"inherit"})`)
 * functions in `guide-launch.ts` — no new process-spawning code is
 * introduced here. The action only runs after explicit confirmation; it
 * never launches as a side effect of selection/navigation.
 */
import type { AdminProfileEntry } from "./admin-model.js"
import type { AdminRunManager, AdminRunState } from "./admin-run-manager.js"
import {
  buildGuideLaunchCommand,
  runInteractiveCommand,
  type CommandSpec,
  type SelectedProfile,
} from "./guide-launch.js"

export const toSelectedProfile = (entry: AdminProfileEntry): SelectedProfile =>
  entry.surface === "native"
    ? {
        surface: "native",
        launcher: entry.launcher ?? "",
        commandPath: entry.commandPath,
        profile: entry.name,
        headlessPrompt: false,
      }
    : {
        surface: "sandbox",
        commandPath: entry.commandPath,
        profile: entry.name,
        headlessPrompt: false,
      }

/** Builds the exact command the existing single-profile picker would build for an equivalent profile — no new logic. */
export const buildAdminLaunchCommand = (entry: AdminProfileEntry): CommandSpec =>
  buildGuideLaunchCommand(toSelectedProfile(entry)).command

/**
 * Builds the capability-appropriate diagnostic command for a profile,
 * mirroring the exact argument shapes `guide-preflight.ts` already uses:
 * native launchers accept `doctor PROFILE` (C12), sandbox profiles accept
 * `validate PROFILE` (`guide-preflight.ts:118`). Callers must check
 * `entry.doctorSupported` first — this never fabricates a command for a
 * native launcher that genuinely lacks doctor support (see
 * `admin-model.ts`'s `launchersWithoutDoctorSupport`; every current native
 * launcher, including `cdx`, supports it).
 */
export const buildDiagnosticCommand = (entry: AdminProfileEntry): CommandSpec => ({
  executable: entry.commandPath,
  args: entry.surface === "native" ? ["doctor", entry.name] : ["validate", entry.name],
})

/**
 * True only for native profiles whose launcher already exposes a doctor
 * check (`entry.doctorSupported`) — every native launcher that supports
 * `doctor PROFILE` also supports the identically-shaped `repair PROFILE`
 * and `setup PROFILE` subcommands (verified directly in each launcher's
 * `bin/*` source: cpx, cldx, grx, jcx, omp, picx, prx, and cdx via
 * `native-codex`). Sandbox profiles have no equivalent repair/setup
 * subcommand — a failing sandbox profile is fixed by rebuilding its locked
 * image, not by an in-place repair, so this is always `false` for
 * `entry.surface === "sandbox"`. This same gate is used before offering the
 * manual `[p]` action and before the automatic repair-then-setup escalation
 * in `repairThenRecheckDoctor`.
 */
export const isRepairSupported = (entry: AdminProfileEntry): boolean => entry.surface === "native" && entry.doctorSupported

/**
 * Builds the `repair PROFILE` command for a native profile, using the exact
 * same argument shape as `buildDiagnosticCommand`'s `doctor PROFILE` branch.
 * Callers must check `isRepairSupported(entry)` first — this never
 * fabricates a command for a sandbox profile or an unsupported launcher.
 */
export const buildRepairCommand = (entry: AdminProfileEntry): CommandSpec => ({
  executable: entry.commandPath,
  args: ["repair", entry.name],
})

/**
 * Builds the `setup PROFILE` command for a native profile, using the exact
 * same argument shape as `buildRepairCommand`. `setup` performs the same
 * install/repair steps as `repair` plus first-time state creation (e.g. an
 * `omp` profile whose installed-version receipt is missing entirely —
 * `omp repair` refuses to fabricate one and tells the operator to run
 * `omp setup PROFILE` instead, while `omp setup` resolves and installs a
 * version from scratch when no prior receipt exists). Callers must check
 * `isRepairSupported(entry)` first, the same gate `buildRepairCommand` uses.
 */
export const buildSetupCommand = (entry: AdminProfileEntry): CommandSpec => ({
  executable: entry.commandPath,
  args: ["setup", entry.name],
})

/**
 * `repair`/`setup` can perform real installs (e.g. `mise install`, `npm ci`,
 * downloading a pinned release) that legitimately take much longer than a
 * read-only `doctor` check. The shared `AdminRunManager`'s default timeout
 * (30s, sized for fast diagnostic checks) is too short for these and was
 * observed truncating a real `prx setup` mid-install ("setup timed out").
 * This override only widens the budget for `repair`/`setup`; `doctor`
 * rechecks keep the manager's own default.
 */
const repairOrSetupTimeoutMs = 180_000

/** The distinct `AdminRunManager` ref used to track a profile's repair runs, kept separate from its own doctor history. */
export const repairRefFor = (entry: AdminProfileEntry): string => `${entry.ref}::repair`

/** The distinct `AdminRunManager` ref used to track a profile's setup runs, kept separate from its own doctor and repair history. */
export const setupRefFor = (entry: AdminProfileEntry): string => `${entry.ref}::setup`

export interface RepairAndRecheckOutcome {
  readonly repairState: AdminRunState
  /** Present only when `repair` didn't resolve the failure and `setup` was attempted as a second automatic recovery step. */
  readonly setupState?: AdminRunState
  readonly doctorState: AdminRunState
}

/**
 * Runs the profile's existing `repair PROFILE` subcommand exactly once (the
 * same real, documented action `omp repair`/`cldx repair`/etc. already
 * expose), tracked under `repairRefFor(entry)` so it never overwrites the
 * profile's own doctor history, then re-triggers the doctor check to
 * recheck. If that recheck is still not a `success` (e.g. `omp`'s "OMP
 * installed version receipt is missing; run omp setup PROFILE" case, which
 * `repair` alone cannot fix because it refuses to fabricate a missing
 * receipt), automatically runs the profile's `setup PROFILE` subcommand
 * once as well — tracked under its own distinct `setupRefFor(entry)` ref —
 * and rechecks doctor again. Never parses or executes any Copilot-suggested
 * fix text; this always runs the same two fixed, safe, already-documented
 * commands the profile's own launcher already exposes. Shared by the
 * manual `[p]` action and the on-load auto-repair dispatch so both paths
 * behave identically.
 */
export const repairThenRecheckDoctor = async (
  entry: AdminProfileEntry,
  runManager: AdminRunManager,
): Promise<RepairAndRecheckOutcome> => {
  const repairCommand = buildRepairCommand(entry)
  await runManager.trigger(repairRefFor(entry), repairCommand.executable, repairCommand.args, {
    timeoutMs: repairOrSetupTimeoutMs,
  })
  const repairState = runManager.status(repairRefFor(entry)).state
  const doctorCommand = buildDiagnosticCommand(entry)
  await runManager.retry(entry.ref, doctorCommand.executable, doctorCommand.args)
  const doctorStateAfterRepair = runManager.status(entry.ref).state
  if (doctorStateAfterRepair === "success") return { repairState, doctorState: doctorStateAfterRepair }

  const setupCommand = buildSetupCommand(entry)
  await runManager.trigger(setupRefFor(entry), setupCommand.executable, setupCommand.args, {
    timeoutMs: repairOrSetupTimeoutMs,
  })
  const setupState = runManager.status(setupRefFor(entry)).state
  await runManager.retry(entry.ref, doctorCommand.executable, doctorCommand.args)
  const doctorState = runManager.status(entry.ref).state
  return { repairState, setupState, doctorState }
}

export class LaunchNotConfirmedError extends Error {
  constructor(profile: string) {
    super(`terminal launch for ${profile} requires explicit confirmation`)
    this.name = "LaunchNotConfirmedError"
  }
}

/**
 * Hands the current terminal to the selected profile, but only when
 * `confirmed` is `true`. Never launches implicitly from selection alone.
 */
export const launchAdminProfile = async (
  entry: AdminProfileEntry,
  confirmed: boolean,
  run: (command: CommandSpec) => Promise<void> = runInteractiveCommand,
): Promise<void> => {
  if (!confirmed) throw new LaunchNotConfirmedError(entry.name)
  await run(buildAdminLaunchCommand(entry))
}
