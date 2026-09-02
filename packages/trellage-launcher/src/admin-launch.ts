/**
 * Confirmed terminal-launch action for the Admin panel. Delegates entirely
 * to the existing launch-building (`buildGuideLaunchCommand`) and terminal
 * handoff (`runInteractiveCommand`, `spawn(...,{stdio:"inherit"})`)
 * functions in `guide-launch.ts` — no new process-spawning code is
 * introduced here. The action only runs after explicit confirmation; it
 * never launches as a side effect of selection/navigation.
 */
import type { AdminProfileEntry } from "./admin-model.js"
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
 * `entry.doctorSupported` first — this never fabricates a command for an
 * unsupported launcher (e.g. `cdx`).
 */
export const buildDiagnosticCommand = (entry: AdminProfileEntry): CommandSpec => ({
  executable: entry.commandPath,
  args: entry.surface === "native" ? ["doctor", entry.name] : ["validate", entry.name],
})

/**
 * True only for native profiles whose launcher already exposes a doctor
 * check (`entry.doctorSupported`) — every native launcher that supports
 * `doctor PROFILE` also supports the identically-shaped `repair PROFILE`
 * subcommand (verified directly in each launcher's `bin/*` source: cpx,
 * cldx, grx, jcx, omp, picx, prx, and cdx via `native-codex`). Sandbox
 * profiles have no equivalent repair subcommand — a failing sandbox
 * profile is fixed by rebuilding its locked image, not by an in-place
 * repair, so this is always `false` for `entry.surface === "sandbox"`.
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
