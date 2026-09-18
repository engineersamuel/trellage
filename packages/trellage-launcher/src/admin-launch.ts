/**
 * Confirmed Admin controls. Firstmate uses the shared instance selectors
 * and context. Other profiles use the existing guide launch builder.
 * Terminal handoff still uses runInteractiveCommand; selection never launches.
 */
import { firstmateInstanceCli } from "@trellage/guide-core"
import { adminProfileLabel, isAdminFirstmate, type AdminProfileEntry } from "./admin-model.ts"
import {
  adminFirstmatePreparationBlockReason,
  adminFirstmatePreparationDiagnostic,
  adminInstanceControlArgs,
  adminInstanceSelectorArgs,
  adminNativeSelectedProfile,
} from "./admin-firstmate.ts"
import type { AdminRunManager, AdminRunState } from "./admin-run-manager.ts"
import {
  buildGuideLaunchCommand,
  runInteractiveCommand,
  type CommandSpec,
  type SelectedProfile,
} from "./guide-launch.ts"

export const toSelectedProfile = (entry: AdminProfileEntry): SelectedProfile =>
  entry.surface === "native"
    ? adminNativeSelectedProfile(entry)
    : {
        surface: "sandbox",
        commandPath: entry.commandPath,
        profile: entry.name,
        headlessPrompt: false,
      }

/** Firstmate control uses the confirmed instance context; other launchers retain the picker command. */
export const buildAdminLaunchCommand = (entry: AdminProfileEntry): CommandSpec =>
  isAdminFirstmate(entry)
    ? { executable: entry.commandPath, args: [entry.name, ...adminInstanceControlArgs(entry)] }
    : buildGuideLaunchCommand(toSelectedProfile(entry)).command

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
  args: entry.surface === "native" ? ["doctor", entry.name, ...adminInstanceSelectorArgs(entry)] : ["validate", entry.name],
})

/**
 * Firstmate requires safe preparation and a published fleet identity.
 * Ordinary Native repair support follows doctor support. Containers have
 * no in-place repair command.
 */
export const isRepairSupported = (entry: AdminProfileEntry): boolean =>
  entry.surface === "native" && entry.doctorSupported &&
  (!isAdminFirstmate(entry) || adminFirstmatePreparationBlockReason(entry) === undefined)

export const isAutoRepairSupported = (entry: AdminProfileEntry): boolean =>
  !isAdminFirstmate(entry) && isRepairSupported(entry)

/**
 * Firstmate preparation has no package-install approval or setup fallback.
 * Other Native profiles retain repair PROFILE.
 */
export const buildRepairCommand = (entry: AdminProfileEntry): CommandSpec => {
  if (isAdminFirstmate(entry)) {
    const reason = adminFirstmatePreparationBlockReason(entry)
    if (reason !== undefined) throw new Error(reason)
    return {
      executable: entry.commandPath,
      args: [
        "prepare", entry.name, ...adminInstanceControlArgs(entry), "--json",
        firstmateInstanceCli.expectedSourceRevision, entry.orchestration!.sourceRevision,
      ],
    }
  }
  return { executable: entry.commandPath, args: ["repair", entry.name] }
}

/**
 * Only ordinary Native profiles can use setup. Firstmate creation is a
 * separate approved operation and is never an Admin recovery fallback.
 */
export const buildSetupCommand = (entry: AdminProfileEntry): CommandSpec => {
  if (isAdminFirstmate(entry)) throw new Error("Admin does not create Firstmate fleets or escalate preparation to setup.")
  return { executable: entry.commandPath, args: ["setup", entry.name] }
}

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
 * Keeps preparation/repair separate from doctor history. Firstmate returns
 * after one prepare and one doctor, even on refusal or invalid output.
 * Other Native profiles keep their existing repair → doctor → setup fallback.
 * Only the confirmed manual action may call this for Firstmate.
 */
export const repairThenRecheckDoctor = async (
  entry: AdminProfileEntry,
  runManager: AdminRunManager,
): Promise<RepairAndRecheckOutcome> => {
  const repairCommand = buildRepairCommand(entry)
  await runManager.trigger(repairRefFor(entry), repairCommand.executable, repairCommand.args, {
    timeoutMs: isAdminFirstmate(entry) ? 300_000 : repairOrSetupTimeoutMs,
    ...(isAdminFirstmate(entry) ? {
      terminationGraceMs: 10_000,
      outputOverflow: "terminate" as const,
      validateOutput: (stdout: string) => adminFirstmatePreparationDiagnostic(entry, stdout),
    } : {}),
  })
  const repairState = runManager.status(repairRefFor(entry)).state
  const doctorCommand = buildDiagnosticCommand(entry)
  await runManager.retry(entry.ref, doctorCommand.executable, doctorCommand.args)
  const doctorStateAfterRepair = runManager.status(entry.ref).state
  if (doctorStateAfterRepair === "success" || isAdminFirstmate(entry)) return { repairState, doctorState: doctorStateAfterRepair }

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
  if (!confirmed) throw new LaunchNotConfirmedError(adminProfileLabel(entry))
  await run(buildAdminLaunchCommand(entry))
}
