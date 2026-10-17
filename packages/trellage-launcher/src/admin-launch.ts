/**
 * Confirmed Admin controls. Profiles use the existing guide launch builder.
 * Terminal handoff still uses runInteractiveCommand; selection never launches.
 */
import type { AdminProfileEntry } from "./admin-model.ts"
import type { AdminRunManager, AdminRunState } from "./admin-run-manager.ts"
import {
  buildGuideLaunchCommand,
  runInteractiveCommand,
  type CommandSpec,
  type SelectedProfile,
} from "./guide-launch.ts"

export const toSelectedProfile = (entry: AdminProfileEntry): SelectedProfile =>
  ({
    surface: "native",
    launcher: entry.launcher ?? "",
    commandPath: entry.commandPath,
    profile: entry.name,
    headlessPrompt: false,
  })

export const buildAdminLaunchCommand = (entry: AdminProfileEntry): CommandSpec =>
  buildGuideLaunchCommand(toSelectedProfile(entry)).command

/** Native launchers accept `doctor PROFILE`. Callers must check `entry.doctorSupported` first. */
export const buildDiagnosticCommand = (entry: AdminProfileEntry): CommandSpec => ({
  executable: entry.commandPath,
  args: ["doctor", entry.launcher!, entry.name],
})

/** Native repair support follows doctor support. */
export const isRepairSupported = (entry: AdminProfileEntry): boolean => entry.doctorSupported

export const buildRepairCommand = (entry: AdminProfileEntry): CommandSpec =>
  ({ executable: entry.commandPath, args: ["repair", entry.launcher!, entry.name] })

export const buildSetupCommand = (entry: AdminProfileEntry): CommandSpec =>
  ({ executable: entry.commandPath, args: ["setup", entry.launcher!, entry.name] })

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

/** Keeps repair separate from doctor history: repair → doctor → setup fallback. */
export const repairThenRecheckDoctor = async (
  entry: AdminProfileEntry,
  runManager: AdminRunManager,
  refreshVersions?: () => Promise<void>,
): Promise<RepairAndRecheckOutcome> => {
  const repairCommand = buildRepairCommand(entry)
  await runManager.trigger(repairRefFor(entry), repairCommand.executable, repairCommand.args, {
    timeoutMs: repairOrSetupTimeoutMs,
  })
  const repairState = runManager.status(repairRefFor(entry)).state
  const doctorCommand = buildDiagnosticCommand(entry)
  await runManager.retry(entry.ref, doctorCommand.executable, doctorCommand.args)
  const doctorStateAfterRepair = runManager.status(entry.ref).state
  if (doctorStateAfterRepair === "success") {
    await refreshVersions?.()
    return { repairState, doctorState: doctorStateAfterRepair }
  }

  const setupCommand = buildSetupCommand(entry)
  await runManager.trigger(setupRefFor(entry), setupCommand.executable, setupCommand.args, {
    timeoutMs: repairOrSetupTimeoutMs,
  })
  const setupState = runManager.status(setupRefFor(entry)).state
  await runManager.retry(entry.ref, doctorCommand.executable, doctorCommand.args)
  const doctorState = runManager.status(entry.ref).state
  await refreshVersions?.()
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
