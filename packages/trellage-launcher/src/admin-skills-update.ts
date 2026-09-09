import { isKnownNativeLauncher, type AdminProfileEntry } from "./admin-model.js"
import type { CommandRunner, CommandSpec } from "./guide-launch.js"
import { runProfileUpdateStep, runUpdateCommand, type ProfileUpdateResult, type UpdateCommandResult } from "./admin-update-command.js"

export interface NativeSkillsUpdatePlan {
  readonly refresh: CommandSpec
  readonly targets: ReadonlyArray<AdminProfileEntry>
}

export interface NativeSkillsUpdateOutcome {
  readonly cache: UpdateCommandResult
  readonly results: ReadonlyArray<ProfileUpdateResult>
}

export type NativeSkillsUpdateEvent =
  | { readonly kind: "cache-started" }
  | { readonly kind: "cache-completed"; readonly result: UpdateCommandResult }
  | { readonly kind: "profile-started"; readonly entry: AdminProfileEntry }
  | { readonly kind: "profile-completed"; readonly result: ProfileUpdateResult }

export const nativeSkillsUpdatePlanFor = (
  entries: ReadonlyArray<AdminProfileEntry>,
  routerCommandPath: string,
): NativeSkillsUpdatePlan | undefined => {
  const targets = entries.filter((entry) => entry.surface === "native")
  return targets.length === 0 ? undefined : { refresh: { executable: routerCommandPath, args: ["skills", "update"] }, targets }
}

export const nativeSkillsUpdateCommand = (entry: AdminProfileEntry): CommandSpec | undefined => {
  if (entry.launcher === undefined || !isKnownNativeLauncher(entry.launcher) || entry.commandPath.length === 0) return undefined
  return { executable: entry.commandPath, args: ["skills-update", entry.name] }
}

export const runNativeSkillsUpdate = async (
  plan: NativeSkillsUpdatePlan,
  runner: CommandRunner,
  cwd: string,
  options: { readonly signal?: AbortSignal; readonly onProgress?: (event: NativeSkillsUpdateEvent) => void },
): Promise<NativeSkillsUpdateOutcome> => {
  options.onProgress?.({ kind: "cache-started" })
  const cache = await runUpdateCommand(plan.refresh, runner, cwd, options.signal)
  options.onProgress?.({ kind: "cache-completed", result: cache })
  const results: Array<ProfileUpdateResult> = []
  if (cache.state === "failure") return { cache, results }
  for (const entry of plan.targets) {
    if (options.signal?.aborted === true) break
    options.onProgress?.({ kind: "profile-started", entry })
    const command = nativeSkillsUpdateCommand(entry)
    const applied: ReadonlyArray<ProfileUpdateResult> =
      command === undefined
        ? [{ ref: entry.ref, name: entry.name, state: "failure", diagnostic: `Skills update is not supported for ${entry.ref}.` }]
        : await runProfileUpdateStep({ command, targets: [entry] }, runner, cwd, options.signal)
    for (const result of applied) {
      results.push(result)
      options.onProgress?.({ kind: "profile-completed", result })
    }
  }
  return { cache, results }
}
