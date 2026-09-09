import type { AdminProfileEntry } from "./admin-model.js"
import type { AdminRunManager } from "./admin-run-manager.js"
import type { AdminHarnessVersionCacheRecord } from "./admin-harness-version-cache.js"
import type { AdminHarnessVersionResult } from "./admin-harness-version.js"
import type { HarnessVersionSchedulerOptions } from "./admin-harness-version-scheduler.js"
import { nativeSkillsUpdatePlanFor, type NativeSkillsUpdateOutcome, type NativeSkillsUpdatePlan } from "./admin-skills-update.js"
import {
  harnessUpdatePlanFor,
  harnessUpdateRefreshTargets,
  refreshHarnessUpdateVersions,
  type HarnessUpdateGroupReport,
  type HarnessUpdateManager,
  type HarnessUpdatePlan,
  type HarnessUpdateQueueOptions,
} from "./admin-harness-update.js"

export interface UnsupportedHarnessUpdate {
  readonly entry: AdminProfileEntry
  readonly diagnostic: string
}

export interface HarnessUpdateAllPlan {
  readonly skills: NativeSkillsUpdatePlan | undefined
  readonly groups: ReadonlyArray<HarnessUpdatePlan>
  readonly unsupported: ReadonlyArray<UnsupportedHarnessUpdate>
  readonly profileCount: number
  readonly nativeUpdateCount: number
  readonly containerUpdateCount: number
}

export interface HarnessUpdateAllOutcome {
  readonly skills: NativeSkillsUpdateOutcome | undefined
  readonly plan: HarnessUpdateAllPlan
  readonly reports: ReadonlyArray<HarnessUpdateGroupReport>
  readonly cancelled: boolean
}

export interface HarnessUpdateAllSummary {
  readonly updated: number
  readonly failed: number
  readonly unsupported: number
  readonly refreshFailed: number
  readonly notRun: number
  readonly success: boolean
  readonly nativeSkillsUpdated: number
  readonly nativeSkillsFailed: number
  readonly nativeSkillsNotRun: number
  readonly skillsCacheFailed: boolean
}

export const harnessUpdateScopeKey = (plan: HarnessUpdatePlan): string =>
  JSON.stringify([plan.key, plan.steps.map((step) => step.command.executable)])

const unsupportedReason = (entry: AdminProfileEntry): string => {
  if (entry.commandPath.length === 0) return "The launcher command is unavailable."
  if (entry.harness === undefined) return "The harness identity is missing."
  const identity = entry.surface === "native" ? (entry.launcher ?? "unknown launcher") : entry.harness
  return `No harness update command is supported for ${identity}.`
}

export const harnessUpdateAllPlanFor = (
  entries: ReadonlyArray<AdminProfileEntry>,
  versionResultFor: (entry: AdminProfileEntry) => AdminHarnessVersionResult | undefined = () => undefined,
  routerCommandPath = "trx",
): HarnessUpdateAllPlan => {
  const profiles = [...new Map(entries.map((entry) => [entry.ref, entry])).values()].sort((left, right) =>
    left.ref.localeCompare(right.ref),
  )
  const plans = new Map<string, HarnessUpdatePlan>()
  const unsupported: Array<UnsupportedHarnessUpdate> = []
  for (const entry of profiles) {
    const plan = harnessUpdatePlanFor(entry, profiles, versionResultFor(entry))
    if (plan === undefined) {
      unsupported.push({ entry, diagnostic: unsupportedReason(entry) })
    } else {
      const key = harnessUpdateScopeKey(plan)
      if (!plans.has(key)) plans.set(key, plan)
    }
  }
  const groups = [...plans.values()]
  return {
    skills: nativeSkillsUpdatePlanFor(profiles, routerCommandPath),
    groups,
    unsupported,
    profileCount: profiles.length,
    nativeUpdateCount: groups.filter((group) => group.surface === "native").reduce((count, group) => count + group.steps.length, 0),
    containerUpdateCount: groups.filter((group) => group.surface === "sandbox").reduce((count, group) => count + group.steps.length, 0),
  }
}

export const runAllHarnessUpdates = async (
  plan: HarnessUpdateAllPlan,
  manager: HarnessUpdateManager,
  options: Omit<HarnessUpdateQueueOptions, "skills">,
): Promise<HarnessUpdateAllOutcome> => {
  if (plan.profileCount === 0 && plan.skills === undefined) throw new Error("No updates were selected.")
  const { reports, skills } = await manager.runAll(plan.groups, {
    ...options,
    ...(plan.skills === undefined ? {} : { skills: plan.skills }),
  })
  return { plan, reports, skills, cancelled: options.signal?.aborted === true }
}

const nativeSkillsSummary = (outcome: HarnessUpdateAllOutcome) => {
  const results = outcome.skills?.results ?? []
  return {
    nativeSkillsUpdated: results.filter((result) => result.state === "success").length,
    nativeSkillsFailed: results.filter((result) => result.state === "failure").length,
    nativeSkillsNotRun: (outcome.plan.skills?.targets.length ?? 0) - results.length,
    skillsCacheFailed: outcome.skills?.cache.state === "failure",
  }
}

export const harnessUpdateAllSummary = (outcome: HarnessUpdateAllOutcome): HarnessUpdateAllSummary => {
  const results = outcome.reports.flatMap((report) => report.outcome.results)
  const updated = results.filter((result) => result.state === "success").length
  const failed = results.filter((result) => result.state === "failure").length
  const unsupported = outcome.plan.unsupported.length
  const refreshFailed = outcome.reports.filter((report) => report.refreshError !== undefined).length
  const notRun = outcome.plan.profileCount - results.length - unsupported
  const skills = nativeSkillsSummary(outcome)
  const skillsComplete = !skills.skillsCacheFailed && skills.nativeSkillsFailed === 0 && skills.nativeSkillsNotRun === 0
  return {
    updated,
    failed,
    unsupported,
    refreshFailed,
    notRun,
    ...skills,
    success:
      (outcome.plan.profileCount > 0 || outcome.plan.skills !== undefined) &&
      !outcome.cancelled &&
      failed === 0 &&
      unsupported === 0 &&
      refreshFailed === 0 &&
      notRun === 0 &&
      skillsComplete,
  }
}

export const refreshHarnessUpdateGroupVersions = async (
  plan: HarnessUpdatePlan,
  runManager: AdminRunManager,
  cache: AdminHarnessVersionCacheRecord,
  onResult: NonNullable<HarnessVersionSchedulerOptions["onResult"]>,
): Promise<void> => {
  if (harnessUpdateRefreshTargets(plan).length === 0) throw new Error(`Installed-version refresh is not supported for ${plan.key}.`)
  const failures: Array<string> = []
  await refreshHarnessUpdateVersions(plan, runManager, cache, (key, entry, source) => {
    onResult(key, entry, source)
    if (entry.result.installed.kind === "unavailable") failures.push(`${source.ref}: ${entry.result.installed.diagnostic}`)
  })
  if (failures.length > 0) throw new Error(`Installed-version refresh failed: ${failures.join("; ")}`)
}
